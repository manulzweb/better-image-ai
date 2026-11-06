export const IMAGE_OPTIMIZER = Symbol('IMAGE_OPTIMIZER');

export interface OptimizeInput {
  tenantId?: string;
  reservationId?: string;
  prompt?: string;
  buffer: Buffer;
  mimeType: string;
}

export interface ImageOptimizerPort {
  readonly cacheVersion?: string;
  readonly strategy: string;
  optimize(input: OptimizeInput): Promise<Buffer>;
}
