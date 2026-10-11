import type { RiskRule } from './types';

const HIGH_VALUE_THRESHOLDS_MINOR: Record<string, bigint> = {
  CAD: 1_500_000n, // 15 000 CAD
  USD: 1_500_000n,
  EUR: 1_200_000n,
  XOF: 7_500_000n,
  GNF: 100_000_000n,
};

export const riskRules: RiskRule[] = [
  {
    code: 'AMOUNT_VS_PROFILE',
    description: 'Transaction amount disproportionate to the organisation history',
    appliesTo: ['transaction.created', 'transaction.funded'],
    evaluate(f) {
      if (f.amountMinor === undefined || !f.averageAmountMinor || f.averageAmountMinor <= 0n) return null;
      const ratio = Number((f.amountMinor * 100n) / f.averageAmountMinor) / 100;
      if (ratio < 5) return null;
      return {
        ruleCode: this.code,
        severity: ratio >= 15 ? 'HIGH' : 'MEDIUM',
        score: ratio >= 15 ? 40 : 20,
        explanation: {
          summary: `Amount is ${ratio.toFixed(1)}× the organisation's historical average`,
          factors: {
            ratio,
            amountMinor: f.amountMinor.toString(),
            averageAmountMinor: f.averageAmountMinor.toString(),
          },
          recommendation: 'Confirm the commercial rationale and supporting documents before release.',
        },
      };
    },
  },
  {
    code: 'VELOCITY_24H',
    description: 'Unusual number of transactions created in 24 hours',
    appliesTo: ['transaction.created'],
    evaluate(f) {
      if (f.transactionsLast24h === undefined || f.transactionsLast24h < 5) return null;
      return {
        ruleCode: this.code,
        severity: f.transactionsLast24h >= 10 ? 'HIGH' : 'MEDIUM',
        score: f.transactionsLast24h >= 10 ? 35 : 15,
        explanation: {
          summary: `${f.transactionsLast24h} transactions created in the last 24 hours`,
          factors: { transactionsLast24h: f.transactionsLast24h },
          recommendation: 'Check for structuring or account takeover; contact the organisation if needed.',
        },
      };
    },
  },
  {
    code: 'UNVERIFIED_HIGH_VALUE',
    description: 'High-value transaction while identity/business verification is not complete',
    appliesTo: ['transaction.created', 'transaction.funded'],
    evaluate(f) {
      if (f.amountMinor === undefined || !f.currencyCode) return null;
      const threshold = HIGH_VALUE_THRESHOLDS_MINOR[f.currencyCode];
      if (!threshold || f.amountMinor < threshold) return null;
      if (f.identityVerified) return null;
      return {
        ruleCode: this.code,
        severity: 'HIGH',
        score: 45,
        explanation: {
          summary: 'High-value transaction created by a party whose identity verification is incomplete',
          factors: {
            amountMinor: f.amountMinor.toString(),
            currencyCode: f.currencyCode,
            identityVerified: false,
          },
          recommendation: 'Require identity verification before funding is accepted.',
        },
      };
    },
  },
  {
    code: 'REPEATED_LOGIN_FAILURES',
    description: 'Repeated failed sign-in attempts',
    appliesTo: ['auth.login_failed'],
    evaluate(f) {
      if (f.failedLoginsLast15m === undefined || f.failedLoginsLast15m < 5) return null;
      return {
        ruleCode: this.code,
        severity: f.failedLoginsLast15m >= 10 ? 'HIGH' : 'MEDIUM',
        score: f.failedLoginsLast15m >= 10 ? 30 : 15,
        explanation: {
          summary: `${f.failedLoginsLast15m} failed sign-in attempts within 15 minutes`,
          factors: { failedLoginsLast15m: f.failedLoginsLast15m },
          recommendation: 'Account is temporarily locked; verify ownership before unlocking.',
        },
      };
    },
  },
  {
    code: 'MULTI_DISPUTE_ACCOUNT',
    description: 'Account associated with several disputes',
    appliesTo: ['dispute.opened', 'transaction.created'],
    evaluate(f) {
      const count = f.disputesAsPartyTotal ?? 0;
      if (count < 3) return null;
      return {
        ruleCode: this.code,
        severity: count >= 5 ? 'HIGH' : 'MEDIUM',
        score: count >= 5 ? 35 : 20,
        explanation: {
          summary: `Party has been involved in ${count} disputes`,
          factors: { disputesAsPartyTotal: count },
          recommendation: 'Review dispute history before approving further releases.',
        },
      };
    },
  },
  {
    code: 'GEOGRAPHY_MISMATCH',
    description: 'Buyer country inconsistent with transaction origin or unsupported corridor',
    appliesTo: ['transaction.created'],
    evaluate(f) {
      if (!f.userCountry || !f.originCountry) return null;
      const mismatch = f.userCountry !== f.originCountry;
      const unsupported = f.corridorSupported === false;
      if (!mismatch && !unsupported) return null;
      return {
        ruleCode: this.code,
        severity: unsupported ? 'MEDIUM' : 'LOW',
        score: unsupported ? 15 : 5,
        explanation: {
          summary: unsupported
            ? 'Corridor is not yet supported'
            : 'Declared user country differs from the transaction origin country',
          factors: {
            userCountry: f.userCountry,
            originCountry: f.originCountry,
            destinationCountry: f.destinationCountry ?? null,
            corridorSupported: f.corridorSupported ?? null,
          },
          recommendation: 'Confirm the residency of the buyer and the corridor eligibility.',
        },
      };
    },
  },
  {
    code: 'DOCUMENT_REUSE',
    description: 'Identical document hash already uploaded on other transactions',
    appliesTo: ['document.uploaded'],
    evaluate(f) {
      if (!f.documentSha256DuplicateCount || f.documentSha256DuplicateCount < 1) return null;
      return {
        ruleCode: this.code,
        severity: f.documentSha256DuplicateCount >= 3 ? 'HIGH' : 'MEDIUM',
        score: f.documentSha256DuplicateCount >= 3 ? 30 : 15,
        explanation: {
          summary: `The same file was already uploaded ${f.documentSha256DuplicateCount} time(s) on other transactions`,
          factors: { duplicates: f.documentSha256DuplicateCount },
          recommendation: 'Verify that the proof is genuine and specific to this transaction.',
        },
      };
    },
  },
  {
    code: 'NEW_ACCOUNT_HIGH_VALUE',
    description: 'Very recent account creating a high-value transaction',
    appliesTo: ['transaction.created'],
    evaluate(f) {
      if (f.accountAgeDays === undefined || f.amountMinor === undefined || !f.currencyCode) return null;
      const threshold = HIGH_VALUE_THRESHOLDS_MINOR[f.currencyCode];
      if (!threshold || f.amountMinor < threshold / 2n || f.accountAgeDays > 2) return null;
      return {
        ruleCode: this.code,
        severity: 'MEDIUM',
        score: 15,
        explanation: {
          summary: 'Account younger than 3 days created a high-value transaction',
          factors: { accountAgeDays: f.accountAgeDays, amountMinor: f.amountMinor.toString() },
          recommendation: 'Monitor; request verification before funding.',
        },
      };
    },
  },
  // ───────────────────────────── Diaspora Transfer (Phase 4) ──────────────────
  {
    code: 'TRANSFER_VELOCITY',
    description: 'Unusual number of transfers initiated by the organisation in 24 hours',
    appliesTo: ['transfer.created', 'transfer.authorized'],
    evaluate(f) {
      if (f.transfersLast24h === undefined || f.transfersLast24h < 5) return null;
      const high = f.transfersLast24h >= 10;
      return {
        ruleCode: this.code,
        severity: high ? 'HIGH' : 'MEDIUM',
        score: high ? 35 : 15,
        explanation: {
          summary: `${f.transfersLast24h} transfers initiated in the last 24 hours`,
          factors: {
            transfersLast24h: f.transfersLast24h,
            transfersAmountLast24hMinor: f.transfersAmountLast24hMinor?.toString() ?? null,
            currencyCode: f.currencyCode ?? null,
          },
          recommendation:
            'Check for structuring (smurfing) or account takeover before further transfers settle.',
        },
      };
    },
  },
  {
    code: 'NEW_BENEFICIARY_HIGH_VALUE',
    description: 'Large transfer to a beneficiary added less than 24 hours ago',
    appliesTo: ['transfer.created', 'transfer.authorized'],
    evaluate(f) {
      if (f.beneficiaryAgeHours === undefined || f.amountMinor === undefined || !f.currencyCode) return null;
      const threshold = HIGH_VALUE_THRESHOLDS_MINOR[f.currencyCode];
      if (!threshold || f.beneficiaryAgeHours >= 24 || f.amountMinor < threshold / 2n) return null;
      return {
        ruleCode: this.code,
        severity: 'MEDIUM',
        score: 20,
        explanation: {
          summary: 'High-value transfer to a beneficiary registered less than 24 hours ago',
          factors: {
            beneficiaryAgeHours: f.beneficiaryAgeHours,
            amountMinor: f.amountMinor.toString(),
            currencyCode: f.currencyCode,
            destinationCountry: f.destinationCountry ?? null,
          },
          recommendation:
            'Confirm the beneficiary with the sender through a second channel before settlement.',
        },
      };
    },
  },
  {
    code: 'BENEFICIARY_CHURN',
    description: 'Many beneficiaries added or removed within 24 hours',
    appliesTo: ['beneficiary.changed'],
    evaluate(f) {
      if (f.beneficiaryChangesLast24h === undefined || f.beneficiaryChangesLast24h < 3) return null;
      return {
        ruleCode: this.code,
        severity: 'MEDIUM',
        score: 15,
        explanation: {
          summary: `${f.beneficiaryChangesLast24h} beneficiary changes in the last 24 hours`,
          factors: { beneficiaryChangesLast24h: f.beneficiaryChangesLast24h },
          recommendation: 'Possible account takeover: verify recent sign-ins and contact the organisation.',
        },
      };
    },
  },
  {
    code: 'UNVERIFIED_TRANSFER',
    description: 'High-value transfer authorised while identity verification is incomplete',
    appliesTo: ['transfer.authorized'],
    evaluate(f) {
      if (f.amountMinor === undefined || !f.currencyCode || f.identityVerified !== false) return null;
      const threshold = HIGH_VALUE_THRESHOLDS_MINOR[f.currencyCode];
      if (!threshold || f.amountMinor < threshold) return null;
      return {
        ruleCode: this.code,
        severity: 'HIGH',
        score: 45,
        explanation: {
          summary: 'High-value transfer authorised by a user whose identity verification is incomplete',
          factors: {
            amountMinor: f.amountMinor.toString(),
            currencyCode: f.currencyCode,
            identityVerified: false,
            destinationCountry: f.destinationCountry ?? null,
          },
          recommendation: 'Hold the transfer for manual review and require identity verification.',
        },
      };
    },
  },
  {
    code: 'TRANSFER_DRAINS_WALLET',
    description: 'Transfer that empties (almost) the whole wallet balance',
    appliesTo: ['transfer.created', 'transfer.authorized'],
    evaluate(f) {
      if (f.walletBalanceMinor === undefined || f.amountMinor === undefined || !f.currencyCode) return null;
      const threshold = HIGH_VALUE_THRESHOLDS_MINOR[f.currencyCode];
      if (!threshold || f.walletBalanceMinor <= 0n || f.amountMinor < threshold / 2n) return null;
      // amount ≥ 90 % of the balance, computed in integers.
      if (f.amountMinor * 100n < f.walletBalanceMinor * 90n) return null;
      return {
        ruleCode: this.code,
        severity: 'LOW',
        score: 5,
        explanation: {
          summary: 'Transfer amount is at least 90 % of the wallet balance',
          factors: {
            amountMinor: f.amountMinor.toString(),
            walletBalanceMinor: f.walletBalanceMinor.toString(),
            currencyCode: f.currencyCode,
          },
          recommendation: 'Monitor; combined with other signals this may indicate an exit scam or takeover.',
        },
      };
    },
  },
];
