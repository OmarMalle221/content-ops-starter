import 'server-only';
import { cookies, headers } from 'next/headers';

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

/**
 * Server-side fetch to the API with the user's session cookie forwarded. Never cached. The client
 * address (X-Forwarded-For, rewritten from the socket by xff-guard.cjs before Next sees the
 * request) is forwarded too, so rate limits and audit entries see the user rather than this
 * server.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const store = await cookies();
  const cookieHeader = store
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const clientAddress = (await headers()).get('x-forwarded-for');
  const res = await fetch(`${API_INTERNAL_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(clientAddress ? { 'X-Forwarded-For': clientAddress } : {}),
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
    /** Effective role: 'USER' for a staff account that still needs MFA (see `staffMfaRequired`). */
    globalRole: 'USER' | 'COMPLIANCE' | 'ADMIN';
    /**
     * REQUIRE_STAFF_MFA: the stored role is staff but the account has no second factor yet, so the
     * API grants USER rights only. Absent otherwise.
     */
    staffMfaRequired?: boolean;
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

/** GET /v1/users/me/security-preferences (defaults applied by the API). */
export interface SecurityPreferences {
  requireMfaForTransfers: boolean;
  transferAlerts: boolean;
  dailyTransferLimit: string | null;
}

/**
 * Whether authorising a transfer asks this user for a fresh second factor — the API rule
 * (TransfersService.assertMfa): MFA enabled AND `requireMfaForTransfers` not switched off.
 * Unreadable preferences count as "required", the API default; the API decides either way.
 */
export async function getTransferStepUpRequired(me: Me | null): Promise<boolean> {
  if (!me?.user.mfaEnabled) return false;
  const prefs = await apiFetchOptional<SecurityPreferences>('/v1/users/me/security-preferences').catch(
    () => null,
  );
  return prefs?.requireMfaForTransfers !== false;
}
