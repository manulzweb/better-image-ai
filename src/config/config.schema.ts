import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash-image'),
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  API_KEYS: z
    .string()
    .min(1, 'API_KEYS is required (comma-separated)')
    .transform((raw) =>
      raw
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    )
    .refine((keys) => keys.length > 0, 'API_KEYS must contain at least one key'),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  STORAGE_DIR: z.string().min(1).default('storage/processed'),
  DB_PATH: z.string().min(1).default('storage/better-image.db'),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(7),
  // 'true' | 'false' | número de hops (p.ej. 1 detrás de Nginx).
  TRUST_PROXY: z
    .union([z.enum(['true', 'false']), z.coerce.number().int().min(0)])
    .default('false')
    .transform((value) => (typeof value === 'string' ? value === 'true' : value)),
  // Intervalo del GC de huérfanos en minutos; 0 lo desactiva (solo corre al arranque).
  GC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(720),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
