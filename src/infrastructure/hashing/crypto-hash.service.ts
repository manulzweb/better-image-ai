import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HashServicePort } from '../../application/ports/hash-service.port';

@Injectable()
export class CryptoHashService implements HashServicePort {
  compute(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }
}
