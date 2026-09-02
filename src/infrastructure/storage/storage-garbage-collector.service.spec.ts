import { ConfigService } from '@nestjs/config';
import { StorageGarbageCollector } from './storage-garbage-collector.service';
import { ImageRepositoryPort } from '../../application/ports/image-repository.port';
import { StoragePort } from '../../application/ports/storage.port';
import { EnvConfig } from '../../config/config.schema';

const fakeConfig = (intervalMinutes = 0) =>
  ({ get: () => intervalMinutes }) as unknown as ConfigService<EnvConfig, true>;

describe('StorageGarbageCollector', () => {
  let repository: jest.Mocked<ImageRepositoryPort>;
  let storage: jest.Mocked<StoragePort>;
  let gc: StorageGarbageCollector;

  beforeEach(() => {
    repository = {
      findByHash: jest.fn(),
      save: jest.fn(),
      listHashes: jest.fn().mockResolvedValue([]),
      ping: jest.fn(),
    };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      removeOrphans: jest.fn().mockResolvedValue([]),
      probe: jest.fn(),
    };
    gc = new StorageGarbageCollector(storage, repository, fakeConfig());
  });

  afterEach(() => gc.onModuleDestroy());

  it('pasa el snapshot de hashes de la DB al storage y devuelve lo borrado', async () => {
    repository.listHashes.mockResolvedValue(['a'.repeat(64)]);
    storage.removeOrphans.mockResolvedValue(['deadbeef.tmp-123']);

    const removed = await gc.run();

    expect(storage.removeOrphans).toHaveBeenCalledWith(new Set(['a'.repeat(64)]));
    expect(removed).toBe(1);
  });

  it('no lanza si el barrido falla (no puede tumbar el arranque)', async () => {
    repository.listHashes.mockRejectedValue(new Error('db down'));

    await expect(gc.run()).resolves.toBe(0);
  });

  it('corre el barrido al iniciar el módulo', async () => {
    gc.onModuleInit();
    await new Promise((resolve) => setImmediate(resolve));

    expect(repository.listHashes).toHaveBeenCalled();
  });

  it('no programa timer periódico si el intervalo es 0', () => {
    gc.onModuleInit();
    expect((gc as unknown as { timer?: NodeJS.Timeout }).timer).toBeUndefined();
  });

  it('programa timer periódico cuando el intervalo es > 0', () => {
    const gcWithTimer = new StorageGarbageCollector(storage, repository, fakeConfig(60));
    gcWithTimer.onModuleInit();
    expect((gcWithTimer as unknown as { timer?: NodeJS.Timeout }).timer).toBeDefined();
    gcWithTimer.onModuleDestroy();
  });
});
