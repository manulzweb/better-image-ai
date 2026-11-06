import { WorkflowException } from '../../domain/exceptions/workflow.exception';
import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayPort,
  PURCHASES,
  PurchasesPort,
} from '../ports/payments.port';
import { KeyedLock } from '../services/keyed-lock';
@Injectable()
export class PaymentsUseCase {
  private readonly lock = new KeyedLock();
  constructor(
    @Inject(PURCHASES) private readonly purchases: PurchasesPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
  ) {}
  async checkout(tenant: string, key: string) {
    return this.lock.runExclusive(`${tenant}:${key}`, async () => {
      const order = await this.purchases.create(tenant, key);
      if (!order.checkoutUrl && order.status === 'pending')
        await this.purchases.checkout(order.id, await this.gateway.checkout(order));
      return this.purchases.get(tenant, order.id);
    });
  }
  async reconcile(tenant: string, orderId: string, paymentId: string) {
    await this.purchases.get(tenant, orderId);
    await this.lock.runExclusive(`payment:${paymentId}`, async () => {
      const payment = await this.gateway.payment(paymentId);
      if (payment.orderId !== orderId)
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Payment belongs to a different purchase');
      await this.purchases.apply(payment);
    });
    return this.purchases.get(tenant, orderId);
  }
  async notification(dataId: unknown, signature: unknown, requestId: unknown) {
    const id = this.gateway.verifyNotification(dataId, signature, requestId);
    // Serialize notifications for the same payment, including state reads.
    await this.lock.runExclusive(`payment:${id}`, async () =>
      this.purchases.apply(await this.gateway.payment(id)),
    );
  }
}
