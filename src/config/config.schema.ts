import { z } from 'zod';

const clientSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    keyHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
    profiles: z.record(
      z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      z.string().trim().min(1).max(2000),
    ),
  })
  .strict();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.1-flash-lite-image'),
    GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    API_KEYS: z
      .string()
      .default('')
      .transform((raw) =>
        raw
          .split(',')
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    CLIENTS_JSON: z
      .string()
      .default('[]')
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid CLIENTS_JSON',
            fatal: true,
          });
          return z.NEVER;
        }
      })
      .pipe(z.array(clientSchema))
      .superRefine((clients, ctx) => {
        const ids = clients.map((c) => c.id);
        const hashes = clients.flatMap((c) => c.keyHashes);
        if (new Set(ids).size !== ids.length || new Set(hashes).size !== hashes.length)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate client or key hash' });
      }),
    MP_ACCESS_TOKEN: z.string().min(1).optional(),
    MP_WEBHOOK_SECRET: z.string().min(16).optional(),
    MP_COLLECTOR_ID: z.string().regex(/^\d+$/).optional(),
    MP_LIVE_MODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    MP_CURRENCY: z.enum(['COP', 'ARS', 'BRL', 'CLP', 'MXN', 'PEN', 'UYU']).optional(),
    CREDIT_PACK_SIZE: z.coerce.number().int().min(1).max(100000).optional(),
    CREDIT_PACK_PRICE: z.coerce.number().int().min(1).max(100000000).optional(),
    PUBLIC_BASE_URL: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/'
        );
      }, 'Expected an HTTPS origin')
      .transform((value) => value.replace(/\/$/, ''))
      .optional(),
    MAX_PENDING_IMAGES: z.coerce.number().int().min(100).max(10000).default(1000),
    JOB_UPLOAD_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
    JOB_WORKERS: z.coerce.number().int().min(1).max(8).default(2),
    ADMIN_API_KEY_HASH: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    MAX_ACTIVE_REQUESTS: z.coerce.number().int().min(1).max(100).default(4),
    GEMINI_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    MAX_BATCH_FILES: z.coerce.number().int().min(1).max(20).default(5),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
    STORAGE_DIR: z.string().min(1).default('storage/processed'),
    DB_PATH: z.string().min(1).default('storage/better-image.db'),
    MAX_FILE_SIZE_MB: z.coerce.number().int().positive().max(7).default(7),
    // 'true' | 'false' | número de hops (p.ej. 1 detrás de Nginx).
    TRUST_PROXY: z
      .union([z.enum(['true', 'false']), z.coerce.number().int().min(0)])
      .default('false')
      .transform((value) => (typeof value === 'string' ? value === 'true' : value)),
    // Intervalo del GC de huérfanos en minutos; 0 lo desactiva (solo corre al arranque).
    GC_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(720),
  })
  .superRefine((env, ctx) => {
    if (
      env.MP_ACCESS_TOKEN &&
      (!env.MP_WEBHOOK_SECRET ||
        !env.MP_COLLECTOR_ID ||
        !env.MP_CURRENCY ||
        !env.CREDIT_PACK_SIZE ||
        !env.CREDIT_PACK_PRICE ||
        !env.PUBLIC_BASE_URL)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Mercado Pago requires webhook secret, collector id, currency, credit pack size/price and public HTTPS origin',
      });
    if (!env.API_KEYS.length && !env.CLIENTS_JSON.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Configure API_KEYS or CLIENTS_JSON' });
    if (env.NODE_ENV === 'production' && (env.API_KEYS.length || !env.CLIENTS_JSON.length))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Production requires CLIENTS_JSON and empty API_KEYS',
      });
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY === true)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use an explicit proxy hop count in production',
      });
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
