import { hostname } from 'node:os';
import { z } from 'zod';
import { isValidStructuringThresholdSpec } from '@dfn/compliance';

const envSchema = z
  .object({
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
    // ── Phase 3–5
    JOBS_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    JOBS_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    ANONYMIZE_AFTER_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
    FX_PROVIDER: z.string().default('sandbox'),
    FX_QUOTE_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
    SANDBOX_SELF_DEPOSIT_DAILY_LIMIT: z
      .string()
      .regex(/^\d{1,13}([.,]\d{1,2})?$/)
      .default('50000.00'),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    // ── Phase 6
    /** Identifies this API replica in job leases and run history (defaults to hostname-pid). */
    INSTANCE_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
    /**
     * Key ring: comma-separated `purpose:keyId:hex64` entries (purposes: documents, mfa, webhooks,
     * beneficiaries). The first entry of a purpose is its active key; later ones are decrypt-only
     * (rotation). Purposes without an entry use DOCUMENT_ENCRYPTION_KEY (key id "legacy").
     */
    ENCRYPTION_KEYRING: z.string().optional(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    WEBAUTHN_RP_ID: z.string().default('localhost'),
    WEBAUTHN_RP_NAME: z.string().default('Diaspora Trust (sandbox)'),
    /** Comma-separated origins accepted in WebAuthn client data (the web app origin). */
    WEBAUTHN_ORIGINS: z.string().default('http://localhost:3000'),
    JOBS_DRIVER: z.enum(['inprocess', 'bullmq']).default('inprocess'),
    /** Lease duration of a running job; the runner renews it by heartbeat while the job runs. */
    JOB_LEASE_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
    RATE_LIMIT_STORE: z.enum(['memory', 'redis']).default('memory'),
    /** Optional comma-separated allowlist of webhook destination hosts (exact or *.suffix). */
    WEBHOOK_ALLOWED_HOSTS: z.string().optional(),
    REVIEW_SLA_HOURS_HIGH: z.coerce.number().int().min(1).max(720).default(24),
    REVIEW_SLA_HOURS_MEDIUM: z.coerce.number().int().min(1).max(720).default(72),
    REVIEW_SLA_HOURS_LOW: z.coerce.number().int().min(1).max(2160).default(168),
    /** Structuring detection: rolling window and aggregate threshold (decimal, per currency). */
    STRUCTURING_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    /** Default and per-currency thresholds, e.g. "10000.00,XOF:4400000,GNF:63000000" (≈ 10 000 CAD). */
    STRUCTURING_THRESHOLD: z
      .string()
      .refine(
        isValidStructuringThresholdSpec,
        'Expected "decimal" and/or "CCC:decimal" entries, comma-separated',
      )
      .default('10000.00,XOF:4400000,GNF:63000000'),
    PAYOUT_PROVIDER: z.string().default('sandbox'),
  })
  .superRefine((v, ctx) => {
    if (v.STORAGE_DRIVER === 's3' && !v.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
      });
    }
    if ((v.JOBS_DRIVER === 'bullmq' || v.RATE_LIMIT_STORE === 'redis') && !v.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required when JOBS_DRIVER=bullmq or RATE_LIMIT_STORE=redis',
      });
    }
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
