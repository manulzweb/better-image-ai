import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  PaymentGatewayPort,
  Purchase,
  VerifiedPayment,
} from '../../application/ports/payments.port';
import { EnvConfig } from '../../config/config.schema';

@Injectable()
export class MercadoPagoAdapter implements PaymentGatewayPort {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const token = this.config.get('MP_ACCESS_TOKEN', { infer: true });
    if (!token) throw new ServiceUnavailableException('Payments are not configured');
    try {
      const response = await fetch(`https://api.mercadopago.com${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error('Provider error');
      return await response.json();
    } catch {
      throw new BadGatewayException('Payment provider unavailable; retry later');
    }
  }
  async checkout(order: Purchase): Promise<string> {
    const raw = await this.request('/checkout/preferences', {
      external_reference: order.id,
      items: [
        {
          id: order.id,
          title: `${order.credits} image credits`,
          quantity: 1,
          currency_id: order.currency,
          unit_price: order.price,
        },
      ],
      notification_url: `${this.config.get('PUBLIC_BASE_URL', { infer: true })}/v1/payments/webhook`,
    });
    const parsed = z
      .object({ init_point: z.url(), sandbox_init_point: z.url().optional() })
      .safeParse(raw);
    if (!parsed.success) throw new BadGatewayException('Invalid checkout response');
    const url = this.config.get('MP_LIVE_MODE', { infer: true })
      ? parsed.data.init_point
      : parsed.data.sandbox_init_point;
    if (!url) throw new BadGatewayException('Sandbox checkout URL missing');
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      !/(^|\.)mercadopago\.(com|com\.ar|com\.br|com\.co|com\.mx|com\.pe|com\.uy|cl)$/.test(
        target.hostname,
      )
    )
      throw new BadGatewayException('Invalid checkout host');
    return url;
  }
  verifyNotification(dataId: unknown, signature: unknown, requestId: unknown): string {
    const secret = this.config.get('MP_WEBHOOK_SECRET', { infer: true });
    if (!secret) throw new ServiceUnavailableException('Payments are not configured');
    if (
      typeof dataId !== 'string' ||
      !/^\d{1,30}$/.test(dataId) ||
      typeof signature !== 'string' ||
      signature.length > 512 ||
      typeof requestId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
    )
      throw new UnauthorizedException('Invalid payment signature');
    const parts = signature.split(',').map((part) => part.trim().split('='));
    const timestamps = parts.filter(([name]) => name === 'ts');
    const hashes = parts.filter(([name]) => name === 'v1');
    if (timestamps.length !== 1 || hashes.length !== 1)
      throw new UnauthorizedException('Invalid payment signature');
    const ts = timestamps[0][1];
    const hash = hashes[0][1];
    if (!/^\d{10,13}$/.test(ts ?? '') || !/^[a-fA-F0-9]{64}$/.test(hash ?? ''))
      throw new UnauthorizedException('Invalid payment signature');
    const expected = createHmac('sha256', secret)
      .update(`id:${dataId};request-id:${requestId};ts:${ts};`)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(hash, 'hex')))
      throw new UnauthorizedException('Invalid payment signature');
    // Retries may be delayed. Replay safety comes from querying current state + unique payment ids.
    return dataId;
  }
  async payment(id: string): Promise<VerifiedPayment> {
    const raw = await this.request(`/v1/payments/${encodeURIComponent(id)}`);
    const parsed = z
      .object({
        id: z.union([z.number().int().safe(), z.string().regex(/^\d+$/)]),
        external_reference: z.string(),
        status: z.string(),
        transaction_amount: z.number().finite().nonnegative(),
        currency_id: z.string(),
        collector_id: z.union([z.number().int().safe(), z.string()]),
        live_mode: z.boolean(),
        transaction_amount_refunded: z.number().nonnegative().optional(),
      })
      .safeParse(raw);
    if (!parsed.success || String(parsed.data.id) !== id)
      throw new BadGatewayException('Invalid payment response');
    const p = parsed.data;
    return {
      id,
      orderId: p.external_reference,
      status: p.status,
      amount: p.transaction_amount,
      currency: p.currency_id,
      collectorId: String(p.collector_id),
      live: p.live_mode,
      refunded: p.transaction_amount_refunded ?? 0,
    };
  }
}
