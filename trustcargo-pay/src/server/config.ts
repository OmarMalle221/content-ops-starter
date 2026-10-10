import { z } from 'zod';

const schema = z.object({
    TRUSTCARGO_MODE: z.enum(['demo', 'production']).default('demo'),
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    SESSION_SECRET: z.string().min(32).optional(),
    MOCK_PROVIDER_WEBHOOK_SECRET: z.string().min(16).optional(),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DEMO_ALLOW_PERSONA_LOGIN: z.enum(['true', 'false']).default('true')
});

export interface ServerConfig {
    mode: 'demo' | 'production';
    paymentProvider: 'mock';
    sessionSecret: string;
    webhookSecret: string;
    appUrl: string;
    personaLogin: boolean;
}

let cached: ServerConfig | undefined;

/**
 * Validates environment configuration at startup. Production mode refuses to start with the mock
 * payment provider or without explicit secrets: no simulated component may be mistaken for a real one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    if (cached && env === process.env) return cached;
    const parsed = schema.safeParse(env);
    if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const e = parsed.data;
    if (e.TRUSTCARGO_MODE === 'production') {
        if (e.PAYMENT_PROVIDER === 'mock') {
            throw new Error('Production mode requires a licensed payment partner adapter. The mock provider is simulation-only.');
        }
        if (!e.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production');
    }
    const config: ServerConfig = {
        mode: e.TRUSTCARGO_MODE,
        paymentProvider: e.PAYMENT_PROVIDER,
        // Demo fallbacks are clearly non-secret and only acceptable because no real money or data exists.
        sessionSecret: e.SESSION_SECRET ?? 'demo-only-insecure-session-secret-change-me-0000',
        webhookSecret: e.MOCK_PROVIDER_WEBHOOK_SECRET ?? 'demo-only-mock-webhook-secret',
        appUrl: e.APP_URL.replace(/\/$/, ''),
        personaLogin: e.TRUSTCARGO_MODE === 'demo' && e.DEMO_ALLOW_PERSONA_LOGIN === 'true'
    };
    if (env === process.env) cached = config;
    return config;
}
