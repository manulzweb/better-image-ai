import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteImageRepository } from './sqlite-image.repository';
import { ConfigService } from '@nestjs/config';
import { ProcessedImage } from '../../domain/entities/processed-image';

describe('SqliteImageRepository', () => {
  let dir: string;
  const created: SqliteImageRepository[] = [];

  const build = (dbPath: string): SqliteImageRepository => {
    const config = { get: () => dbPath } as unknown as ConfigService;
    const repo = new SqliteImageRepository(config as any);
    created.push(repo);
    return repo;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bia-db-'));
  });

  afterEach(() => {
    created.forEach((r) => r.onApplicationShutdown());
    created.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  const image: ProcessedImage = {
    hash: 'a'.repeat(64),
    mimeType: 'image/png',
    sizeBytes: 123,
    strategy: 'gemini',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  it('guarda y recupera una imagen por hash', async () => {
    const repo = build(join(dir, 'test.db'));
    await repo.save(image);
    const found = await repo.findByHash(image.hash);

    expect(found).not.toBeNull();
    expect(found?.hash).toBe(image.hash);
    expect(found?.mimeType).toBe('image/png');
    expect(found?.strategy).toBe('gemini');
    expect(found?.sizeBytes).toBe(123);
  });

  it('retorna null cuando el hash no existe', async () => {
    const repo = build(join(dir, 'test2.db'));
    expect(await repo.findByHash('none')).toBeNull();
  });

  it('INSERT OR IGNORE no duplica el registro', async () => {
    const repo = build(join(dir, 'test3.db'));
    await repo.save(image);
    await repo.save({ ...image, sizeBytes: 999 });
    const found = await repo.findByHash(image.hash);
    expect(found?.sizeBytes).toBe(123);
  });

  it('listHashes devuelve todos los hashes guardados', async () => {
    const repo = build(join(dir, 'test4.db'));
    await repo.save(image);
    await repo.save({ ...image, hash: 'c'.repeat(64) });

    const hashes = await repo.listHashes();
    expect(hashes.sort()).toEqual([image.hash, 'c'.repeat(64)].sort());
  });

  it('ping no falla con la DB abierta', async () => {
    const repo = build(join(dir, 'test5.db'));
    await expect(repo.ping()).resolves.toBeUndefined();
  });

  it('activa WAL y busy_timeout', async () => {
    const repo = build(join(dir, 'test6.db'));
    const db = (repo as unknown as { db: { prepare: (q: string) => { get: () => unknown } } }).db;
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const busy = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(journal.journal_mode).toBe('wal');
    expect(busy.timeout).toBe(5000);
  });
});
