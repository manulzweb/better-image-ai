import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { EnvConfig } from '../../config/config.schema';
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}
  canActivate(context: ExecutionContext) {
    const expected = this.config.get('ADMIN_API_KEY_HASH', { infer: true });
    const provided = context.switchToHttp().getRequest<Request>().headers['x-admin-key'];
    if (
      !expected ||
      typeof provided !== 'string' ||
      provided.length > 512 ||
      !timingSafeEqual(Buffer.from(expected, 'hex'), createHash('sha256').update(provided).digest())
    )
      throw new UnauthorizedException();
    return true;
  }
}
