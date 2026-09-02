import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IMAGE_REPOSITORY,
  ImageRepositoryPort,
} from '../../application/ports/image-repository.port';
import { STORAGE, StoragePort } from '../../application/ports/storage.port';
import { EnvConfig } from '../../config/config.schema';

// Reconciliación storage↔DB: borra ficheros sin fila en DB (huérfanos por
// crash entre storage.save y repository.save) y temporales `*.tmp-*`.
@Injectable()
export class StorageGarbageCollector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageGarbageCollector.name);
  private readonly intervalMinutes: number;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(IMAGE_REPOSITORY) private readonly repository: ImageRepositoryPort,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.intervalMinutes = config.get('GC_INTERVAL_MINUTES', { infer: true });
  }

  onModuleInit(): void {
    void this.run();
    if (this.intervalMinutes > 0) {
      this.timer = setInterval(() => void this.run(), this.intervalMinutes * 60_000);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  // Devuelve cuántos ficheros borró (útil en tests). No lanza: es un proceso
  // en background, un fallo de GC no debe tumbar el arranque.
  async run(): Promise<number> {
    try {
      const validHashes = new Set(await this.repository.listHashes());
      const removed = await this.storage.removeOrphans(validHashes);
      if (removed.length > 0) {
        this.logger.log(`Storage GC removed ${removed.length} orphan file(s)`);
      }
      return removed.length;
    } catch (error) {
      this.logger.error('Storage GC failed', error instanceof Error ? error.stack : String(error));
      return 0;
    }
  }
}
