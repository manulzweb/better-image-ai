import { PersistenceLock } from './persistence-lock';

it('does not allow a GC snapshot between file write and database commit', async () => {
  const lock = new PersistenceLock();
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const events: string[] = [];
  const commit = lock.run(async () => {
    events.push('file');
    await paused;
    events.push('row');
  });
  const gc = lock.run(async () => {
    events.push('snapshot');
  });
  await Promise.resolve();
  expect(events).toEqual(['file']);
  resume();
  await Promise.all([commit, gc]);
  expect(events).toEqual(['file', 'row', 'snapshot']);
});
