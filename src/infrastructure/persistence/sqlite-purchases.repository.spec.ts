import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvConfig } from '../../config/config.schema';
import { VerifiedPayment } from '../../application/ports/payments.port';
import { SqliteCommerceRepository } from './sqlite-commerce.repository';
import { SqlitePurchasesRepository } from './sqlite-purchases.repository';

describe('Purchase settlement', () => {
  let dir: string;
  let commerce: SqliteCommerceRepository;
  let orders: SqlitePurchasesRepository;
  let payment: VerifiedPayment;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'purchases-'));
    const config = new ConfigService({
      DB_PATH: join(dir, 'db'),
      MP_ACCESS_TOKEN: 'test',
      MP_COLLECTOR_ID: '55',
      MP_LIVE_MODE: false,
      MP_CURRENCY: 'COP',
      CREDIT_PACK_SIZE: 100,
      CREDIT_PACK_PRICE: 50000,
    }) as ConfigService<EnvConfig, true>;
    commerce = new SqliteCommerceRepository(config);
    orders = new SqlitePurchasesRepository(commerce, config);
    const order = await orders.create('shop', 'checkout-1');
    payment = {
      id: '123',
      orderId: order.id,
      status: 'approved',
      amount: 50000,
      currency: 'COP',
      collectorId: '55',
      live: false,
      refunded: 0,
    };
  });
  afterEach(() => {
    commerce.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  it('credits exactly once under concurrent and repeated notifications', async () => {
    await Promise.all([orders.apply(payment), orders.apply(payment), orders.apply(payment)]);
    expect(await commerce.balance('shop')).toEqual({ available: 100, reserved: 0 });
    expect((await orders.get('shop', payment.orderId)).status).toBe('paid');
    expect((await orders.create('shop', 'checkout-1')).id).toBe(payment.orderId);
    await expect(orders.get('other', payment.orderId)).rejects.toThrow('not found');
  });
  it.each([{ amount: 1 }, { currency: 'USD' }, { collectorId: 'attacker' }, { live: true }])(
    'rejects mismatched payment %j',
    async (change) => {
      await expect(orders.apply({ ...payment, ...change })).rejects.toThrow('does not match');
      expect((await commerce.balance('shop')).available).toBe(0);
    },
  );
  it('does not credit pending payments and quarantines refunds without restoring credits on stale approval', async () => {
    await orders.apply({ ...payment, status: 'pending' });
    expect((await commerce.balance('shop')).available).toBe(0);
    await orders.apply(payment);
    await orders.apply({ ...payment, status: 'refunded', refunded: 50000 });
    await orders.apply(payment);
    expect((await commerce.balance('shop')).available).toBe(100);
    expect((await orders.get('shop', payment.orderId)).status).toBe('review');
    await expect(commerce.reserve('shop', 'one')).rejects.toThrow('review');
  });
  it('records multiple payments for one purchase for review without double credits', async () => {
    await orders.apply(payment);
    await orders.apply({ ...payment, id: '456' });
    expect((await commerce.balance('shop')).available).toBe(100);
    expect(commerce.db.prepare('SELECT count(*) AS n FROM payment_incidents').get()!.n).toBe(1);
    await expect(commerce.reserve('shop', 'one')).rejects.toThrow('review');
  });
});
