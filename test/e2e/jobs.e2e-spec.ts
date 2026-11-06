import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as request from 'supertest';
import { SqliteCommerceRepository } from '../../src/infrastructure/persistence/sqlite-commerce.repository';
import { JobWorker } from '../../src/infrastructure/jobs/job-worker.service';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn().mockImplementation(async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: PNG.toString('base64') } }] } }],
      })),
    },
  })),
}));
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

describe('Jobs, credits and Mercado Pago (HTTP)', () => {
  let app: INestApplication;
  let dir: string;
  let boot: () => Promise<void>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jobs-http-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'mock',
      API_KEYS: '',
      CLIENTS_JSON: JSON.stringify([
        { id: 'shop', keyHashes: [hash('shop-key')], profiles: {} },
        { id: 'other', keyHashes: [hash('other-key')], profiles: {} },
      ]),
      ADMIN_API_KEY_HASH: hash('admin-key'),
      STORAGE_DIR: join(dir, 'processed'),
      DB_PATH: join(dir, 'db'),
      RATE_LIMIT_PER_MINUTE: '1000',
      MP_ACCESS_TOKEN: 'test',
      MP_WEBHOOK_SECRET: 'webhook-test-secret',
      MP_COLLECTOR_ID: '55',
      MP_LIVE_MODE: 'false',
      MP_CURRENCY: 'COP',
      CREDIT_PACK_SIZE: '100',
      CREDIT_PACK_PRICE: '50000',
      PUBLIC_BASE_URL: 'https://api.example.com',
    });
    const { AppModule } = await import('../../src/app.module');
    boot = async () => {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      await app.init();
    };
    await boot();
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const api = () => app.getHttpServer();
  const create = (key: string, count: number) =>
    request(api())
      .post('/v1/jobs')
      .set('X-API-Key', 'shop-key')
      .set('Idempotency-Key', key)
      .send({ count });
  const status = (id: string) => request(api()).get(`/v1/jobs/${id}`).set('X-API-Key', 'shop-key');
  async function waitJob(id: string) {
    for (let i = 0; i < 100; i++) {
      await app.get(JobWorker).tick();
      const res = await status(id).expect(200);
      if (res.body.status === 'completed') return res.body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Job did not finish');
  }
  it('rejects unfunded image generation and protects administrative grants', async () => {
    await create('unfunded-1', 1).expect(402);
    await request(api())
      .post('/v1/images/optimize')
      .set('X-API-Key', 'shop-key')
      .attach('file', PNG, 'a.png')
      .expect(402);
    await request(api())
      .post('/v1/admin/clients/shop/credits')
      .set('X-API-Key', 'shop-key')
      .set('Idempotency-Key', 'grant-001')
      .send({ amount: 150 })
      .expect(401);
    for (let i = 0; i < 2; i++)
      await request(api())
        .post('/v1/admin/clients/shop/credits')
        .set('X-Admin-Key', 'admin-key')
        .set('Idempotency-Key', 'grant-001')
        .send({ amount: 150 })
        .expect(201);
    const balance = await request(api())
      .get('/v1/credits')
      .set('X-API-Key', 'shop-key')
      .expect(200);
    expect(balance.body.available).toBe(150);
  });
  it('accepts 100 inputs in chunks, processes persistently and charges only one identical image', async () => {
    const created = await create('hundred-1', 100).expect(201);
    const id = created.body.id;
    expect((await create('hundred-1', 100).expect(201)).body.id).toBe(id);
    await request(api()).get(`/v1/jobs/${id}`).set('X-API-Key', 'other-key').expect(404);
    for (let i = 0; i < 20; i++) {
      const req = request(api())
        .post(`/v1/jobs/${id}/items`)
        .set('X-API-Key', 'shop-key')
        .set('Idempotency-Key', `chunk-${String(i).padStart(3, '0')}`);
      for (let j = 0; j < 5; j++) req.attach('files', PNG, `${i}-${j}.png`);
      await req.expect(201);
    }
    await request(api()).post(`/v1/jobs/${id}/submit`).set('X-API-Key', 'shop-key').expect(202);
    const done = await waitJob(id);
    expect(done).toMatchObject({ completed: 100, failed: 0, charged: 1 });
    const balance = await request(api())
      .get('/v1/credits')
      .set('X-API-Key', 'shop-key')
      .expect(200);
    expect(balance.body).toEqual({ available: 149, reserved: 0 });
    await request(api())
      .get(`/v1/images/${done.items[0].hash}`)
      .set('X-API-Key', 'shop-key')
      .expect(200);
  });
  it('recovers a claimed item after application restart', async () => {
    const created = await create('restart-1', 1).expect(201);
    const id = created.body.id;
    await request(api())
      .post(`/v1/jobs/${id}/items`)
      .set('X-API-Key', 'shop-key')
      .set('Idempotency-Key', 'chunk-001')
      .attach('files', PNG, 'one.png')
      .expect(201);
    const store = app.get(SqliteCommerceRepository);
    await store.submit('shop', id);
    await store.claim();
    await app.close();
    await boot();
    expect(await waitJob(id)).toMatchObject({ completed: 1, charged: 0 });
  });
  it('verifies real webhook signatures and applies fetched approved payments only once', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          init_point: 'https://www.mercadopago.com.co/checkout/1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.co/checkout/1',
        }),
      ),
    );
    const order = await request(api())
      .post('/v1/payments/checkout')
      .set('X-API-Key', 'other-key')
      .set('Idempotency-Key', 'checkout-001')
      .expect(201);
    expect(order.body.checkoutUrl).toContain('sandbox');
    await request(api())
      .get(`/v1/payments/${order.body.id}`)
      .set('X-API-Key', 'shop-key')
      .expect(404);
    const signature = createHmac('sha256', 'webhook-test-secret')
      .update('id:123;request-id:webhook-1;ts:1781009491;')
      .digest('hex');
    await request(api())
      .post('/v1/payments/webhook?data.id=123&type=payment')
      .send({ data: { id: '123' }, status: 'approved' })
      .expect(401);
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 123,
            external_reference: order.body.id,
            status: 'approved',
            transaction_amount: 50000,
            currency_id: 'COP',
            collector_id: 55,
            live_mode: false,
          }),
        ),
    );
    for (let i = 0; i < 2; i++)
      await request(api())
        .post('/v1/payments/webhook?data.id=123&type=payment')
        .set('X-Request-Id', 'webhook-1')
        .set('X-Signature', `ts=1781009491,v1=${signature}`)
        .send({ data: { id: 'evil' } })
        .expect(200);
    const balance = await request(api())
      .get('/v1/credits')
      .set('X-API-Key', 'other-key')
      .expect(200);
    expect(balance.body.available).toBe(100);
    fetchMock.mockRestore();
  });
});
