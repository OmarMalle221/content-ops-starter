const FALLBACK = '/dashboard';
const SENTINEL = 'http://dfn.invalid';

/**
 * Post-login destination taken from the `next` query parameter. Only a same-origin path is kept:
 * `javascript:` URLs (DOM XSS through `router.push`), absolute and protocol-relative URLs, and the
 * `/\host` or `/<tab>/host` forms browsers normalise to another origin all fall back to the
 * dashboard. The value is resolved against a sentinel origin, so the browser's own URL parser
 * decides what it points to.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return FALLBACK;
  let url: URL;
  try {
    url = new URL(raw, SENTINEL);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== SENTINEL) return FALLBACK;
  return `${url.pathname}${url.search}${url.hash}`;
}
