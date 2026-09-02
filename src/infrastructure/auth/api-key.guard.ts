import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { EnvConfig } from '../../config/config.schema';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly validKeys: string[];

  constructor(private readonly config: ConfigService<EnvConfig, true>) {
    this.validKeys = config.get('API_KEYS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;

    if (!provided || !this.isValid(provided)) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    return true;
  }

  // Comparación timing-safe para evitar ataques de canal lateral.
  private isValid(key: string): boolean {
    const candidate = Buffer.from(key);
    return this.validKeys.some((valid) => {
      const expected = Buffer.from(valid);
      return expected.length === candidate.length && timingSafeEqual(expected, candidate);
    });
  }
}
