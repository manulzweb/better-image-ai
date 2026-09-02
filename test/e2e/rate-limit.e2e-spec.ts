import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import helmet from 'helmet';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as request from 'supertest';

describe('Rate limit (e2e)', () => {
  let app: INestApplication;
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bia-e2e-rl-'));
    process.env.GEMINI_API_KEY = 'e2e-gemini-key';
    process.env.API_KEYS = 'e2e-valid-key';
    process.env.STORAGE_DIR = join(workDir, 'processed');
    process.env.DB_PATH = join(workDir, 'better-image.db');
    process.env.RATE_LIMIT_PER_MINUTE = '2';

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

  it('devuelve 429 al superar el límite por minuto (en rutas throttled)', async () => {
    const server = app.getHttpServer();
    const url = `/v1/images/${'0'.repeat(64)}`;
    await request(server).get(url).set('X-API-Key', 'e2e-valid-key').expect(404);
    await request(server).get(url).set('X-API-Key', 'e2e-valid-key').expect(404);

    await request(server)
      .get(url)
      .set('X-API-Key', 'e2e-valid-key')
      .expect(429)
      .expect((res) => {
        expect(res.body.code).toBeDefined();
      });
  });

  it('GET /health está exento del rate limit (probes de Docker/k8s)', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 5; i++) {
      await request(server).get('/health').expect(200);
    }
  });
});
