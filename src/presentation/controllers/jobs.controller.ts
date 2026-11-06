import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { JOBS, JobsPort } from '../../application/ports/jobs.port';
import { HASH_SERVICE, HashServicePort } from '../../application/ports/hash-service.port';
import { OptimizeImageUseCase } from '../../application/use-cases/optimize-image.use-case';
import { ApiKeyGuard, ClientRequest } from '../../infrastructure/auth/api-key.guard';
import { AdmissionGuard } from '../../infrastructure/auth/admission.guard';
import { AdmissionInterceptor } from '../middleware/admission.interceptor';
import { ImageUploadValidationPipe } from '../pipes/image-upload-validation.pipe';

export function idempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key))
    throw new BadRequestException(
      'Idempotency-Key must contain 8-128 letters, digits, underscores or hyphens',
    );
  return key;
}
export function profilePrompt(req: ClientRequest, profile?: string): string | undefined {
  if (profile === undefined) return req.client.profiles.default;
  if (typeof profile !== 'string' || !Object.hasOwn(req.client.profiles, profile))
    throw new BadRequestException('Unknown profile');
  return req.client.profiles[profile];
}
@Controller('v1/jobs')
@UseGuards(ApiKeyGuard)
export class JobsController {
  constructor(
    @Inject(JOBS) private readonly jobs: JobsPort,
    @Inject(HASH_SERVICE) private readonly hashes: HashServicePort,
    private readonly optimize: OptimizeImageUseCase,
    private readonly validation: ImageUploadValidationPipe,
  ) {}
  @Post()
  async create(
    @Req() req: ClientRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = z
      .object({ count: z.number().int().min(1).max(100), profile: z.string().max(64).optional() })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Expected count (1-100) and optional profile');
    return this.jobs.create(
      req.client.id,
      idempotencyKey(key),
      parsed.data.count,
      profilePrompt(req, parsed.data.profile),
      this.optimize.cacheVersion,
    );
  }
  @Post(':id/items')
  @UseGuards(AdmissionGuard)
  @UseInterceptors(AdmissionInterceptor, FilesInterceptor('files'))
  async append(
    @Req() req: ClientRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    idempotencyKey(key);
    if (Object.keys(req.body ?? {}).length)
      throw new BadRequestException(
        'Job uploads only accept files; the profile is fixed at creation',
      );
    if (!files?.length) throw new BadRequestException('At least one file is required');
    const inputs = files.map((file) => {
      this.validation.transform(file);
      return {
        buffer: file.buffer,
        mimeType: file.mimetype,
        digest: this.hashes.compute(file.buffer),
      };
    });
    return this.jobs.append(req.client.id, id, key, inputs);
  }
  @Post(':id/submit')
  @HttpCode(202)
  submit(@Req() req: ClientRequest, @Param('id') id: string) {
    return this.jobs.submit(req.client.id, id);
  }
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: ClientRequest, @Param('id') id: string) {
    return this.jobs.cancel(req.client.id, id);
  }
  @Get(':id')
  get(@Req() req: ClientRequest, @Param('id') id: string) {
    return this.jobs.get(req.client.id, id);
  }
}
