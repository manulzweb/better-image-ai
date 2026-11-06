import { ProcessedImage } from '../../domain/entities/processed-image';
export const CREDITS = Symbol('CREDITS');
export interface CreditsPort {
  reserve(tenant: string, id: string): Promise<void>;
  release(id: string, resultHash?: string): Promise<void>;
  persist(image: ProcessedImage, reservation: string): Promise<void>;
  balance(tenant: string): Promise<{ available: number; reserved: number }>;
  grant(tenant: string, amount: number, reference: string): Promise<void>;
}
