import { GetProcessedImageUseCase } from './get-processed-image.use-case';
import { ImageRepositoryPort } from '../ports/image-repository.port';
import { StoragePort } from '../ports/storage.port';
import { ImageNotFoundException } from '../../domain/exceptions/image-not-found.exception';

const HASH = 'b'.repeat(64);

describe('GetProcessedImageUseCase', () => {
  let useCase: GetProcessedImageUseCase;
  let repository: jest.Mocked<ImageRepositoryPort>;
  let storage: jest.Mocked<StoragePort>;

  beforeEach(() => {
    repository = {
      findByHash: jest.fn(),
      save: jest.fn(),
      listHashes: jest.fn(),
      ping: jest.fn(),
    };
    storage = {
      save: jest.fn(),
      read: jest.fn(),
      removeOrphans: jest.fn(),
      probe: jest.fn(),
    };
    useCase = new GetProcessedImageUseCase(repository, storage);
  });

  it('devuelve el buffer y mimeType de una imagen existente', async () => {
    repository.findByHash.mockResolvedValue({
      hash: HASH,
      mimeType: 'image/png',
      sizeBytes: 68,
      strategy: 'gemini',
      createdAt: new Date(),
    });
    storage.read.mockResolvedValue(Buffer.from('png-bytes'));

    const result = await useCase.execute(HASH);

    expect(result.mimeType).toBe('image/png');
    expect(result.buffer.toString()).toBe('png-bytes');
  });

  it('rechaza un hash con formato inválido', async () => {
    await expect(useCase.execute('../../etc/passwd')).rejects.toBeInstanceOf(
      ImageNotFoundException,
    );
    expect(repository.findByHash).not.toHaveBeenCalled();
  });

  it('lanza ImageNotFoundException si el hash no existe en el repositorio', async () => {
    repository.findByHash.mockResolvedValue(null);

    await expect(useCase.execute(HASH)).rejects.toBeInstanceOf(ImageNotFoundException);
    expect(storage.read).not.toHaveBeenCalled();
  });
});
