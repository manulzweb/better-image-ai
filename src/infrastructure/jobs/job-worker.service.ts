import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JOBS, JobsPort, JobWork } from '../../application/ports/jobs.port';
import { OptimizeImageUseCase } from '../../application/use-cases/optimize-image.use-case';
import { EnvConfig } from '../../config/config.schema';

@Injectable()
export class JobWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobWorker.name);
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private readonly active = new Set<Promise<void>>();
  private ticking = false;
  constructor(
    @Inject(JOBS) private readonly jobs: JobsPort,
    private readonly optimize: OptimizeImageUseCase,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}
  async onApplicationBootstrap() {
    await this.jobs.recover();
    await this.jobs.expire();
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
    this.timer.unref();
  }
  async tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      await this.jobs.expire();
      while (!this.stopping && this.active.size < this.config.get('JOB_WORKERS', { infer: true })) {
        const work = await this.jobs.claim();
        if (!work) break;
        const task = this.process(work).catch((error) =>
          this.logger.error(
            'Worker persistence failed; recovery required',
            error instanceof Error ? error.stack : undefined,
          ),
        );
        this.active.add(task);
        void task.finally(() => this.active.delete(task));
      }
    } catch (error) {
      this.logger.error('Queue polling failed', error instanceof Error ? error.stack : undefined);
    } finally {
      this.ticking = false;
    }
  }
  private async process(work: JobWork) {
    let hash: string | undefined;
    let code: string | undefined;
    try {
      if (work.version !== this.optimize.cacheVersion) {
        code = 'OPTIMIZER_VERSION_CHANGED';
      } else {
        const result = await this.optimize.execute({
          buffer: work.buffer,
          mimeType: work.mimeType,
          tenantId: work.tenant,
          prompt: work.prompt,
          reservationId: work.reservation,
        });
        hash = result.hash;
      }
    } catch {
      this.logger.warn(`Job item failed job=${work.jobId} index=${work.index}`);
      code = 'PROCESSING_FAILED';
    }
    for (;;) {
      try {
        await this.jobs.finish(work, hash, code);
        return;
      } catch (error) {
        this.logger.error(
          'Unable to persist job outcome; retrying',
          error instanceof Error ? error.stack : undefined,
        );
        if (this.stopping) return; // startup recovery reconciles the durable reservation
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  async beforeApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // Repositories close in onApplicationShutdown, after workers drain.
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.allSettled([...this.active]);
  }
  async onModuleDestroy() {
    await this.beforeApplicationShutdown();
  }
}
