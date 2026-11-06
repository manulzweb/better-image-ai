import { Semaphore } from './semaphore';

it('bounds concurrent work and releases slots after failure', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) =>
      semaphore.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        if (i === 0) throw new Error('failed');
        return i;
      }),
    ),
  );
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(11);
});
