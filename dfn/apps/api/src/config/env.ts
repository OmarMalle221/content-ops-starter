import { z } from 'zod';

const envSchema = z.object({
  DFN_MODE: z.literal('sandbox', {
    errorMap: () => ({
      message: 'This build only supports DFN_MODE=sandbox. Live mode requires licensed partners.',
    }),
  }),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  API_PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(16),
  DOCUMENT_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, '32-byte hex key required'),
  SESSION_COOKIE_NAME: z.string().default('dfn_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(15),
  PAYMENT_PROVIDER: z.string().default('sandbox'),
  SANDBOX_AUTO_CONFIRM_FUNDING: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  KYC_PROVIDER: z.string().default('sandbox'),
  SANCTIONS_PROVIDER: z.string().default('sandbox'),
  EMAIL_PROVIDER: z.enum(['log']).default('log'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REQUIRE_VERIFICATION_BEFORE_FUNDING: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  const merged = { ...process.env, ...overrides };
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function env(): Env {
  if (!cached) return loadEnv();
  return cached;
}

export const ENV = 'ENV';
