/**
 * Every surface of the platform must make the sandbox nature explicit.
 * These constants are reused by the API (response headers, OpenAPI description)
 * and by the web app (persistent banner).
 */
export const SANDBOX_DISCLAIMER = {
  fr: 'Données fictives — Aucun fonds réel',
  en: 'Simulated data — No real funds',
} as const;

export const SANDBOX_MODE = 'sandbox' as const;
export type RuntimeMode = typeof SANDBOX_MODE;

export const SANDBOX_HEADER = 'x-dfn-mode';
