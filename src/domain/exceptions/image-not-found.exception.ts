import { ImageProcessingException } from './image-processing.exception';

export class ImageNotFoundException extends ImageProcessingException {
  constructor(hash: string) {
    super(`Image not found: ${hash}`, 'IMAGE_NOT_FOUND');
  }
}
