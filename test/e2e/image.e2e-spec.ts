import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import helmet from 'helmet';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as request from 'supertest';

// Gemini mockeado: devuelve un PNG 1x1 válido sin tocar la API real.
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                  },
                },
              ],
            },
          },
        ],
      }),
    },
  })),
}));

const PNG_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const API_KEY = 'e2e-valid-key';

describe('Image API (e2e)', () => {
  let app: INestApplication;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bia-e2e-'));
    process.env.GEMINI_API_KEY = 'e2e-gemini-key';
    process.env.API_KEYS = API_KEY;
    process.env.CLIENTS_JSON = JSON.stringify([
      {
        id: 'shop-a',
        keyHashes: [
          createHash('sha256').update('shop-a-key').digest('hex'),
          createHash('sha256').update('shop-a-rotated').digest('hex'),
        ],
        profiles: { white: 'White background', dark: 'Dark background' },
      },
      {
        id: 'shop-b',
        keyHashes: [createHash('sha256').update('shop-b-key').digest('hex')],
        profiles: { white: 'White background' },
      },
    ]);
    process.env.STORAGE_DIR = join(workDir, 'processed');
    process.env.DB_PATH = join(workDir, 'better-image.db');
    process.env.RATE_LIMIT_PER_MINUTE = '1000';

    // Import dinámico: ConfigModule valida process.env en tiempo de importación.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(helmet());
    await app.init();
    const { SqliteCommerceRepository } =
      await import('../../src/infrastructure/persistence/sqlite-commerce.repository');
    const credits = app.get(SqliteCommerceRepository);
    for (const tenant of ['legacy', 'shop-a', 'shop-b'])
      await credits.grant(tenant, 100, `test:${tenant}`);
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  const upload = (key: string, profile = 'white') =>
    request(app.getHttpServer())
      .post('/v1/images/optimize')
      .set('X-API-Key', key)
      .field('profile', profile)
      .attach('file', PNG_FIXTURE, 'product.png');

  it('isolates tenants, profiles, and preserves ownership after key rotation', async () => {
    const a = await upload('shop-a-key').expect(201);
    const rotated = await upload('shop-a-rotated').expect(201);
    expect(rotated.body.hash).toBe(a.body.hash);
    expect(rotated.body.cached).toBe(true);
    const b = await upload('shop-b-key').expect(201);
    const dark = await upload('shop-a-key', 'dark').expect(201);
    expect(b.body.hash).not.toBe(a.body.hash);
    expect(dark.body.hash).not.toBe(a.body.hash);
    await request(app.getHttpServer()).get(a.body.url).set('X-API-Key', 'shop-b-key').expect(404);
    await request(app.getHttpServer())
      .get(a.body.url)
      .set('X-API-Key', 'shop-a-rotated')
      .expect(200);
    await upload('shop-a-key', 'unknown').expect(400);
    await upload('shop-a-key', '__proto__').expect(400);
  });

  it('processes a bounded batch and deduplicates repeated files', async () => {
    const result = await request(app.getHttpServer())
      .post('/v1/images/batch')
      .set('X-API-Key', 'shop-a-key')
      .field('profile', 'white')
      .attach('files', PNG_FIXTURE, 'one.png')
      .attach('files', PNG_FIXTURE, 'two.png')
      .expect(201);
    expect(result.body.results).toHaveLength(2);
    expect(result.body.results[1]).toMatchObject({ index: 1, status: 'succeeded', cached: true });
    expect(result.body.results[0].hash).toBe(result.body.results[1].hash);
  });

  it('validates the entire batch before provider work and bounds file count', async () => {
    await request(app.getHttpServer())
      .post('/v1/images/batch')
      .set('X-API-Key', 'shop-a-key')
      .attach('files', PNG_FIXTURE, 'valid.png')
      .attach('files', Buffer.from('invalid'), 'invalid.png')
      .expect(400);
    const req = request(app.getHttpServer())
      .post('/v1/images/batch')
      .set('X-API-Key', 'shop-a-key');
    for (let i = 0; i < 6; i++) req.attach('files', PNG_FIXTURE, `${i}.png`);
    await req.expect(400);
  });

  describe('GET /health', () => {
    it('responde ok sin autenticación y con checks profundos (DB + storage)', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.checks).toEqual({ storage: 'up', database: 'up' });
        });
    });

    it('devuelve X-Request-Id en la respuesta', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  describe('POST /v1/images/optimize', () => {
    it('procesa una imagen nueva (cached=false)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', PNG_FIXTURE, { filename: 'product.png', contentType: 'image/png' })
        .expect(201);

      expect(res.body).toMatchObject({
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        cached: false,
        strategy: 'gemini',
      });
      expect(res.body.url).toBe(`/v1/images/${res.body.hash}`);
    });

    it('la segunda petición con la misma imagen devuelve cache (cached=true)', async () => {
      const first = await request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', PNG_FIXTURE, 'product.png')
        .expect(201);

      const second = await request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', PNG_FIXTURE, 'product.png')
        .expect(201);

      expect(second.body.hash).toBe(first.body.hash);
      expect(second.body.cached).toBe(true);
    });

    it('rechaza la petición sin API key (401)', () => {
      return request(app.getHttpServer())
        .post('/v1/images/optimize')
        .attach('file', PNG_FIXTURE, 'product.png')
        .expect(401)
        .expect((res) => {
          expect(res.body.code).toBeDefined();
        });
    });

    it('rechaza MIME no soportado (400)', () => {
      return request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', Buffer.from('plain text'), { filename: 'a.txt', contentType: 'text/plain' })
        .expect(400)
        .expect((res) => {
          expect(res.body.code).toBe('UNSUPPORTED_MIME_TYPE');
        });
    });

    it('rechaza un binario falso aunque el Content-Type diga image/png (magic bytes)', () => {
      return request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', Buffer.from('not a real png'), {
          filename: 'fake.png',
          contentType: 'image/png',
        })
        .expect(400)
        .expect((res) => {
          expect(res.body.code).toBe('UNSUPPORTED_MIME_TYPE');
        });
    });

    it('rechaza la petición sin archivo (400)', () => {
      return request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .expect(400);
    });
  });

  describe('GET /v1/images/:hash', () => {
    it('sirve la imagen procesada con su content-type', async () => {
      const optimized = await request(app.getHttpServer())
        .post('/v1/images/optimize')
        .set('X-API-Key', API_KEY)
        .attach('file', PNG_FIXTURE, 'product.png');

      const res = await request(app.getHttpServer())
        .get(optimized.body.url)
        .set('X-API-Key', API_KEY)
        .expect(200);

      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('devuelve 404 para hash con formato inválido', () => {
      return request(app.getHttpServer())
        .get('/v1/images/not-a-hash')
        .set('X-API-Key', API_KEY)
        .expect(404)
        .expect((res) => {
          expect(res.body.code).toBe('IMAGE_NOT_FOUND');
        });
    });

    it('devuelve 404 para hash bien formado inexistente', () => {
      return request(app.getHttpServer())
        .get(`/v1/images/${'0'.repeat(64)}`)
        .set('X-API-Key', API_KEY)
        .expect(404);
    });
  });
});
