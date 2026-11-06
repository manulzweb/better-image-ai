import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { PaymentsUseCase } from '../../application/use-cases/payments.use-case';
import { PURCHASES, PurchasesPort } from '../../application/ports/payments.port';
import { ApiKeyGuard, ClientRequest } from '../../infrastructure/auth/api-key.guard';
import { idempotencyKey } from './jobs.controller';

@Controller('v1/payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsUseCase,
    @Inject(PURCHASES) private readonly purchases: PurchasesPort,
  ) {}
  @Post('checkout')
  @UseGuards(ApiKeyGuard)
  checkout(@Req() req: ClientRequest, @Headers('idempotency-key') key: string) {
    return this.payments.checkout(req.client.id, idempotencyKey(key));
  }
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  get(@Req() req: ClientRequest, @Param('id') id: string) {
    return this.purchases.get(req.client.id, id);
  }
  @Post(':id/reconcile')
  @UseGuards(ApiKeyGuard)
  @HttpCode(200)
  reconcile(
    @Req() req: ClientRequest,
    @Param('id') id: string,
    @Body() body: { paymentId?: unknown },
  ) {
    if (!body || typeof body.paymentId !== 'string' || !/^\d{1,30}$/.test(body.paymentId))
      throw new BadRequestException('Expected a numeric paymentId string');
    return this.payments.reconcile(req.client.id, id, body.paymentId);
  }
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: Request) {
    // Never trust unsigned body.data.id or browser redirect parameters.
    const query = new URL(req.originalUrl, 'http://localhost').searchParams;
    const ids = query.getAll('data.id');
    await this.payments.notification(
      ids.length === 1 ? ids[0] : undefined,
      req.headers['x-signature'],
      req.headers['x-request-id'],
    );
    return { received: true };
  }
}
