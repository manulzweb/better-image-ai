import {
  Controller,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { GetProcessedImageUseCase } from '../../application/use-cases/get-processed-image.use-case';
import { OptimizeImageUseCase } from '../../application/use-cases/optimize-image.use-case';
import { ApiKeyGuard } from '../../infrastructure/auth/api-key.guard';
import { OptimizeResponseDto } from '../dto/optimize-response.dto';
import { ImageUploadValidationPipe } from '../pipes/image-upload-validation.pipe';

@Controller('v1/images')
@UseGuards(ApiKeyGuard)
export class ImageController {
  constructor(
    private readonly optimizeImage: OptimizeImageUseCase,
    private readonly getProcessedImage: GetProcessedImageUseCase,
  ) {}

  @Post('optimize')
  @UseInterceptors(FileInterceptor('file'))
  async optimize(
    @UploadedFile(ImageUploadValidationPipe) file: Express.Multer.File,
  ): Promise<OptimizeResponseDto> {
    return this.optimizeImage.execute({ buffer: file.buffer, mimeType: file.mimetype });
  }

  @Get(':hash')
  async findOne(@Param('hash') hash: string, @Res() res: Response): Promise<void> {
    const { buffer, mimeType } = await this.getProcessedImage.execute(hash);
    res
      .set({
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      })
      .send(buffer);
  }
}
