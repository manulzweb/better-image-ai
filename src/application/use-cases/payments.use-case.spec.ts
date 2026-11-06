import { PaymentsUseCase } from './payments.use-case';
import {
  PurchasesPort,
  PaymentGatewayPort,
  Purchase,
  VerifiedPayment,
} from '../ports/payments.port';

describe('Payment orchestration', () => {
  let orders: jest.Mocked<PurchasesPort>;
  let gateway: jest.Mocked<PaymentGatewayPort>;
  let service: PaymentsUseCase;
  const order: Purchase = {
    id: 'order',
    tenant: 'shop',
    credits: 100,
    price: 50,
    currency: 'COP',
    status: 'pending',
    checkoutUrl: null,
  };
  const payment: VerifiedPayment = {
    id: '123',
    orderId: 'order',
    amount: 50,
    currency: 'COP',
    collectorId: '55',
    live: false,
    refunded: 0,
    status: 'approved',
  };
  beforeEach(() => {
    let saved = { ...order };
    orders = {
      create: jest.fn().mockImplementation(async () => saved),
      get: jest.fn().mockImplementation(async () => saved),
      checkout: jest.fn().mockImplementation(async (id, url) => {
        saved = { ...saved, checkoutUrl: url };
      }),
      apply: jest.fn(),
    };
    gateway = {
      checkout: jest.fn().mockResolvedValue('https://www.mercadopago.com/checkout'),
      payment: jest.fn().mockResolvedValue(payment),
      verifyNotification: jest.fn().mockReturnValue('123'),
    };
    service = new PaymentsUseCase(orders, gateway);
  });
  it('creates only one preference for simultaneous retries', async () => {
    await Promise.all([service.checkout('shop', 'key'), service.checkout('shop', 'key')]);
    expect(gateway.checkout).toHaveBeenCalledTimes(1);
  });
  it('checks ownership before allowing reconciliation', async () => {
    orders.get.mockRejectedValue(new Error('not found'));
    await expect(service.reconcile('other', 'order', '123')).rejects.toThrow('not found');
    expect(gateway.payment).not.toHaveBeenCalled();
  });
  it('does not reconcile a payment belonging to another order', async () => {
    gateway.payment.mockResolvedValue({ ...payment, orderId: 'someone-else' });
    await expect(service.reconcile('shop', 'order', '123')).rejects.toThrow('different purchase');
    expect(orders.apply).not.toHaveBeenCalled();
  });
  it('uses provider state during reconciliation and refuses invalid webhooks before querying', async () => {
    await service.reconcile('shop', 'order', '123');
    expect(orders.apply).toHaveBeenCalledWith(payment);
    gateway.verifyNotification.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    gateway.payment.mockClear();
    await expect(service.notification('123', 'invalid', 'request')).rejects.toThrow(
      'invalid signature',
    );
    expect(gateway.payment).not.toHaveBeenCalled();
  });
});
