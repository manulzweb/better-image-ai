import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { EnvConfig } from '../../config/config.schema';
import { CreditsPort } from '../../application/ports/credits.port';
import { JobInput, JobsPort, JobView, JobWork } from '../../application/ports/jobs.port';
import { ProcessedImage } from '../../domain/entities/processed-image';
import { WorkflowException } from '../../domain/exceptions/workflow.exception';

interface JobRow {
  id: string;
  tenant: string;
  expected: number;
  status: string;
  prompt: string | null;
  version: string;
  fingerprint: string;
  created: number;
}
interface Reservation {
  tenant: string;
  state: string;
}

@Injectable()
export class SqliteCommerceRepository implements CreditsPort, JobsPort, OnApplicationShutdown {
  readonly db: DatabaseSync;
  private readonly maxPending: number;
  private readonly uploadTtl: number;
  constructor(config: ConfigService<EnvConfig, true>) {
    const path = resolve(config.get('DB_PATH', { infer: true }));
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.maxPending = config.get('MAX_PENDING_IMAGES', { infer: true }) ?? 1000;
    this.uploadTtl = config.get('JOB_UPLOAD_TTL_MINUTES', { infer: true }) ?? 60;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocked_accounts (tenant TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_accounts (tenant TEXT PRIMARY KEY, available INTEGER NOT NULL DEFAULT 0 CHECK(available >= 0));
      CREATE TABLE IF NOT EXISTS credit_reservations (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('held','captured','released')), created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reservations_tenant ON credit_reservations(tenant, state);
      CREATE TABLE IF NOT EXISTS credit_ledger (reference TEXT PRIMARY KEY, tenant TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, idem_key TEXT NOT NULL, fingerprint TEXT NOT NULL, expected INTEGER NOT NULL, prompt TEXT, version TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(tenant, idem_key));
      CREATE TABLE IF NOT EXISTS job_items (job_id TEXT NOT NULL REFERENCES jobs(id), position INTEGER NOT NULL, input BLOB, mime TEXT NOT NULL, status TEXT NOT NULL, hash TEXT, code TEXT, PRIMARY KEY(job_id, position));
      CREATE INDEX IF NOT EXISTS items_queue ON job_items(status, job_id);
      CREATE TABLE IF NOT EXISTS job_uploads (job_id TEXT NOT NULL REFERENCES jobs(id), idem_key TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(job_id, idem_key));
    `);
  }
  onApplicationShutdown() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    return this.tx(work);
  }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private event(reference: string, tenant: string, delta: number, kind: string) {
    this.db
      .prepare('INSERT INTO credit_ledger VALUES (?, ?, ?, ?, ?)')
      .run(reference, tenant, delta, kind, Date.now());
  }
  private hold(tenant: string, id: string) {
    this.assertActive(tenant);
    const old = this.db
      .prepare('SELECT tenant,state FROM credit_reservations WHERE id=?')
      .get(id) as unknown as Reservation | undefined;
    if (old) {
      if (old.tenant !== tenant || old.state !== 'held')
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Reservation is not available');
      return;
    }
    const changed = this.db
      .prepare('UPDATE credit_accounts SET available=available-1 WHERE tenant=? AND available>=1')
      .run(tenant);
    if (!changed.changes)
      throw new WorkflowException('INSUFFICIENT_CREDITS', 'Insufficient available credits');
    this.db
      .prepare("INSERT INTO credit_reservations VALUES (?, ?, 'held', ?)")
      .run(id, tenant, Date.now());
    this.event(`reserve:${id}`, tenant, -1, 'reserve');
  }
  private assertActive(tenant: string) {
    if (this.db.prepare('SELECT 1 FROM blocked_accounts WHERE tenant=?').get(tenant))
      throw new WorkflowException('WORKFLOW_CONFLICT', 'Account requires payment review');
  }
  async reserve(tenant: string, id: string) {
    this.tx(() => this.hold(tenant, id));
  }
  private releaseHeld(id: string) {
    const row = this.db
      .prepare('SELECT tenant,state FROM credit_reservations WHERE id=?')
      .get(id) as unknown as Reservation | undefined;
    if (!row || row.state !== 'held') return;
    this.db.prepare("UPDATE credit_reservations SET state='released' WHERE id=?").run(id);
    this.db
      .prepare('UPDATE credit_accounts SET available=available+1 WHERE tenant=?')
      .run(row.tenant);
    this.event(`release:${id}`, row.tenant, 1, 'release');
  }
  private recordResult(reservation: string, hash: string) {
    this.db
      .prepare(
        "UPDATE job_items SET hash=? WHERE (job_id || ':' || position)=? AND status='running'",
      )
      .run(hash, reservation);
  }
  async release(id: string, resultHash?: string) {
    this.tx(() => {
      this.releaseHeld(id);
      if (resultHash) this.recordResult(id, resultHash);
    });
  }
  async persist(image: ProcessedImage, reservation: string) {
    this.tx(() => {
      this.assertActive(image.tenantId ?? 'legacy');
      const row = this.db
        .prepare('SELECT tenant,state FROM credit_reservations WHERE id=?')
        .get(reservation) as unknown as Reservation | undefined;
      if (!row || row.tenant !== image.tenantId || row.state !== 'held')
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Invalid credit reservation');
      const saved = this.db
        .prepare(
          'INSERT OR IGNORE INTO processed_images (hash,tenant_id,mime_type,size_bytes,strategy,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          image.hash,
          image.tenantId!,
          image.mimeType,
          image.sizeBytes,
          image.strategy,
          image.createdAt.toISOString(),
        );
      this.recordResult(reservation, image.hash);
      if (!saved.changes) {
        this.releaseHeld(reservation);
        return;
      }
      this.db
        .prepare("UPDATE credit_reservations SET state='captured' WHERE id=?")
        .run(reservation);
      this.event(`capture:${reservation}`, row.tenant, 0, 'capture');
    });
  }
  async balance(tenant: string) {
    const account = this.db
      .prepare('SELECT available FROM credit_accounts WHERE tenant=?')
      .get(tenant);
    const held = this.db
      .prepare("SELECT count(*) AS count FROM credit_reservations WHERE tenant=? AND state='held'")
      .get(tenant)!;
    return { available: Number(account?.available ?? 0), reserved: Number(held.count) };
  }
  async grant(tenant: string, amount: number, reference: string) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000)
      throw new WorkflowException('WORKFLOW_CONFLICT', 'Invalid credit amount');
    this.tx(() => this.grantInside(tenant, amount, reference));
  }
  grantInside(tenant: string, amount: number, reference: string) {
    const existing = this.db
      .prepare('SELECT tenant,delta FROM credit_ledger WHERE reference=?')
      .get(reference);
    if (existing) {
      if (existing.tenant !== tenant || existing.delta !== amount)
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Credit reference already used');
      return;
    }
    this.db
      .prepare(
        'INSERT INTO credit_accounts(tenant,available) VALUES (?,?) ON CONFLICT(tenant) DO UPDATE SET available=available+excluded.available',
      )
      .run(tenant, amount);
    this.event(reference, tenant, amount, 'grant');
  }
  private owned(tenant: string, id: string): JobRow {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id=? AND tenant=?')
      .get(id, tenant) as unknown as JobRow | undefined;
    if (!row) throw new WorkflowException('WORKFLOW_NOT_FOUND', 'Job not found');
    return row;
  }
  async create(
    tenant: string,
    key: string,
    count: number,
    prompt: string | undefined,
    version: string,
  ) {
    const fingerprint = JSON.stringify([count, prompt ?? null, version]);
    const id = this.tx(() => {
      const old = this.db
        .prepare('SELECT id,fingerprint FROM jobs WHERE tenant=? AND idem_key=?')
        .get(tenant, key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new WorkflowException(
            'WORKFLOW_CONFLICT',
            'Idempotency key used for a different job',
          );
        return String(old.id);
      }
      const pending = Number(
        this.db
          .prepare(
            "SELECT coalesce(sum(expected),0) AS total FROM jobs WHERE status IN ('uploading','queued','running')",
          )
          .get()!.total,
      );
      if (pending + count > this.maxPending)
        throw new WorkflowException('QUEUE_FULL', 'Queue capacity reached');
      const id = randomUUID();
      for (let i = 0; i < count; i++) this.hold(tenant, `${id}:${i}`);
      this.db
        .prepare("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,'uploading',?)")
        .run(id, tenant, key, fingerprint, count, prompt ?? null, version, Date.now());
      return id;
    });
    return this.get(tenant, id);
  }
  async append(tenant: string, id: string, key: string, inputs: JobInput[]) {
    this.tx(() => {
      const job = this.owned(tenant, id);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(inputs.map((i) => [i.digest, i.mimeType])))
        .digest('hex');
      const old = this.db
        .prepare('SELECT fingerprint FROM job_uploads WHERE job_id=? AND idem_key=?')
        .get(id, key);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new WorkflowException(
            'WORKFLOW_CONFLICT',
            'Idempotency key used for different files',
          );
        return;
      }
      const offset = Number(
        this.db.prepare('SELECT count(*) AS n FROM job_items WHERE job_id=?').get(id)!.n,
      );
      if (job.status !== 'uploading' || offset + inputs.length > job.expected)
        throw new WorkflowException('WORKFLOW_CONFLICT', 'Job cannot accept these files');
      inputs.forEach((input, i) =>
        this.db
          .prepare(
            "INSERT INTO job_items(job_id,position,input,mime,status) VALUES (?,?,?,?,'queued')",
          )
          .run(id, offset + i, input.buffer, input.mimeType),
      );
      this.db.prepare('INSERT INTO job_uploads VALUES (?,?,?)').run(id, key, fingerprint);
    });
    return this.get(tenant, id);
  }
  async submit(tenant: string, id: string) {
    this.tx(() => {
      const job = this.owned(tenant, id);
      if (job.status !== 'uploading') return;
      const count = Number(
        this.db.prepare('SELECT count(*) AS n FROM job_items WHERE job_id=?').get(id)!.n,
      );
      if (count !== job.expected)
        throw new WorkflowException(
          'WORKFLOW_CONFLICT',
          'Upload all expected files before submission',
        );
      this.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(id);
    });
    return this.get(tenant, id);
  }
  async cancel(tenant: string, id: string) {
    this.tx(() => {
      const job = this.owned(tenant, id);
      if (['completed', 'cancelled', 'expired'].includes(job.status)) return;
      this.cancelInside(job, 'cancelled');
    });
    return this.get(tenant, id);
  }
  private cancelInside(job: JobRow, status: string) {
    this.db.prepare('UPDATE jobs SET status=? WHERE id=?').run(status, job.id);
    for (let i = 0; i < job.expected; i++) {
      const item = this.db
        .prepare('SELECT status FROM job_items WHERE job_id=? AND position=?')
        .get(job.id, i);
      if (item?.status !== 'running') this.releaseHeld(`${job.id}:${i}`);
    }
    this.db
      .prepare(
        "UPDATE job_items SET status='cancelled',input=NULL WHERE job_id=? AND status='queued'",
      )
      .run(job.id);
  }
  async get(tenant: string, id: string): Promise<JobView> {
    const job = this.owned(tenant, id);
    const items = this.db
      .prepare(
        'SELECT position AS "index",status,hash,code FROM job_items WHERE job_id=? ORDER BY position',
      )
      .all(id) as unknown as JobView['items'];
    const charged = Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM credit_reservations WHERE id GLOB ? AND state='captured'",
        )
        .get(`${id}:*`)!.n,
    );
    return {
      id,
      status: job.status,
      expected: job.expected,
      uploaded: items.length,
      completed: items.filter((i) => i.status === 'succeeded').length,
      failed: items.filter((i) => i.status === 'failed').length,
      charged,
      items,
    };
  }
  async claim(): Promise<JobWork | null> {
    return this.tx(() => {
      const row = this.db
        .prepare(
          "SELECT j.id,j.tenant,j.prompt,j.version,i.position,i.input,i.mime FROM jobs j JOIN job_items i ON i.job_id=j.id WHERE j.status IN ('queued','running') AND i.status='queued' ORDER BY j.created,i.position LIMIT 1",
        )
        .get();
      if (!row) return null;
      this.db
        .prepare("UPDATE job_items SET status='running' WHERE job_id=? AND position=?")
        .run(row.id, row.position);
      this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(row.id);
      return {
        jobId: String(row.id),
        index: Number(row.position),
        tenant: String(row.tenant),
        prompt: row.prompt === null ? undefined : String(row.prompt),
        version: String(row.version),
        buffer: Buffer.from(row.input as Uint8Array),
        mimeType: String(row.mime),
        reservation: `${row.id}:${row.position}`,
      };
    });
  }
  async finish(work: JobWork, hash?: string, code?: string) {
    this.tx(() => {
      const item = this.db
        .prepare('SELECT status,hash FROM job_items WHERE job_id=? AND position=?')
        .get(work.jobId, work.index);
      if (item?.status !== 'running') return;
      hash = hash ?? (item.hash ? String(item.hash) : undefined);
      this.releaseHeld(work.reservation); // captured credits are never released
      this.db
        .prepare(
          'UPDATE job_items SET status=?,hash=?,code=?,input=NULL WHERE job_id=? AND position=?',
        )
        .run(
          hash ? 'succeeded' : 'failed',
          hash ?? null,
          hash ? null : (code ?? null),
          work.jobId,
          work.index,
        );
      const remaining = this.db
        .prepare(
          "SELECT 1 FROM job_items WHERE job_id=? AND status IN ('queued','running') LIMIT 1",
        )
        .get(work.jobId);
      if (!remaining)
        this.db
          .prepare("UPDATE jobs SET status='completed' WHERE id=? AND status='running'")
          .run(work.jobId);
    });
  }
  async recover() {
    this.tx(() => {
      this.db.exec(
        "UPDATE job_items SET status='succeeded',input=NULL WHERE status='running' AND hash IS NOT NULL",
      );
      // Single-process deployment: invoked once before starting workers.
      this.db
        .prepare(
          "UPDATE job_items SET status='queued' WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE status='running')",
        )
        .run();
      const cancelled = this.db
        .prepare(
          "SELECT job_id,position FROM job_items WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE status='cancelled')",
        )
        .all();
      for (const row of cancelled) {
        this.releaseHeld(`${row.job_id}:${row.position}`);
        this.db
          .prepare(
            "UPDATE job_items SET status='cancelled',input=NULL WHERE job_id=? AND position=?",
          )
          .run(row.job_id, row.position);
      }
      // A failure may have released its reservation before the process died.
      this.db.exec(
        "UPDATE job_items SET status='failed',code='INTERRUPTED',input=NULL WHERE status='queued' AND (job_id || ':' || position) IN (SELECT id FROM credit_reservations WHERE state='released')",
      );
      this.db.exec(
        "UPDATE jobs SET status='completed' WHERE status='running' AND NOT EXISTS (SELECT 1 FROM job_items i WHERE i.job_id=jobs.id AND i.status IN ('queued','running'))",
      );
      // Synchronous requests cannot resume, so release only their outstanding holds.
      const abandoned = this.db
        .prepare("SELECT id FROM credit_reservations WHERE state='held' AND id LIKE 'sync:%'")
        .all();
      for (const row of abandoned) this.releaseHeld(String(row.id));
    });
  }
  async expire() {
    this.tx(() => {
      const jobs = this.db
        .prepare("SELECT * FROM jobs WHERE status='uploading' AND created<?")
        .all(Date.now() - this.uploadTtl * 60_000) as unknown as JobRow[];
      for (const job of jobs) this.cancelInside(job, 'expired');
    });
  }
}
