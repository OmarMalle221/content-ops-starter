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
    /**
     * Staff (ADMIN, COMPLIANCE) must have two-factor authentication enabled to use any staff
     * permission: every staff session then went through a second factor (TOTP, recovery code or
     * passkey). Off by default in the sandbox (seeded staff accounts); required before any pilot.
     */
    REQUIRE_STAFF_MFA: z
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
    /**
     * Express "trust proxy": which peers may set X-Forwarded-For (rate limits and audit IPs depend
     * on it). Comma-separated addresses/subnets ("loopback,uniquelocal"), a hop count ("1") or "false". The
     * default trusts only private networks, so a client reaching the API directly cannot spoof it.
     */
    TRUST_PROXY: z.string().min(1).default('loopback,linklocal,uniquelocal'),
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

    // ── Phase 7 ──────────────────────────────────────────────────────────────
    /**
     * KMS holding the master key that wraps the data keys of the key ring (envelope encryption):
     * "none" = data keys only from ENCRYPTION_KEYRING (phase 6 behaviour); "local" = sandbox KMS
     * whose master key is KMS_LOCAL_MASTER_KEY; "aws" = AWS KMS (KMS_KEY_ID, KMS_REGION, optional
     * KMS_ENDPOINT for a compatible service). Wrapped keys live in the EncryptionKey table.
     */
    KMS_PROVIDER: z.enum(['none', 'local', 'aws']).default('none'),
    KMS_LOCAL_MASTER_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'KMS_LOCAL_MASTER_KEY must be 32-byte hex')
      .optional(),
    KMS_KEY_ID: z.string().min(1).optional(),
    KMS_REGION: z.string().min(1).optional(),
    KMS_ENDPOINT: z.string().url().optional(),
    /**
     * Scheduled rotation (KEY_LIFECYCLE job): stages a new data key for every purpose whose active
     * KMS-managed key is older than this (0 = manual only; the first managed key is always generated
     * by an admin).
     */
    KEY_ROTATION_INTERVAL_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
    /**
     * A new key stays STAGED (decrypt-only) this long so every replica loads it before it seals.
     * Keep it above KEYRING_REFRESH_SECONDS (a warning is logged otherwise).
     */
    KEY_ACTIVATION_DELAY_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
    /**
     * How often each replica reloads KMS-managed keys from the database (only new keys are sent to
     * the KMS). A decrypt-only key can be retired two periods after its deactivation.
     */
    KEYRING_REFRESH_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
    /**
     * "false" retires the legacy DOCUMENT_ENCRYPTION_KEY for decryption once every value has been
     * re-sealed (the key ring then refuses legacy values; every purpose needs an active key).
     */
    ENCRYPTION_LEGACY_DECRYPT: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    /**
     * Secret keying new recovery-code hashes (stored with an "r2:" prefix); without it, hashes are
     * keyed with SESSION_SECRET. Both forms keep verifying, so it can be set at any time; rotating
     * SESSION_SECRET then no longer invalidates the codes created under it. Changing this secret
     * invalidates the codes created under it.
     */
    MFA_RECOVERY_SECRET: z.string().min(32).optional(),
    /** Prometheus metrics at GET /metrics (bearer METRICS_TOKEN; without a token: loopback only). */
    METRICS_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false'),
    METRICS_TOKEN: z.string().min(24).optional(),
    /**
     * Antivirus for uploads, scanned before storage and fail closed (no verdict → 503
     * SCAN_UNAVAILABLE): "none" (stored unscanned, SKIPPED), "sandbox" (SIMULATION that only
     * detects the EICAR test file — not protection), "clamd" (ClamAV daemon, INSTREAM over TCP;
     * its StreamMaxLength must be ≥ MAX_UPLOAD_MB).
     */
    ANTIVIRUS_PROVIDER: z.enum(['none', 'sandbox', 'clamd']).default('sandbox'),
    CLAMD_HOST: z.string().default('127.0.0.1'),
    CLAMD_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    /** Deadline of one clamd scan (connection, upload of the file and verdict). */
    ANTIVIRUS_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
    /** Days a deleted document's blob is kept when it has no later retentionUntil (0 = next purge run). */
    DOCUMENT_PURGE_GRACE_DAYS: z.coerce.number().int().min(0).max(3650).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production') {
      // `cp .env.example .env` must not boot a production build on the published sample secrets.
      for (const key of ['SESSION_SECRET', 'DOCUMENT_ENCRYPTION_KEY', 'KMS_LOCAL_MASTER_KEY'] as const) {
        if (isPlaceholderSecret(v[key])) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is a sample value: generate one (openssl rand -hex 32)`,
          });
        }
      }
    }
    if (v.STORAGE_DRIVER === 's3' && !v.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
      });
    }
    if (v.KMS_PROVIDER === 'local' && !v.KMS_LOCAL_MASTER_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['KMS_LOCAL_MASTER_KEY'],
        message: 'KMS_LOCAL_MASTER_KEY is required when KMS_PROVIDER=local',
      });
    }
    if (v.KMS_PROVIDER === 'aws' && (!v.KMS_KEY_ID || !v.KMS_REGION)) {
      ctx.addIssue({
        code: 'custom',
        path: ['KMS_KEY_ID'],
        message: 'KMS_KEY_ID and KMS_REGION are required when KMS_PROVIDER=aws',
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

/** Sample secrets of .env.example and the docs: "change-me…" text or one repeated character. */
export function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return false;
  return /change-?me/i.test(value) || /^(.)\1*$/.test(value);
}

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
