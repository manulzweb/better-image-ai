import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { GetProcessedImageUseCase } from './application/use-cases/get-processed-image.use-case';
import { OptimizeImageUseCase } from './application/use-cases/optimize-image.use-case';
import { HASH_SERVICE } from './application/ports/hash-service.port';
import { IMAGE_OPTIMIZER } from './application/ports/image-optimizer.port';
import { IMAGE_REPOSITORY } from './application/ports/image-repository.port';
import { STORAGE } from './application/ports/storage.port';
import { EnvConfig } from './config/config.schema';
import { GeminiImageOptimizerAdapter } from './infrastructure/ai/gemini-image-optimizer.adapter';
import { ApiKeyGuard } from './infrastructure/auth/api-key.guard';
import { CryptoHashService } from './infrastructure/hashing/crypto-hash.service';
import { SqliteImageRepository } from './infrastructure/persistence/sqlite-image.repository';
import { LocalFileStorageAdapter } from './infrastructure/storage/local-file-storage.adapter';
import { StorageGarbageCollector } from './infrastructure/storage/storage-garbage-collector.service';
import { HealthController } from './presentation/controllers/health.controller';
import { ImageController } from './presentation/controllers/image.controller';
import { ImageUploadValidationPipe } from './presentation/pipes/image-upload-validation.pipe';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        limits: { fileSize: config.get('MAX_FILE_SIZE_MB', { infer: true }) * 1024 * 1024 },
      }),
    }),
  ],
  controllers: [ImageController, HealthController],
  providers: [
    OptimizeImageUseCase,
    GetProcessedImageUseCase,
    ApiKeyGuard,
    ImageUploadValidationPipe,
    StorageGarbageCollector,
    { provide: IMAGE_OPTIMIZER, useClass: GeminiImageOptimizerAdapter },
    { provide: IMAGE_REPOSITORY, useClass: SqliteImageRepository },
    { provide: STORAGE, useClass: LocalFileStorageAdapter },
    { provide: HASH_SERVICE, useClass: CryptoHashService },
  ],
})
export class ImagesModule {}
