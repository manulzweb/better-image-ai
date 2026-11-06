import { CreditsPort } from '../ports/credits.port';
import { OptimizeImageUseCase } from './optimize-image.use-case';
import { ImageOptimizerPort } from '../ports/image-optimizer.port';
import { ImageRepositoryPort } from '../ports/image-repository.port';
import { HashServicePort } from '../ports/hash-service.port';
import { StoragePort } from '../ports/storage.port';
import { GeminiApiException } from '../../domain/exceptions/gemini-api.exception';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const HASH = 'a'.repeat(64);

describe('OptimizeImageUseCase', () => {
  let useCase: OptimizeImageUseCase;
  let optimizer: jest.Mocked<ImageOptimizerPort>;
  let repository: jest.Mocked<ImageRepositoryPort>;
  let hashService: jest.Mocked<HashServicePort>;
  let credits: jest.Mocked<CreditsPort>;
  let storage: jest.Mocked<StoragePort>;

  beforeEach(() => {
    optimizer = {
      strategy: 'gemini',
      optimize: jest.fn().mockResolvedValue(PNG_1X1),
    };
    repository = {
      findByHash: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
      listHashes: jest.fn(),
      ping: jest.fn(),
    };
    hashService = { compute: jest.fn().mockReturnValue(HASH) };
    storage = {
      save: jest.fn().mockResolvedValue('path'),
      read: jest.fn(),
      removeOrphans: jest.fn(),
      probe: jest.fn(),
    };

    credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      persist: jest.fn().mockImplementation((image) => repository.save(image)),
      grant: jest.fn(),
      balance: jest.fn(),
    };
    useCase = new OptimizeImageUseCase(optimizer, repository, hashService, storage, credits);
  });

  it('does not call Gemini without a successful credit reservation', async () => {
    credits.reserve.mockRejectedValue(new Error('Insufficient credits'));
    await expect(useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' })).rejects.toThrow(
      'Insufficient',
    );
    expect(optimizer.optimize).not.toHaveBeenCalled();
  });

  it('releases credit reservations on provider failure', async () => {
    optimizer.optimize.mockRejectedValue(new Error('provider failed'));
    await expect(
      useCase.execute({
        buffer: PNG_1X1,
        mimeType: 'image/png',
        tenantId: 'shop',
        reservationId: 'job:0',
      }),
    ).rejects.toThrow('provider failed');
    expect(credits.release).toHaveBeenCalledWith('job:0');
    expect(credits.persist).not.toHaveBeenCalled();
  });

  it('procesa y persiste una imagen nueva (cached=false)', async () => {
    const result = await useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' });

    expect(hashService.compute).toHaveBeenCalledWith(PNG_1X1);
    expect(repository.findByHash).toHaveBeenCalledWith(HASH);
    expect(optimizer.optimize).toHaveBeenCalledTimes(1);
    expect(storage.save).toHaveBeenCalledWith(HASH, PNG_1X1);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ hash: HASH, strategy: 'gemini', mimeType: 'image/png' }),
    );
    expect(result).toMatchObject({
      hash: HASH,
      cached: false,
      url: `/v1/images/${HASH}`,
      strategy: 'gemini',
    });
    expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('devuelve el resultado cacheado sin reprocesar (cached=true)', async () => {
    repository.findByHash.mockResolvedValue({
      hash: HASH,
      mimeType: 'image/png',
      sizeBytes: 68,
      strategy: 'gemini',
      createdAt: new Date(),
    });

    const result = await useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' });

    expect(optimizer.optimize).not.toHaveBeenCalled();
    expect(storage.save).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ hash: HASH, cached: true, url: `/v1/images/${HASH}` });
  });

  it('dos peticiones concurrentes con la misma imagen nueva llaman a Gemini una sola vez', async () => {
    // Mock con estado: tras save, findByHash empieza a devolver el registro,
    // así el re-check dentro del lock del segundo request da cache hit.
    let saved: Awaited<ReturnType<ImageRepositoryPort['findByHash']>> = null;
    repository.findByHash.mockImplementation(async () => saved);
    repository.save.mockImplementation(async (image) => {
      saved = image;
    });

    const [a, b] = await Promise.all([
      useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' }),
      useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' }),
    ]);

    expect(optimizer.optimize).toHaveBeenCalledTimes(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
  });

  it('re-check tras el lock: si otro request la procesó primero, no toca el optimizador', async () => {
    repository.findByHash.mockResolvedValueOnce(null).mockResolvedValueOnce({
      hash: HASH,
      mimeType: 'image/png',
      sizeBytes: 68,
      strategy: 'gemini',
      createdAt: new Date(),
    });

    const result = await useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' });

    expect(result.cached).toBe(true);
    expect(optimizer.optimize).not.toHaveBeenCalled();
  });

  it('propaga el error del optimizador y no persiste nada', async () => {
    optimizer.optimize.mockRejectedValue(new GeminiApiException('boom'));

    await expect(
      useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' }),
    ).rejects.toBeInstanceOf(GeminiApiException);
    expect(storage.save).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rechaza la salida del optimizador si no tiene firma reconocida', async () => {
    optimizer.optimize.mockResolvedValue(Buffer.from('not-an-image'));

    await expect(useCase.execute({ buffer: PNG_1X1, mimeType: 'image/png' })).rejects.toThrow(
      'unrecognized image format',
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
