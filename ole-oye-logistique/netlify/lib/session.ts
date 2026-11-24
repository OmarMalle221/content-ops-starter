/**
 * Session de l'administration.
 *
 * Supabase prouve l'identité (lien ou code reçu par courriel). Le site émet
 * ensuite son propre témoin signé (HMAC-SHA256), inaccessible au JavaScript
 * (`HttpOnly`) et jamais envoyé depuis un autre site (`SameSite=Strict`).
 * Aucune clé Supabase n'atteint donc le navigateur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { NotConfiguredError, serviceClient, tenantId } from './supabase';

export const SESSION_COOKIE = 'admin_session';
const SESSION_DAYS = 7;

interface SessionPayload {
  email: string;
  /** Expiration, en secondes depuis l'époque Unix. */
  exp: number;
}

function secret(): string {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || value.length < 32) throw new NotConfiguredError('ADMIN_SESSION_SECRET (32 caractères minimum)');
  return value;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createSessionToken(email: string, now: number = Date.now()): string {
  const payload: SessionPayload = { email: email.toLowerCase(), exp: Math.floor(now / 1000) + SESSION_DAYS * 86_400 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

/** Renvoie le courriel si le jeton est authentique et non expiré, sinon `null`. */
export function verifySessionToken(token: string | undefined | null, now: number = Date.now()): string | null {
  if (!token) return null;
  const [data, signature] = token.split('.');
  if (!data || !signature) return null;
  const expected = Buffer.from(sign(data));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (typeof payload.email !== 'string' || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000 > now ? payload.email : null;
  } catch {
    return null;
  }
}

function cookieAttributes(req: Request): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Strict${secure}`;
}

export function sessionCookie(req: Request, email: string): string {
  return `${SESSION_COOKIE}=${createSessionToken(email)}; Max-Age=${SESSION_DAYS * 86_400}; ${cookieAttributes(req)}`;
}

export function clearSessionCookie(req: Request): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req)}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** `true` si ce courriel figure dans `admin_users` pour le tenant du site. */
export async function isAllowedAdmin(email: string): Promise<boolean> {
  const { data, error } = await serviceClient()
    .from('admin_users')
    .select('email')
    .eq('tenant_id', tenantId())
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`admin_users: ${error.message}`);
  return Boolean(data);
}

/**
 * Courriel de l'administrateur connecté, ou `null`. La liste `admin_users` est
 * relue à chaque appel : retirer un courriel coupe l'accès immédiatement.
 */
export async function currentAdmin(req: Request): Promise<string | null> {
  const email = verifySessionToken(readCookie(req, SESSION_COOKIE));
  if (!email) return null;
  return (await isAllowedAdmin(email)) ? email : null;
}
