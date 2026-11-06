import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { MercadoPagoAdapter } from './mercado-pago.adapter';
import { EnvConfig } from '../../config/config.schema';
const secret = 'test-webhook-secret';
const signature = (id = '123') =>
  `ts=1781009491,v1=${createHmac('sha256', secret).update(`id:${id};request-id:request-1;ts:1781009491;`).digest('hex')}`;
describe('Mercado Pago adapter', () => {
  let adapter: MercadoPagoAdapter;
  beforeEach(() => {
    adapter = new MercadoPagoAdapter(
      new ConfigService({
        MP_WEBHOOK_SECRET: secret,
        MP_ACCESS_TOKEN: 'token',
        MP_LIVE_MODE: false,
        PUBLIC_BASE_URL: 'https://api.example.com',
      }) as ConfigService<EnvConfig, true>,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it('validates signatures using the signed resource id and rejects ambiguous headers', () => {
    expect(adapter.verifyNotification('123', signature(), 'request-1')).toBe('123');
    expect(() => adapter.verifyNotification('124', signature(), 'request-1')).toThrow();
    expect(() => adapter.verifyNotification('123', signature(), 'other')).toThrow();
    expect(() =>
      adapter.verifyNotification('123', `${signature()},ts=1781009491`, 'request-1'),
    ).toThrow();
    expect(() => adapter.verifyNotification(['123'], signature(), 'request-1')).toThrow();
    expect(() => adapter.verifyNotification('123', 'v1=invalid', 'request-1')).toThrow();
  });
  it('sends the server-controlled order price and reference to Checkout Pro', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          init_point: 'https://www.mercadopago.com.co/checkout/1',
          sandbox_init_point: 'https://sandbox.mercadopago.com.co/checkout/1',
        }),
      ),
    );
    const url = await adapter.checkout({
      id: 'order',
      tenant: 'shop',
      credits: 100,
      price: 50000,
      currency: 'COP',
      status: 'pending',
      checkoutUrl: null,
    });
    expect(url).toContain('sandbox');
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]!.body));
    expect(payload.external_reference).toBe('order');
    expect(payload.items[0]).toMatchObject({ quantity: 1, unit_price: 50000, currency_id: 'COP' });
    expect(payload.notification_url).toBe('https://api.example.com/v1/payments/webhook');
  });
  it('fetches payment state and rejects a mismatched payment id', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: 123,
            external_reference: 'order',
            status: 'approved',
            transaction_amount: 50000,
            currency_id: 'COP',
            collector_id: 55,
            live_mode: false,
          }),
        ),
    );
    expect(await adapter.payment('123')).toMatchObject({
      id: '123',
      orderId: 'order',
      amount: 50000,
      collectorId: '55',
      live: false,
    });
    await expect(adapter.payment('124')).rejects.toThrow('Invalid payment response');
  });
  it('does not leak provider responses or credentials when the API fails', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('sensitive response', { status: 500 }));
    await expect(adapter.payment('123')).rejects.toThrow('Payment provider unavailable');
  });
});
