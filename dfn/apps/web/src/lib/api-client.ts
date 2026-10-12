'use client';

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

/** Browser-side call through the same-origin /api proxy (cookies are first-party). */
export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok)
    throw new ClientApiError(
      res.status,
      data ?? { statusCode: res.status, code: 'HTTP_ERROR', message: res.statusText },
    );
  return data as T;
}

export function errorMessage(e: unknown, fallback = 'Une erreur est survenue'): string {
  if (e instanceof ClientApiError) {
    const details = e.body.details as any;
    if (Array.isArray(details) && details.length && details[0]?.message)
      return `${e.body.message}: ${details.map((d: any) => `${d.path ? d.path + ' — ' : ''}${d.message}`).join('; ')}`;
    return e.body.message;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

/** Shared wording of the second-factor / passkey error codes (see packages/shared/src/errors.ts). */
const API_ERROR_KEYS = 'passkeys.errors';

/**
 * Error message in the interface language: `<scope>.<CODE>` when the caller has a wording for
 * its own context, then the shared `passkeys.errors.<CODE>`, then the API's (English) message.
 */
export function localizedApiError(e: unknown, t: (path: string) => string, scope?: string): string {
  if (e instanceof ClientApiError) {
    for (const prefix of scope ? [scope, API_ERROR_KEYS] : [API_ERROR_KEYS]) {
      const key = `${prefix}.${e.body.code}`;
      const text = t(key);
      if (text !== key) return text;
    }
  }
  return errorMessage(e);
}
