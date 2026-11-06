import { ConfigService } from '@nestjs/config';
import { JobsPort, JobWork } from '../../application/ports/jobs.port';
import { OptimizeImageUseCase } from '../../application/use-cases/optimize-image.use-case';
import { EnvConfig } from '../../config/config.schema';
import { JobWorker } from './job-worker.service';

const work: JobWork = {
  jobId: 'job',
  index: 0,
  tenant: 'shop',
  version: 'v1',
  buffer: Buffer.from('test'),
  mimeType: 'image/png',
  reservation: 'job:0',
};
describe('Persistent job worker', () => {
  let jobs: jest.Mocked<JobsPort>;
  let optimize: { cacheVersion: string; execute: jest.Mock };
  let worker: JobWorker;
  beforeEach(() => {
    jobs = {
      create: jest.fn(),
      append: jest.fn(),
      submit: jest.fn(),
      cancel: jest.fn(),
      get: jest.fn(),
      claim: jest.fn().mockResolvedValue(null),
      finish: jest.fn().mockResolvedValue(undefined),
      recover: jest.fn(),
      expire: jest.fn(),
    };
    optimize = { cacheVersion: 'v1', execute: jest.fn().mockResolvedValue({ hash: 'result' }) };
    worker = new JobWorker(
      jobs,
      optimize as unknown as OptimizeImageUseCase,
      new ConfigService({ JOB_WORKERS: 2 }) as ConfigService<EnvConfig, true>,
    );
  });
  it('fails incompatible queued versions without calling the provider', async () => {
    jobs.claim.mockResolvedValueOnce({ ...work, version: 'old' });
    await worker.tick();
    await worker.beforeApplicationShutdown();
    expect(optimize.execute).not.toHaveBeenCalled();
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      'OPTIMIZER_VERSION_CHANGED',
    );
  });
  it('settles failed provider work so reservations are released', async () => {
    jobs.claim.mockResolvedValueOnce(work);
    optimize.execute.mockRejectedValue(new Error('provider timeout'));
    await worker.tick();
    await worker.beforeApplicationShutdown();
    expect(jobs.finish).toHaveBeenCalledWith(work, undefined, 'PROCESSING_FAILED');
  });
  it('drains in-flight work before database shutdown', async () => {
    let complete!: (value: { hash: string }) => void;
    optimize.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    jobs.claim.mockResolvedValueOnce(work);
    await worker.tick();
    let drained = false;
    const shutdown = worker.beforeApplicationShutdown().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    complete({ hash: 'result' });
    await shutdown;
    expect(jobs.finish).toHaveBeenCalledWith(work, 'result', undefined);
  });
});
