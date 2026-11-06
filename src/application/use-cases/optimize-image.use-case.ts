import { randomUUID } from 'node:crypto';
import { CREDITS, CreditsPort } from '../ports/credits.port';
import { PersistenceLock } from '../services/persistence-lock';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sniffImageMimeType } from '../../domain/image-signatures';
import { ImageProcessingException } from '../../domain/exceptions/image-processing.exception';
import { HASH_SERVICE, HashServicePort } from '../ports/hash-service.port';
import { IMAGE_OPTIMIZER, ImageOptimizerPort, OptimizeInput } from '../ports/image-optimizer.port';
import { IMAGE_REPOSITORY, ImageRepositoryPort } from '../ports/image-repository.port';
import { STORAGE, StoragePort } from '../ports/storage.port';
import { KeyedLock } from '../services/keyed-lock';

export interface OptimizeImageResult {
  readonly hash: string;
  readonly cached: boolean;
  readonly url: string;
  readonly strategy: string;
  readonly processingTimeMs: number;
}

@Injectable()
export class OptimizeImageUseCase {
  private readonly logger = new Logger(OptimizeImageUseCase.name);
  // Evita que dos peticiones concurrentes con la misma imagen llamen a Gemini dos veces.
  private readonly hashLock = new KeyedLock();

  constructor(
    @Inject(IMAGE_OPTIMIZER) private readonly optimizer: ImageOptimizerPort,
    @Inject(IMAGE_REPOSITORY) private readonly repository: ImageRepositoryPort,
    @Inject(HASH_SERVICE) private readonly hashService: HashServicePort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CREDITS) private readonly credits: CreditsPort,
    @Optional() private readonly persistenceLock: PersistenceLock = new PersistenceLock(),
  ) {}

  get cacheVersion(): string {
    return this.optimizer.cacheVersion ?? this.optimizer.strategy;
  }

  async execute(input: OptimizeInput): Promise<OptimizeImageResult> {
    const startedAt = Date.now();
    const sourceHash = this.hashService.compute(input.buffer);
    const hash = this.hashService.compute(
      Buffer.from(
        JSON.stringify([
          'v2',
          input.tenantId ?? 'legacy',
          sourceHash,
          input.mimeType,
          this.optimizer.cacheVersion ?? this.optimizer.strategy,
          input.prompt ?? '',
        ]),
      ),
    );
    const url = `/v1/images/${hash}`;

    const existing = await this.repository.findByHash(hash);
    if (existing) {
      if (input.reservationId) await this.credits.release(input.reservationId, hash);
      this.logger.log(`cache hit hash=${hash} size=${existing.sizeBytes}B`);
      return this.result(hash, url, existing.strategy, true, startedAt);
    }

    return this.hashLock.runExclusive(hash, async () => {
      // Re-check dentro del lock: otro request concurrente puede haberla procesado.
      const recheck = await this.repository.findByHash(hash);
      if (recheck) {
        if (input.reservationId) await this.credits.release(input.reservationId, hash);
        this.logger.log(`cache hit (after lock) hash=${hash}`);
        return this.result(hash, url, recheck.strategy, true, startedAt);
      }

      const reservation = input.reservationId ?? `sync:${randomUUID()}`;
      await this.credits.reserve(input.tenantId ?? 'legacy', reservation);
      try {
        const optimized = await this.optimizer.optimize(input);
        const mimeType = this.detectOutputMime(hash, optimized);
        await this.persistenceLock.run(async () => {
          await this.storage.save(hash, optimized);
          const image = {
            hash,
            tenantId: input.tenantId ?? 'legacy',
            mimeType,
            sizeBytes: optimized.length,
            strategy: this.optimizer.strategy,
            createdAt: new Date(),
          };
          await this.credits.persist(image, reservation);
        });

        this.logger.log(
          `cache miss hash=${hash} strategy=${this.optimizer.strategy} outSize=${optimized.length}B elapsed=${Date.now() - startedAt}ms`,
        );
        return this.result(hash, url, this.optimizer.strategy, false, startedAt);
      } finally {
        // Accounting cleanup, not provider fallback. Captured holds remain consumed.
        await this.credits.release(reservation);
      }
    });
  }

  private result(
    hash: string,
    url: string,
    strategy: string,
    cached: boolean,
    startedAt: number,
  ): OptimizeImageResult {
    return { hash, url, strategy, cached, processingTimeMs: Date.now() - startedAt };
  }

  private detectOutputMime(hash: string, buffer: Buffer): string {
    const mimeType = sniffImageMimeType(buffer);
    if (!mimeType) {
      throw new ImageProcessingException(
        `Optimizer returned an unrecognized image format for hash ${hash}`,
        'INVALID_OPTIMIZED_IMAGE',
      );
    }
    return mimeType;
  }
}
