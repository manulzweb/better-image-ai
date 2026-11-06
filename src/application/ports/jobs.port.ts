export const JOBS = Symbol('JOBS');
export interface JobInput {
  buffer: Buffer;
  mimeType: string;
  digest: string;
}
export interface JobView {
  id: string;
  status: string;
  expected: number;
  uploaded: number;
  completed: number;
  failed: number;
  charged: number;
  items: { index: number; status: string; hash: string | null; code: string | null }[];
}
export interface JobWork {
  jobId: string;
  index: number;
  tenant: string;
  prompt?: string;
  version: string;
  buffer: Buffer;
  mimeType: string;
  reservation: string;
}
export interface JobsPort {
  create(
    tenant: string,
    key: string,
    count: number,
    prompt: string | undefined,
    version: string,
  ): Promise<JobView>;
  append(tenant: string, id: string, key: string, inputs: JobInput[]): Promise<JobView>;
  submit(tenant: string, id: string): Promise<JobView>;
  cancel(tenant: string, id: string): Promise<JobView>;
  get(tenant: string, id: string): Promise<JobView>;
  claim(): Promise<JobWork | null>;
  finish(work: JobWork, hash?: string, code?: string): Promise<void>;
  recover(): Promise<void>;
  expire(): Promise<void>;
}
