import {
  BadRequestException,
  Body,
  Req,
  UploadedFiles,
  Controller,
  Logger,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { GetProcessedImageUseCase } from '../../application/use-cases/get-processed-image.use-case';
import { OptimizeImageUseCase } from '../../application/use-cases/optimize-image.use-case';
import { ApiKeyGuard, ClientRequest } from '../../infrastructure/auth/api-key.guard';
import { OptimizeResponseDto } from '../dto/optimize-response.dto';
import { ImageUploadValidationPipe } from '../pipes/image-upload-validation.pipe';

import { AdmissionGuard } from '../../infrastructure/auth/admission.guard';
import { AdmissionInterceptor } from '../middleware/admission.interceptor';

@Controller('v1/images')
@UseGuards(ApiKeyGuard)
export class ImageController {
  private readonly logger = new Logger(ImageController.name);
  constructor(
    private readonly optimizeImage: OptimizeImageUseCase,
    private readonly getProcessedImage: GetProcessedImageUseCase,
    private readonly validation: ImageUploadValidationPipe,
  ) {}

  @Post('optimize')
  @UseGuards(AdmissionGuard)
  @UseInterceptors(AdmissionInterceptor, FileInterceptor('file'))
  async optimize(
    @UploadedFile(ImageUploadValidationPipe) file: Express.Multer.File,
    @Req() req: ClientRequest,
    @Body('profile') profile?: string,
  ): Promise<OptimizeResponseDto> {
    return this.optimizeImage.execute({
      buffer: file.buffer,
      mimeType: file.mimetype,
      tenantId: req.client.id,
      prompt: this.profile(req, profile),
    });
  }

  @Post('batch')
  @UseGuards(AdmissionGuard)
  @UseInterceptors(AdmissionInterceptor, FilesInterceptor('files'))
  async batch(
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: ClientRequest,
    @Body('profile') profile?: string,
  ) {
    if (!files?.length) throw new BadRequestException('At least one file is required');
    const prompt = this.profile(req, profile);
    // Validate the whole request before starting any billable provider work.
    for (const file of files) this.validation.transform(file);
    const results = [];
    // Sequential inside a batch to keep one large customer from consuming all slots.
    for (const [index, file] of files.entries()) {
      try {
        const result = await this.optimizeImage.execute({
          buffer: file.buffer,
          mimeType: file.mimetype,
          tenantId: req.client.id,
          prompt,
        });
        results.push({ index, status: 'succeeded', ...result });
      } catch (error) {
        this.logger.error(
          `Batch item failed tenant=${req.client.id} index=${index}`,
          error instanceof Error ? error.stack : undefined,
        );
        results.push({ index, status: 'failed', code: 'PROCESSING_FAILED' });
      }
    }
    return { results };
  }

  private profile(req: ClientRequest, profile?: string): string | undefined {
    if (profile === undefined) return req.client.profiles.default;
    if (typeof profile !== 'string' || !Object.hasOwn(req.client.profiles, profile)) {
      throw new BadRequestException('Unknown profile');
    }
    return req.client.profiles[profile];
  }

  @Get(':hash')
  async findOne(
    @Param('hash') hash: string,
    @Res() res: Response,
    @Req() req: ClientRequest,
  ): Promise<void> {
    const { buffer, mimeType } = await this.getProcessedImage.execute(hash, req.client.id);
    res
      .set({
        'Content-Type': mimeType,
        'Cache-Control': 'private, no-store',
      })
      .send(buffer);
  }
}
