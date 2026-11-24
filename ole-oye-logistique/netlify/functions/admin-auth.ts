/**
 * /api/admin/auth — connexion à l'administration par courriel (Supabase Auth).
 *
 *   GET                                   → session en cours
 *   POST { action: 'request', email }     → envoie le lien (et le code) par courriel
 *   POST { action: 'verify', email, code } → valide le code reçu
 *   POST { action: 'session', access_token } → valide le jeton du lien cliqué
 *   POST { action: 'logout' }
 *
 * Seuls les courriels de la table `admin_users` peuvent se connecter.
 */
import type { Config, Context } from '@netlify/functions';
import { clientIp, errorResponse, isSameOrigin, json, readJson } from '../lib/http';
import { allowRequest } from '../lib/rate-limit';
import { clearSessionCookie, currentAdmin, isAllowedAdmin, sessionCookie } from '../lib/session';
import { NotConfiguredError, authClient } from '../lib/supabase';

export const config: Config = { path: '/api/admin/auth' };

/** 8 tentatives par quart d'heure et par adresse IP. */
const RATE_LIMIT = { bucket: 'admin-auth', windowSeconds: 900, max: 8 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function openSession(req: Request, email: string | undefined | null): Promise<Response> {
  if (!email || !(await isAllowedAdmin(email))) return errorResponse('unauthorized', 401);
  return json({ ok: true, email: email.toLowerCase() }, 200, { 'Set-Cookie': sessionCookie(req, email) });
}

export default async function handler(req: Request, context: Context): Promise<Response> {
  try {
    if (req.method === 'GET') {
      const email = await currentAdmin(req);
      return json({ ok: true, authenticated: Boolean(email), email });
    }
    if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);
    if (!isSameOrigin(req)) return errorResponse('forbidden', 403);

    const body = await readJson(req);
    if (!body) return errorResponse('invalid_request', 400);

    if (body.action === 'logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(req) });
    }

    if (!(await allowRequest(clientIp(req, context), RATE_LIMIT))) return errorResponse('rate_limited', 429);

    if (body.action === 'request') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL_RE.test(email)) return errorResponse('invalid_email', 400);
      // Même réponse que le courriel soit autorisé ou non : on ne révèle pas la liste.
      if (await isAllowedAdmin(email)) {
        const { error } = await authClient().auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${new URL(req.url).origin}/admin/`, shouldCreateUser: true },
        });
        if (error) console.error('admin-auth: envoi du lien refusé', error.message);
      }
      return json({ ok: true });
    }

    if (body.action === 'verify') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
      if (!EMAIL_RE.test(email) || !/^\d{6,10}$/.test(code)) return errorResponse('invalid_code', 400);
      const { data, error } = await authClient().auth.verifyOtp({ email, token: code, type: 'email' });
      if (error || !data.user) return errorResponse('invalid_code', 401);
      return openSession(req, data.user.email);
    }

    if (body.action === 'session') {
      const token = typeof body.access_token === 'string' ? body.access_token : '';
      if (!token) return errorResponse('unauthorized', 401);
      const { data, error } = await authClient().auth.getUser(token);
      if (error || !data.user) return errorResponse('unauthorized', 401);
      return openSession(req, data.user.email);
    }

    return errorResponse('invalid_request', 400);
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      console.error('admin-auth:', error.message);
      return errorResponse('not_configured', 503);
    }
    console.error('admin-auth', error);
    return errorResponse('server', 500);
  }
}
