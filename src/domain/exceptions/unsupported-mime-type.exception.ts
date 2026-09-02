import { ImageProcessingException } from './image-processing.exception';

export class UnsupportedMimeTypeException extends ImageProcessingException {
  constructor(mimeType: string) {
    super(`Unsupported MIME type: ${mimeType}`, 'UNSUPPORTED_MIME_TYPE');
  }
}
