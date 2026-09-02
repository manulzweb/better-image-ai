import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  PipeTransform,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../../config/config.schema';
import { sniffImageMimeType } from '../../domain/image-signatures';
import { UnsupportedMimeTypeException } from '../../domain/exceptions/unsupported-mime-type.exception';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

@Injectable()
export class ImageUploadValidationPipe implements PipeTransform<
  Express.Multer.File | undefined,
  Express.Multer.File
> {
  private readonly maxBytes: number;

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    this.maxBytes = config.get('MAX_FILE_SIZE_MB', { infer: true }) * 1024 * 1024;
  }

  transform(file?: Express.Multer.File): Express.Multer.File {
    if (!file || file.size === 0) {
      throw new BadRequestException('Image file is required');
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new UnsupportedMimeTypeException(file.mimetype || 'unknown');
    }
    // Magic bytes: el Content-Type declarado por el cliente no basta; sin firma
    // válida no se factura nada a Gemini.
    const detected = sniffImageMimeType(file.buffer);
    if (!detected || detected !== file.mimetype) {
      throw new UnsupportedMimeTypeException(
        detected ? `${file.mimetype} (declared), content is ${detected}` : file.mimetype,
      );
    }
    if (file.size > this.maxBytes) {
      throw new PayloadTooLargeException(
        `File exceeds the ${this.config.get('MAX_FILE_SIZE_MB', { infer: true })}MB limit`,
      );
    }
    return file;
  }
}
