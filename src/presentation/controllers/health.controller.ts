import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  IMAGE_REPOSITORY,
  ImageRepositoryPort,
} from '../../application/ports/image-repository.port';
import { STORAGE, StoragePort } from '../../application/ports/storage.port';

interface HealthResponse {
  status: 'ok';
  checks: Record<'storage' | 'database', 'up'>;
  uptime: number;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(IMAGE_REPOSITORY) private readonly repository: ImageRepositoryPort,
  ) {}

  // Sin throttle: los probes de Docker/k8s no deben consumir cuota de rate limit.
  @Get()
  @SkipThrottle()
  async check(): Promise<HealthResponse> {
    try {
      await Promise.all([this.storage.probe(), this.repository.ping()]);
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'degraded',
        reason: error instanceof Error ? error.message : 'unknown',
        timestamp: new Date().toISOString(),
      });
    }
    return {
      status: 'ok',
      checks: { storage: 'up', database: 'up' },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
