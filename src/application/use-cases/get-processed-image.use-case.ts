import { Inject, Injectable } from '@nestjs/common';
import { SHA256_HEX_REGEX } from '../../domain/entities/processed-image';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';
import { IMAGE_REPOSITORY, ImageRepositoryPort } from '../ports/image-repository.port';
import { STORAGE, StoragePort } from '../ports/storage.port';

export interface ProcessedImagePayload {
  readonly buffer: Buffer;
  readonly mimeType: string;
}

@Injectable()
export class GetProcessedImageUseCase {
  constructor(
    @Inject(IMAGE_REPOSITORY) private readonly repository: ImageRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async execute(hash: string, tenantId = 'legacy'): Promise<ProcessedImagePayload> {
    if (!SHA256_HEX_REGEX.test(hash)) {
      throw new ImageNotFoundException(hash);
    }

    const record = await this.repository.findByHash(hash);
    if (!record || (record.tenantId ?? 'legacy') !== tenantId) {
      throw new ImageNotFoundException(hash);
    }

    const buffer = await this.storage.read(hash);
    return { buffer, mimeType: record.mimeType };
  }
}
