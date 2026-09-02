export const HASH_SERVICE = Symbol('HASH_SERVICE');

export interface HashServicePort {
  compute(buffer: Buffer): string;
}
