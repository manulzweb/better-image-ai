import { ImageProcessingException } from './image-processing.exception';

export class GeminiApiException extends ImageProcessingException {
  constructor(message: string) {
    super(message, 'GEMINI_API_ERROR');
  }
}
