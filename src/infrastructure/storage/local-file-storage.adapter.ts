import { randomBytes } from 'node:crypto';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoragePort } from '../../application/ports/storage.port';
import { SHA256_HEX_REGEX } from '../../domain/entities/processed-image';
import { EnvConfig } from '../../config/config.schema';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';

@Injectable()
export class LocalFileStorageAdapter implements StoragePort {
  private readonly baseDir: string;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    this.baseDir = resolve(config.get('STORAGE_DIR', { infer: true }));
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePath(hash: string): string {
    return join(this.baseDir, hash);
  }

  // Escritura atómica (tmp + rename): un crash a media escritura no deja el
  // fichero truncado; el `*.tmp-*` sobrante lo limpia el GC.
  async save(hash: string, buffer: Buffer): Promise<string> {
    const path = this.filePath(hash);
    const suffix = randomBytes(8).toString('hex');
    const tmp = `${path}.tmp-${suffix}`;
    await writeFile(tmp, buffer);
    await rename(tmp, path);
    return path;
  }

  async read(hash: string): Promise<Buffer> {
    try {
      return await readFile(this.filePath(hash));
    } catch {
      throw new ImageNotFoundException(hash);
    }
  }

  // Borra cualquier cosa que no sea un hash sha256 válido presente en la DB
  // (ficheros huérfanos o temporales `*.tmp-*`). Devuelve lo borrado.
  async removeOrphans(validHashes: ReadonlySet<string>): Promise<string[]> {
    const entries = await readdir(this.baseDir);
    const removed: string[] = [];
    for (const entry of entries) {
      if (!SHA256_HEX_REGEX.test(entry) || !validHashes.has(entry)) {
        await unlink(join(this.baseDir, entry));
        removed.push(entry);
      }
    }
    return removed;
  }

  async probe(): Promise<void> {
    const probePath = join(this.baseDir, `.health-${process.pid}`);
    await writeFile(probePath, 'ok');
    await unlink(probePath);
  }
}
