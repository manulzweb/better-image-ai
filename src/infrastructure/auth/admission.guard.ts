import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { EnvConfig } from '../../config/config.schema';

/** Reserve memory capacity before Multer buffers uploads. */
@Injectable()
export class AdmissionGuard implements CanActivate {
  private active = 0;
  private readonly limit: number;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.limit = config.get('MAX_ACTIVE_REQUESTS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const response = context.switchToHttp().getResponse<Response>();
    if (this.active >= this.limit) {
      response.setHeader('Retry-After', '5');
      throw new ServiceUnavailableException('Processing capacity reached; retry later');
    }
    this.active++;
    // A disconnected client must not free capacity while Gemini is still running.
    // The interceptor releases after the handler finishes, even after disconnection.
    context.switchToHttp().getRequest().releaseAdmission = () => {
      this.active--;
    };
    return true;
  }
}
