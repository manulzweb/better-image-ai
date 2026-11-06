import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { SqliteCommerceRepository } from './sqlite-commerce.repository';
import { SqliteImageRepository } from './sqlite-image.repository';
import { EnvConfig } from '../../config/config.schema';

const input = { buffer: Buffer.from('fixture'), mimeType: 'image/png', digest: 'a'.repeat(64) };
describe('Persistent jobs and prepaid credits', () => {
  let dir: string;
  let config: ConfigService<EnvConfig, true>;
  let store: SqliteCommerceRepository;
  let images: SqliteImageRepository;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commerce-'));
    config = new ConfigService({
      DB_PATH: join(dir, 'db.sqlite'),
      MAX_PENDING_IMAGES: 100,
      JOB_UPLOAD_TTL_MINUTES: 60,
    }) as ConfigService<EnvConfig, true>;
    images = new SqliteImageRepository(config);
    store = new SqliteCommerceRepository(config);
  });
  afterEach(() => {
    store.onApplicationShutdown();
    images.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  it('makes grants idempotent and rejects reuse with another account or amount', async () => {
    await store.grant('a', 10, 'payment-1');
    await store.grant('a', 10, 'payment-1');
    await expect(store.grant('b', 10, 'payment-1')).rejects.toThrow('reference');
    await expect(store.grant('a', 20, 'payment-1')).rejects.toThrow('reference');
    expect(await store.balance('a')).toEqual({ available: 10, reserved: 0 });
  });
  it('rolls back all reservations when funds are insufficient', async () => {
    await store.grant('a', 2, 'grant');
    await expect(store.create('a', 'create-1', 3, undefined, 'v1')).rejects.toThrow('Insufficient');
    expect(await store.balance('a')).toEqual({ available: 2, reserved: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n).toBe(0);
  });
  it('reserves once, uploads idempotently, isolates tenants and refunds cancellations', async () => {
    await store.grant('a', 5, 'grant');
    const job = await store.create('a', 'create-1', 2, 'white', 'v1');
    expect((await store.create('a', 'create-1', 2, 'white', 'v1')).id).toBe(job.id);
    await expect(store.create('a', 'create-1', 3, 'white', 'v1')).rejects.toThrow('different job');
    await expect(store.get('b', job.id)).rejects.toThrow('not found');
    await expect(store.append('b', job.id, 'upload-1', [input])).rejects.toThrow('not found');
    await store.append('a', job.id, 'upload-1', [input]);
    expect((await store.append('a', job.id, 'upload-1', [input])).uploaded).toBe(1);
    await expect(
      store.append('a', job.id, 'upload-1', [{ ...input, digest: 'other' }]),
    ).rejects.toThrow('different files');
    await expect(store.submit('a', job.id)).rejects.toThrow('Upload all');
    await store.cancel('a', job.id);
    await store.cancel('a', job.id);
    expect(await store.balance('a')).toEqual({ available: 5, reserved: 0 });
  });
  it('atomically captures one credit with a persisted image and recovers after restart', async () => {
    await store.grant('a', 2, 'grant');
    const job = await store.create('a', 'create-1', 1, undefined, 'v1');
    await store.append('a', job.id, 'upload-1', [input]);
    await store.submit('a', job.id);
    const work = (await store.claim())!;
    const image = {
      hash: 'a'.repeat(64),
      tenantId: 'a',
      mimeType: 'image/png',
      sizeBytes: 10,
      strategy: 'gemini',
      createdAt: new Date(),
    };
    await store.persist(image, work.reservation);
    store.onApplicationShutdown();
    store = new SqliteCommerceRepository(config);
    await store.recover();
    expect(await store.claim()).toBeNull();
    expect(await images.findByHash(image.hash)).not.toBeNull();
    await store.release(work.reservation); // cache replay must not refund a captured credit
    await store.finish(work, image.hash);
    expect(await store.balance('a')).toEqual({ available: 1, reserved: 0 });
    expect(await store.get('a', job.id)).toMatchObject({
      status: 'completed',
      charged: 1,
      completed: 1,
    });
  });
  it('recovers a cached result after releasing its reservation but before finishing the item', async () => {
    await store.grant('a', 1, 'grant');
    const job = await store.create('a', 'create-cache', 1, undefined, 'v1');
    await store.append('a', job.id, 'upload-cache', [input]);
    await store.submit('a', job.id);
    const work = (await store.claim())!;
    await store.release(work.reservation, 'a'.repeat(64));
    await store.recover();
    expect(await store.claim()).toBeNull();
    expect(await store.get('a', job.id)).toMatchObject({
      status: 'completed',
      completed: 1,
      charged: 0,
    });
    expect(await store.balance('a')).toEqual({ available: 1, reserved: 0 });
  });

  it('releases failed items, expires incomplete uploads and recovers interrupted failures', async () => {
    await store.grant('a', 5, 'grant');
    const job = await store.create('a', 'create-1', 1, undefined, 'v1');
    await store.append('a', job.id, 'upload-1', [input]);
    await store.submit('a', job.id);
    const work = (await store.claim())!;
    await store.release(work.reservation);
    await store.recover();
    expect((await store.get('a', job.id)).failed).toBe(1);
    const abandoned = await store.create('a', 'create-2', 2, undefined, 'v1');
    store.db.prepare('UPDATE jobs SET created=0 WHERE id=?').run(abandoned.id);
    await store.expire();
    expect((await store.get('a', abandoned.id)).status).toBe('expired');
    expect(await store.balance('a')).toEqual({ available: 5, reserved: 0 });
  });
  it('bounds queued inputs and does not overdraw during concurrent reservations', async () => {
    await store.grant('a', 200, 'grant');
    await store.create('a', 'big-job', 100, undefined, 'v1');
    await expect(store.create('a', 'other-job', 1, undefined, 'v1')).rejects.toThrow('capacity');
    await store.grant('b', 1, 'grant-b');
    const results = await Promise.allSettled([
      store.reserve('b', 'one'),
      store.reserve('b', 'two'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await store.balance('b')).toEqual({ available: 0, reserved: 1 });
  });
  it('refunds only queued work on cancellation while active work settles normally', async () => {
    await store.grant('a', 2, 'grant');
    const job = await store.create('a', 'create-1', 2, undefined, 'v1');
    await store.append('a', job.id, 'upload-1', [input, input]);
    await store.submit('a', job.id);
    const work = (await store.claim())!;
    await store.cancel('a', job.id);
    expect(await store.balance('a')).toEqual({ available: 1, reserved: 1 });
    await store.finish(work, undefined, 'FAILED');
    expect(await store.balance('a')).toEqual({ available: 2, reserved: 0 });
    expect((await store.get('a', job.id)).status).toBe('cancelled');
  });
});
