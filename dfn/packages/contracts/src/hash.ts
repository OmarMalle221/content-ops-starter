import { createHash } from 'node:crypto';

/** Canonical JSON (sorted keys) so the same terms always hash identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function hashContract(
  templateCode: string,
  templateVersion: string,
  terms: unknown,
  bodyText: string,
): string {
  return createHash('sha256')
    .update(templateCode)
    .update('\n')
    .update(templateVersion)
    .update('\n')
    .update(canonicalJson(terms))
    .update('\n')
    .update(bodyText)
    .digest('hex');
}
