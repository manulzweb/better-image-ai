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
    process.env.STORAGE_DIR = join(workDir, 'processed');
    process.env.DB_PATH = join(workDir, 'better-image.db');
    process.env.RATE_LIMIT_PER_MINUTE = '1000';

    // Import dinámico: ConfigModule valida process.env en tiempo de importación.
    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(helmet());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
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
      expect(res.headers['cache-control']).toContain('immutable');
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
