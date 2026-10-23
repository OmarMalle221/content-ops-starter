/**
 * Turns an API-relative path (`/v1/...`, as the API returns in `downloadUrl` and the like) into a
 * link through the web's same-origin `/api` proxy. Server and client components alike.
 */
export function apiHref(path: string): string {
  return `/api${path.startsWith('/') ? path : `/${path}`}`;
}
