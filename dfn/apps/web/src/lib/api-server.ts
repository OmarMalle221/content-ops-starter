import 'server-only';
import { cookies } from 'next/headers';

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Server-side fetch to the API with the user's session cookie forwarded. Never cached. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await fetch(`${API_INTERNAL_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.message ?? res.statusText, body.details);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Returns null when the request is unauthenticated instead of throwing. */
export async function apiFetchOptional<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return null;
    throw e;
  }
}

export interface Me {
  mfaRequired: boolean;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    locale: string;
    country: string | null;
    globalRole: 'USER' | 'COMPLIANCE' | 'ADMIN';
    mfaEnabled: boolean;
    identityVerification: { status: string; simulated: boolean; id?: string };
    organizations: Array<{
      id: string;
      name: string;
      type: 'PERSONAL' | 'BUSINESS';
      country: string;
      role: string;
      verificationStatus: string;
    }>;
  };
}

export async function getSession(): Promise<Me | null> {
  const me = await apiFetchOptional<Me>('/v1/auth/me');
  if (!me || !me.user) return null;
  return me;
}
