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
