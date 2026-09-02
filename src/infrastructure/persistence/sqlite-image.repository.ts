import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageRepositoryPort } from '../../application/ports/image-repository.port';
import { ProcessedImage } from '../../domain/entities/processed-image';
import { EnvConfig } from '../../config/config.schema';

interface ImageRow {
  hash: string;
  mime_type: string;
  size_bytes: number;
  strategy: string;
  created_at: string;
}

@Injectable()
export class SqliteImageRepository implements ImageRepositoryPort, OnModuleDestroy {
  private readonly db: DatabaseSync;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    const dbPath = resolve(config.get('DB_PATH', { infer: true }));
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL + busy_timeout: lectores concurrentes (backup procesos, CLI) no bloquean.
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA busy_timeout = 5000`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_images (
        hash TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        strategy TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  async findByHash(hash: string): Promise<ProcessedImage | null> {
    const row = this.db
      .prepare(
        'SELECT hash, mime_type, size_bytes, strategy, created_at FROM processed_images WHERE hash = ?',
      )
      .get(hash) as ImageRow | undefined;

    if (!row) {
      return null;
    }

    return {
      hash: row.hash,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      strategy: row.strategy,
      createdAt: new Date(row.created_at),
    };
  }

  async save(image: ProcessedImage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_images (hash, mime_type, size_bytes, strategy, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        image.hash,
        image.mimeType,
        image.sizeBytes,
        image.strategy,
        image.createdAt.toISOString(),
      );
  }

  async listHashes(): Promise<string[]> {
    const rows = this.db.prepare('SELECT hash FROM processed_images').all() as Pick<
      ImageRow,
      'hash'
    >[];
    return rows.map((row) => row.hash);
  }

  async ping(): Promise<void> {
    this.db.prepare('SELECT 1').get();
  }

  onModuleDestroy(): void {
    this.db.close();
  }
}
