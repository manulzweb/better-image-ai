import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileStorageAdapter } from './local-file-storage.adapter';
import { ConfigService } from '@nestjs/config';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';

describe('LocalFileStorageAdapter', () => {
  let dir: string;
  let adapter: LocalFileStorageAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bia-storage-'));
    const config = { get: () => dir } as unknown as ConfigService;
    adapter = new LocalFileStorageAdapter(config as any);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('guarda y lee un buffer por hash', async () => {
    const data = Buffer.from('image-bytes');
    const path = await adapter.save('abc123', data);

    expect(existsSync(path)).toBe(true);
    const read = await adapter.read('abc123');
    expect(read.equals(data)).toBe(true);
  });

  it('lanza ImageNotFoundException al leer un hash inexistente', async () => {
    await expect(adapter.read('missing')).rejects.toBeInstanceOf(ImageNotFoundException);
  });

  it('crea el directorio base si no existe', () => {
    const nested = join(dir, 'nested', 'processed');
    const config = { get: () => nested } as unknown as ConfigService;
    new LocalFileStorageAdapter(config as any);
    expect(existsSync(nested)).toBe(true);
  });

  it('save es atómico: no deja temporales .tmp-* tras escribir', async () => {
    await adapter.save('a'.repeat(64), Buffer.from('data'));
    const entries = await readdir(dir);
    expect(entries).toEqual(['a'.repeat(64)]);
  });

  it('probe escribe y borra un fichero temporal sin rastro', async () => {
    await expect(adapter.probe()).resolves.toBeUndefined();
    const entries = await readdir(dir);
    expect(entries.every((e) => !e.startsWith('.health-'))).toBe(true);
  });

  it('removeOrphans borra ficheros no presentes en la DB y temporales', async () => {
    const validHash = 'b'.repeat(64);
    await writeFile(join(dir, validHash), 'kept');
    await writeFile(join(dir, 'c'.repeat(64)), 'orphan');
    await writeFile(join(dir, `${validHash}.tmp-deadbeef`), 'stale tmp');

    const removed = await adapter.removeOrphans(new Set([validHash]));

    expect(removed.sort()).toEqual([`${validHash}.tmp-deadbeef`, 'c'.repeat(64)].sort());
    expect(existsSync(join(dir, validHash))).toBe(true);
    expect(existsSync(join(dir, 'c'.repeat(64)))).toBe(false);
  });
});
