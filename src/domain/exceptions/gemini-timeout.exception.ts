import { ImageProcessingException } from './image-processing.exception';

export class GeminiTimeoutException extends ImageProcessingException {
  constructor(timeoutMs: number) {
    super(`Gemini API request timed out after ${timeoutMs}ms`, 'GEMINI_TIMEOUT');
  }
}
