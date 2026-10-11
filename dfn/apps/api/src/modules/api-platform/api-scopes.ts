import { ApiScope } from '@dfn/shared';

/**
 * Scope required for a request authenticated with a partner API key.
 *
 * Returns:
 *  - `null`   → the route is open to every valid key (reference data, health);
 *  - a scope  → the key must carry it;
 *  - `'FORBIDDEN'` → the route is never reachable with an API key (auth, admin, sandbox simulators…).
 *
 * The path is matched without the query string. Order matters: the most specific prefixes come first.
 */
export type RequiredScope = string | null | 'FORBIDDEN';

const UUID = '[0-9a-fA-F-]{36}';
const TX_SUB = new RegExp(`^/v1/transactions/${UUID}/(documents|disputes|refund-request)(/|$)`);
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function normalizePath(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function requiredScopeFor(method: string, rawPath: string): RequiredScope {
  const m = method.toUpperCase();
  const path = normalizePath(rawPath);
  const isGet = m === 'GET' || m === 'HEAD';
  const startsWith = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

  // Always allowed (read-only, non-tenant data)
  if (isGet && (startsWith('/v1/reference') || startsWith('/v1/health') || path === '/health')) return null;

  // Protect transactions
  if (startsWith('/v1/transactions')) {
    const sub = TX_SUB.exec(path);
    if (sub) {
      if (isGet) return ApiScope.TRANSACTIONS_READ;
      if (sub[1] === 'documents') return ApiScope.DOCUMENTS_WRITE;
      return ApiScope.DISPUTES_WRITE;
    }
    if (isGet) return ApiScope.TRANSACTIONS_READ;
    if (m === 'POST') return ApiScope.TRANSACTIONS_WRITE;
    return 'FORBIDDEN';
  }
  if (startsWith('/v1/invitations')) {
    if (isGet) return ApiScope.TRANSACTIONS_READ;
    if (m === 'POST') return ApiScope.TRANSACTIONS_WRITE;
    return 'FORBIDDEN';
  }
  if (startsWith('/v1/documents')) {
    if (isGet) return ApiScope.TRANSACTIONS_READ;
    if (m === 'POST') return ApiScope.DOCUMENTS_WRITE;
    return 'FORBIDDEN';
  }
  if (startsWith('/v1/disputes')) {
    if (isGet) return ApiScope.TRANSACTIONS_READ;
    if (m === 'POST') return ApiScope.DISPUTES_WRITE;
    return 'FORBIDDEN';
  }

  // Diaspora Wallet (read-only; the FX estimate is a read that happens to be a POST)
  if (startsWith('/v1/wallets')) {
    if (isGet || path === '/v1/wallets/estimate') return ApiScope.WALLETS_READ;
    return 'FORBIDDEN';
  }

  // Diaspora Transfer
  if (startsWith('/v1/transfers') || startsWith('/v1/beneficiaries')) {
    if (isGet) return ApiScope.TRANSFERS_READ;
    if (WRITE_METHODS.has(m)) return ApiScope.TRANSFERS_WRITE;
    return 'FORBIDDEN';
  }

  // Diaspora Business
  if (startsWith('/v1/invoices') || startsWith('/v1/quotes')) {
    if (isGet) return ApiScope.INVOICES_READ;
    if (WRITE_METHODS.has(m)) return ApiScope.INVOICES_WRITE;
    return 'FORBIDDEN';
  }

  // Webhook subscriptions of the key's organisation
  if (startsWith('/v1/webhooks')) return ApiScope.WEBHOOKS_MANAGE;

  return 'FORBIDDEN';
}

/** Human description of every scope, reused by the docs endpoint and the console. */
export const SCOPE_DESCRIPTIONS: Record<string, { fr: string; en: string }> = {
  [ApiScope.TRANSACTIONS_READ]: {
    fr: 'Lire les transactions Protect, leurs événements et invitations',
    en: 'Read Protect transactions, their events and invitations',
  },
  [ApiScope.TRANSACTIONS_WRITE]: {
    fr: 'Créer des transactions, accepter des conditions, demander un financement (fictif)',
    en: 'Create transactions, accept terms, request (fictitious) funding',
  },
  [ApiScope.DOCUMENTS_WRITE]: {
    fr: 'Téléverser des documents et preuves',
    en: 'Upload documents and evidence',
  },
  [ApiScope.DISPUTES_WRITE]: {
    fr: 'Ouvrir des litiges, demander des remboursements, envoyer des messages',
    en: 'Open disputes, request refunds, post messages',
  },
  [ApiScope.WALLETS_READ]: {
    fr: 'Lire les soldes et relevés (fictifs)',
    en: 'Read (fictitious) balances and statements',
  },
  [ApiScope.TRANSFERS_READ]: {
    fr: 'Lire les transferts et bénéficiaires',
    en: 'Read transfers and beneficiaries',
  },
  [ApiScope.TRANSFERS_WRITE]: {
    fr: 'Créer des transferts simulés et des bénéficiaires',
    en: 'Create simulated transfers and beneficiaries',
  },
  [ApiScope.INVOICES_READ]: { fr: 'Lire devis et factures', en: 'Read quotes and invoices' },
  [ApiScope.INVOICES_WRITE]: {
    fr: 'Créer et gérer devis et factures',
    en: 'Create and manage quotes and invoices',
  },
  [ApiScope.WEBHOOKS_MANAGE]: { fr: 'Gérer les abonnements webhook', en: 'Manage webhook subscriptions' },
};
