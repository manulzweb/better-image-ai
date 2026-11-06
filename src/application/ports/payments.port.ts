export const PURCHASES = Symbol('PURCHASES');
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
export interface Purchase {
  id: string;
  tenant: string;
  credits: number;
  price: number;
  currency: string;
  status: string;
  checkoutUrl: string | null;
}
export interface VerifiedPayment {
  id: string;
  orderId: string;
  status: string;
  amount: number;
  currency: string;
  collectorId: string;
  live: boolean;
  refunded: number;
}
export interface PurchasesPort {
  create(tenant: string, key: string): Promise<Purchase>;
  get(tenant: string, id: string): Promise<Purchase>;
  checkout(id: string, url: string): Promise<void>;
  apply(payment: VerifiedPayment): Promise<void>;
}
export interface PaymentGatewayPort {
  checkout(order: Purchase): Promise<string>;
  verifyNotification(dataId: unknown, signature: unknown, requestId: unknown): string;
  payment(id: string): Promise<VerifiedPayment>;
}
