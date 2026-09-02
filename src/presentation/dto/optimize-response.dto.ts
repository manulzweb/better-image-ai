import { OptimizeImageResult } from '../../application/use-cases/optimize-image.use-case';

// Presentación depende de application: el DTO reutiliza el tipo del caso de uso.
export type OptimizeResponseDto = OptimizeImageResult;

export interface HealthResponseDto {
  status: 'ok';
  uptime: number;
  timestamp: string;
}
