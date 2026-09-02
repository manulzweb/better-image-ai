export const STORAGE = Symbol('STORAGE');

export interface StoragePort {
  save(hash: string, buffer: Buffer): Promise<string>;
  read(hash: string): Promise<Buffer>;
  // Elimina ficheros que no están en validHashes (huérfanos); devuelve los nombres borrados.
  removeOrphans(validHashes: ReadonlySet<string>): Promise<string[]>;
  // Comprueba que el storage es escribible (para el health check).
  probe(): Promise<void>;
}
