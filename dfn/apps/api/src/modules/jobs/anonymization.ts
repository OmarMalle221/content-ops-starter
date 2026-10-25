import type { UserStatus } from '@dfn/database';

/**
 * Pure anonymisation rules (GDPR / Loi 25 "right to erasure" applied to a financial platform):
 * identifying attributes are replaced, while ledger postings, transaction history and audit rows
 * are never modified — they stay linked to the now-anonymous user id.
 */
export const ANONYMIZED_EMAIL_DOMAIN = 'anonymized.invalid';
export const ANONYMIZED_FIRST_NAME = 'Utilisateur';
export const ANONYMIZED_LAST_NAME = 'Supprimé';
export const ANONYMIZED_ORGANIZATION_NAME = 'Compte supprimé';
export const ANONYMIZED_DECLARED_DATA = { anonymized: true } as const;
/** Beneficiaries of the PERSONAL organisation: the contact is erased and the row soft-removed. */
export const ANONYMIZED_BENEFICIARY_NAME = 'Bénéficiaire supprimé';
/** `Beneficiary.accountIdentifierEnc` is NOT NULL: it is replaced by the encryption of this placeholder. */
export const ANONYMIZED_ACCOUNT_IDENTIFIER = '';
/** Display form that still renders like a masked identifier, without the last characters. */
export const ANONYMIZED_ACCOUNT_IDENTIFIER_MASKED = '••••';
/** Counterparties of other organisations that pointed at the user's email. */
export const ANONYMIZED_COUNTERPARTY_NAME = 'Contact supprimé';

/** deleted-<first 8 characters of the user id>@anonymized.invalid — unique and never routable. */
export function anonymizedEmail(userId: string): string {
  return `deleted-${userId.slice(0, 8).toLowerCase()}@${ANONYMIZED_EMAIL_DOMAIN}`;
}

export interface AnonymizedUserFields {
  email: string;
  firstName: string;
  lastName: string;
  phone: null;
  country: string | null;
  mfaSecretEnc: null;
  mfaEnabled: false;
  mfaLastUsedStep: null;
  passwordHash: string;
  securityPreferences: null;
  status: UserStatus;
  failedLoginCount: 0;
  lockedUntil: null;
  deletionRequestedAt: Date;
  deletedAt: Date;
  anonymizedAt: Date;
}

/**
 * Builds the replacement attributes of a user row. `passwordHash` must be a fresh argon2 hash of
 * random bytes (nobody can ever log in again); `country` is kept for aggregated statistics.
 */
export function buildAnonymizedUser(
  user: { id: string; country: string | null; deletionRequestedAt: Date | null },
  passwordHash: string,
  now: Date,
): AnonymizedUserFields {
  return {
    email: anonymizedEmail(user.id),
    firstName: ANONYMIZED_FIRST_NAME,
    lastName: ANONYMIZED_LAST_NAME,
    phone: null,
    country: user.country,
    mfaSecretEnc: null,
    mfaEnabled: false,
    mfaLastUsedStep: null,
    passwordHash,
    securityPreferences: null,
    status: 'DEACTIVATED',
    failedLoginCount: 0,
    lockedUntil: null,
    deletionRequestedAt: user.deletionRequestedAt ?? now,
    deletedAt: now,
    anonymizedAt: now,
  };
}

/** Users whose deletion was requested at least `afterDays` days before `now` are due. */
export function anonymizationCutoff(now: Date, afterDays: number): Date {
  return new Date(now.getTime() - afterDays * 86_400_000);
}

export function anonymizeAfter(deletionRequestedAt: Date | null, afterDays: number): Date | null {
  if (!deletionRequestedAt) return null;
  return new Date(deletionRequestedAt.getTime() + afterDays * 86_400_000);
}
