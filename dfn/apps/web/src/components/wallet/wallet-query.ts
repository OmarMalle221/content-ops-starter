/** Shared (server + client) helpers for the wallet URL state. Must stay free of 'use client'. */
export interface EntriesFilterValues {
  kind?: string;
  status?: string;
  from?: string;
  to?: string;
}

/** Builds the wallet query string for one organisation/currency plus optional filters. */
export function walletQuery(organizationId: string, currency: string, f: EntriesFilterValues = {}) {
  const qs = new URLSearchParams({ organizationId, currency });
  if (f.kind) qs.set('kind', f.kind);
  if (f.status) qs.set('status', f.status);
  if (f.from) qs.set('from', f.from);
  if (f.to) qs.set('to', f.to);
  return qs.toString();
}
