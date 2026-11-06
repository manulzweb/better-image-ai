import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PurchasesPort, Purchase, VerifiedPayment } from '../../application/ports/payments.port';
import { EnvConfig } from '../../config/config.schema';
import { WorkflowException } from '../../domain/exceptions/workflow.exception';
import { SqliteCommerceRepository } from './sqlite-commerce.repository';

@Injectable()
export class SqlitePurchasesRepository implements PurchasesPort {
  constructor(
    private readonly commerce: SqliteCommerceRepository,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {
    commerce.db.exec(`CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, idem_key TEXT NOT NULL, credits INTEGER NOT NULL,
      price INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, checkout_url TEXT,
      payment_id TEXT UNIQUE, created INTEGER NOT NULL, UNIQUE(tenant,idem_key));
      CREATE TABLE IF NOT EXISTS payment_incidents (payment_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blocked_accounts (tenant TEXT PRIMARY KEY, reason TEXT NOT NULL);
    `);
  }
  private view(row: Record<string, unknown>): Purchase {
    return {
      id: String(row.id),
      tenant: String(row.tenant),
      credits: Number(row.credits),
      price: Number(row.price),
      currency: String(row.currency),
      status: String(row.status),
      checkoutUrl: row.checkout_url === null ? null : String(row.checkout_url),
    };
  }
  async create(tenant: string, key: string): Promise<Purchase> {
    if (!this.config.get('MP_ACCESS_TOKEN', { infer: true }))
      throw new ServiceUnavailableException('Payments are not configured');
    return this.commerce.transaction(() => {
      const old = this.commerce.db
        .prepare('SELECT * FROM purchases WHERE tenant=? AND idem_key=?')
        .get(tenant, key);
      if (old) return this.view(old);
      const id = randomUUID();
      this.commerce.db
        .prepare(
          "INSERT INTO purchases(id,tenant,idem_key,credits,price,currency,status,created) VALUES (?,?,?,?,?,?,'pending',?)",
        )
        .run(
          id,
          tenant,
          key,
          this.config.get('CREDIT_PACK_SIZE', { infer: true })!,
          this.config.get('CREDIT_PACK_PRICE', { infer: true })!,
          this.config.get('MP_CURRENCY', { infer: true })!,
          Date.now(),
        );
      return this.view(this.commerce.db.prepare('SELECT * FROM purchases WHERE id=?').get(id)!);
    });
  }
  async get(tenant: string, id: string): Promise<Purchase> {
    const row = this.commerce.db
      .prepare('SELECT * FROM purchases WHERE tenant=? AND id=?')
      .get(tenant, id);
    if (!row) throw new WorkflowException('WORKFLOW_NOT_FOUND', 'Purchase not found');
    return this.view(row);
  }
  async checkout(id: string, url: string) {
    this.commerce.db.prepare('UPDATE purchases SET checkout_url=? WHERE id=?').run(url, id);
  }
  async apply(payment: VerifiedPayment) {
    this.commerce.transaction(() => {
      const row = this.commerce.db
        .prepare('SELECT * FROM purchases WHERE id=?')
        .get(payment.orderId);
      if (!row) return; // Other merchant products may share a webhook.
      if (
        payment.collectorId !== this.config.get('MP_COLLECTOR_ID', { infer: true }) ||
        payment.live !== this.config.get('MP_LIVE_MODE', { infer: true }) ||
        payment.amount !== row.price ||
        payment.currency !== row.currency
      )
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Payment does not match purchase');
      if (
        payment.status === 'refunded' ||
        payment.status === 'charged_back' ||
        payment.refunded > 0
      ) {
        this.incident(
          payment,
          String(row.tenant),
          'Payment reversed; manual credit reconciliation required',
        );
        this.commerce.db.prepare("UPDATE purchases SET status='review' WHERE id=?").run(row.id);
        return;
      }
      if (payment.status !== 'approved' || row.status === 'review') return;
      if (row.payment_id) {
        if (String(row.payment_id) !== payment.id)
          this.incident(
            payment,
            String(row.tenant),
            'Multiple payments for one purchase; refund review required',
          );
        return;
      }
      const previous = this.commerce.db
        .prepare('SELECT id FROM purchases WHERE payment_id=?')
        .get(payment.id);
      if (previous) throw new WorkflowException('WORKFLOW_CONFLICT', 'Payment already attributed');
      this.commerce.grantInside(String(row.tenant), Number(row.credits), `mp:${payment.id}`);
      this.commerce.db
        .prepare("UPDATE purchases SET status='paid',payment_id=? WHERE id=?")
        .run(payment.id, row.id);
    });
  }
  private incident(payment: VerifiedPayment, tenant: string, reason: string) {
    this.commerce.db
      .prepare('INSERT OR IGNORE INTO payment_incidents VALUES (?,?,?,?)')
      .run(payment.id, tenant, reason, Date.now());
    this.commerce.db
      .prepare('INSERT OR IGNORE INTO blocked_accounts VALUES (?,?)')
      .run(tenant, reason);
  }
}
