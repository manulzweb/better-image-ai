import { KeyedLock } from './keyed-lock';

describe('KeyedLock', () => {
  it('serializa tareas con la misma clave', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];

    const first = lock.runExclusive('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first');
    });
    const second = lock.runExclusive('k', async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('no bloquea claves distintas', async () => {
    const lock = new KeyedLock();
    let parallel = 0;
    let maxParallel = 0;

    const task = async (): Promise<void> => {
      parallel += 1;
      maxParallel = Math.max(maxParallel, parallel);
      await new Promise((resolve) => setTimeout(resolve, 5));
      parallel -= 1;
    };

    await Promise.all([lock.runExclusive('a', task), lock.runExclusive('b', task)]);
    expect(maxParallel).toBeGreaterThan(1);
  });

  it('libera la clave aunque la tarea lance error', async () => {
    const lock = new KeyedLock();
    await expect(lock.runExclusive('k', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    const result = await lock.runExclusive('k', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('limpia el mapa para no acumular entradas de claves terminadas', async () => {
    const lock = new KeyedLock();
    await lock.runExclusive('k', () => Promise.resolve());
    expect((lock as unknown as { tails: Map<string, Promise<void>> }).tails.size).toBe(0);
  });
});
