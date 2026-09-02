export class ImageProcessingException extends Error {
  constructor(
    message: string,
    readonly code: string = 'IMAGE_PROCESSING_ERROR',
  ) {
    super(message);
    this.name = new.target.name;
  }
}
