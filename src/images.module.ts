import { SqlitePurchasesRepository } from './infrastructure/persistence/sqlite-purchases.repository';
import { MercadoPagoAdapter } from './infrastructure/payments/mercado-pago.adapter';
import { PURCHASES, PAYMENT_GATEWAY } from './application/ports/payments.port';
import { PaymentsUseCase } from './application/use-cases/payments.use-case';
import { PaymentsController } from './presentation/controllers/payments.controller';
import { SqliteCommerceRepository } from './infrastructure/persistence/sqlite-commerce.repository';
import { CREDITS } from './application/ports/credits.port';
import { JOBS } from './application/ports/jobs.port';
import { JobsController } from './presentation/controllers/jobs.controller';
import { CreditsController } from './presentation/controllers/credits.controller';
import { JobWorker } from './infrastructure/jobs/job-worker.service';
import { AdminGuard } from './infrastructure/auth/admin.guard';
import { PersistenceLock } from './application/services/persistence-lock';
import { AdmissionGuard } from './infrastructure/auth/admission.guard';
import { AdmissionInterceptor } from './presentation/middleware/admission.interceptor';
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
        limits: {
          fileSize: config.get('MAX_FILE_SIZE_MB', { infer: true }) * 1024 * 1024,
          files: config.get('MAX_BATCH_FILES', { infer: true }),
          fields: 1,
          fieldSize: 128,
          parts: config.get('MAX_BATCH_FILES', { infer: true }) + 1,
        },
      }),
    }),
  ],
  controllers: [
    ImageController,
    HealthController,
    JobsController,
    CreditsController,
    PaymentsController,
  ],
  providers: [
    SqliteCommerceRepository,
    { provide: PURCHASES, useClass: SqlitePurchasesRepository },
    { provide: PAYMENT_GATEWAY, useClass: MercadoPagoAdapter },
    PaymentsUseCase,
    { provide: CREDITS, useExisting: SqliteCommerceRepository },
    { provide: JOBS, useExisting: SqliteCommerceRepository },
    JobWorker,
    AdminGuard,
    PersistenceLock,
    OptimizeImageUseCase,
    GetProcessedImageUseCase,
    ApiKeyGuard,
    AdmissionGuard,
    AdmissionInterceptor,
    ImageUploadValidationPipe,
    StorageGarbageCollector,
    { provide: IMAGE_OPTIMIZER, useClass: GeminiImageOptimizerAdapter },
    { provide: IMAGE_REPOSITORY, useClass: SqliteImageRepository },
    { provide: STORAGE, useClass: LocalFileStorageAdapter },
    { provide: HASH_SERVICE, useClass: CryptoHashService },
  ],
})
export class ImagesModule {}
