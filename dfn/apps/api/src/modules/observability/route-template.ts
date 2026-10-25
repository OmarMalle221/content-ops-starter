/**
 * Label values of the HTTP metrics. Every value comes from a finite set — the route templates the
 * router registered, a few fixed names and the HTTP methods — so the number of series is bounded
 * whatever clients send: raw URLs, identifiers and query strings never reach a label.
 */
export const UNMATCHED_ROUTE = 'unmatched';
export const METRICS_ROUTE = '/metrics';
export const DOCS_ROUTE = '/docs';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function methodLabel(method: string | undefined): string {
  const upper = (method ?? '').toUpperCase();
  return METHODS.has(upper) ? upper : 'OTHER';
}

export interface RouteTemplateSource {
  /** Express route matched by the router (`req.route.path`, e.g. `/v1/transfers/:id`). */
  route?: { path?: unknown };
  baseUrl?: string;
  path?: string;
}

/**
 * Route label of a finished request. `req.route` is set by the Express router when a route
 * matched — before guards and handlers run, so 401/403/429 answers are attributed to their route.
 * Nest registers middleware as routes too (`*path`), so `req.route` is never empty: a request no
 * controller route matched still carries the instrumentation middleware's own route, passed as
 * `middlewareRoute` — those (404s) and the OpenAPI UI (static middleware) share two fixed labels.
 * `override` lets a middleware that answers a request itself (the metrics endpoint) name it.
 */
export function routeTemplate(
  req: RouteTemplateSource,
  override?: string,
  middlewareRoute?: unknown,
): string {
  if (override) return override;
  const route = req.route;
  const path = route && route !== middlewareRoute ? route.path : undefined;
  const template = Array.isArray(path) ? path[0] : path;
  if (typeof template === 'string' && template.length > 0) return `${req.baseUrl ?? ''}${template}`;
  const requestPath = req.path ?? '';
  if (
    requestPath === DOCS_ROUTE ||
    requestPath.startsWith(`${DOCS_ROUTE}/`) ||
    requestPath.startsWith(`${DOCS_ROUTE}-`)
  ) {
    return DOCS_ROUTE;
  }
  return UNMATCHED_ROUTE;
}
