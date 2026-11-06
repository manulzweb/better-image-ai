import { Injectable } from '@nestjs/common';
import { KeyedLock } from './keyed-lock';

/** Serialize commits and GC snapshots in this single-process deployment. */
@Injectable()
export class PersistenceLock {
  private readonly lock = new KeyedLock();
  run<T>(work: () => Promise<T>): Promise<T> {
    return this.lock.runExclusive('persistence', work);
  }
}
