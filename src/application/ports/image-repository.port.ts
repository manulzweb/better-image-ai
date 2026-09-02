import { ProcessedImage } from '../../domain/entities/processed-image';

export const IMAGE_REPOSITORY = Symbol('IMAGE_REPOSITORY');

export interface ImageRepositoryPort {
  findByHash(hash: string): Promise<ProcessedImage | null>;
  save(image: ProcessedImage): Promise<void>;
  // Todos los hashes válidos (snapshot para el GC de storage).
  listHashes(): Promise<string[]>;
  // Comprueba que la DB responde (para el health check).
  ping(): Promise<void>;
}
