/**
 * Compact, deterministic one-line preview of a MaintenanceRun summary (scalars only).
 * Shared by the server-rendered jobs page and the client "run now" button — no 'use client'
 * directive here so that server components can call it directly.
 */
export function summaryPreview(summary: unknown, max = 160): string {
  if (!summary || typeof summary !== 'object') return '—';
  const parts = Object.entries(summary as Record<string, unknown>)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}=${String(v)}`);
  if (!parts.length) return '—';
  const line = parts.join(' · ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
