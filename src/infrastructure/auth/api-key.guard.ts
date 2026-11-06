import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EnvConfig } from '../../config/config.schema';

export type ClientRequest = Request & { client: { id: string; profiles: Record<string, string> } };

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly credentials: { digest: Buffer; client: ClientRequest['client'] }[];

  constructor(config: ConfigService<EnvConfig, true>) {
    this.credentials = (config.get('CLIENTS_JSON', { infer: true }) ?? []).flatMap((client) =>
      client.keyHashes.map((hash) => ({ digest: Buffer.from(hash, 'hex'), client })),
    );
    // Compatibility for local development only: all legacy keys belong to one account.
    for (const key of config.get('API_KEYS', { infer: true }) ?? []) {
      this.credentials.push({
        digest: createHash('sha256').update(key).digest(),
        client: { id: 'legacy', profiles: {} },
      });
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ClientRequest>();
    const header = request.headers['x-api-key'];
    if (typeof header !== 'string' || !header || header.length > 512) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    const candidate = createHash('sha256').update(header).digest();
    let match: ClientRequest['client'] | undefined;
    for (const credential of this.credentials) {
      if (timingSafeEqual(credential.digest, candidate)) match = credential.client;
    }
    if (!match) throw new UnauthorizedException('Invalid or missing API key');
    request.client = { id: match.id, profiles: match.profiles };
    return true;
  }
}
