export const IMAGE_OPTIMIZER = Symbol('IMAGE_OPTIMIZER');

export interface OptimizeInput {
  buffer: Buffer;
  mimeType: string;
}

export interface ImageOptimizerPort {
  readonly strategy: string;
  optimize(input: OptimizeInput): Promise<Buffer>;
}
