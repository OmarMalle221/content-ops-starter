import type { Context } from '@netlify/functions';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: code, ...extra }, status);
}

/** Lit un corps JSON de taille limitée. Renvoie `null` s'il est absent, trop gros ou invalide. */
export async function readJson(req: Request, maxBytes = 20_000): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) return null;
  const raw = await req.text();
  if (raw.length > maxBytes) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function clientIp(req: Request, context?: Partial<Context>): string {
  return (
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Protection CSRF : une requête qui modifie des données doit venir du site
 * lui-même. Les navigateurs envoient toujours `Origin` sur un POST inter-sites.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get('host') ?? new URL(req.url).host);
  } catch {
    return false;
  }
}
