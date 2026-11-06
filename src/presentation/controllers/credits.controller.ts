import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { CREDITS, CreditsPort } from '../../application/ports/credits.port';
import { ApiKeyGuard, ClientRequest } from '../../infrastructure/auth/api-key.guard';
import { AdminGuard } from '../../infrastructure/auth/admin.guard';
import { EnvConfig } from '../../config/config.schema';
import { idempotencyKey } from './jobs.controller';
@Controller('v1')
export class CreditsController {
  constructor(
    @Inject(CREDITS) private readonly credits: CreditsPort,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}
  @Get('credits')
  @UseGuards(ApiKeyGuard)
  balance(@Req() req: ClientRequest) {
    return this.credits.balance(req.client.id);
  }
  @Post('admin/clients/:tenant/credits')
  @UseGuards(AdminGuard)
  async grant(
    @Param('tenant') tenant: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    const parsed = z
      .object({ amount: z.number().int().min(1).max(1_000_000) })
      .strict()
      .safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Expected integer credit amount (1-1000000)');
    const clients = this.config.get('CLIENTS_JSON', { infer: true });
    if (
      !clients.some((client) => client.id === tenant) &&
      !(tenant === 'legacy' && this.config.get('API_KEYS', { infer: true }).length)
    )
      throw new BadRequestException('Unknown client');
    await this.credits.grant(tenant, parsed.data.amount, `admin:${idempotencyKey(key)}`);
    return this.credits.balance(tenant);
  }
}
