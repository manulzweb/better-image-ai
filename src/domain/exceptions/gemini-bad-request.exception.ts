import { ImageProcessingException } from './image-processing.exception';

// Errores 4xx (distinto de 429) devueltos por Gemini: la entrada es inválida,
// no reintentable. Se mapea a 400 en lugar de 502.
export class GeminiBadRequestException extends ImageProcessingException {
  constructor(message: string) {
    super(`Gemini rejected the request: ${message}`, 'GEMINI_BAD_REQUEST');
  }
}
