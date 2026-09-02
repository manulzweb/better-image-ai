export interface ProcessedImage {
  readonly hash: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly strategy: string;
  readonly createdAt: Date;
}

export const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/;
