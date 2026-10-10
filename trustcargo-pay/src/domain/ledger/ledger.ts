/**
 * Double-entry ledger rules (pure).
 *
 * The ledger mirrors movements REPORTED by the licensed payment partner. It is an internal
 * accounting record used for traceability and reconciliation — it is NOT evidence that
 * TrustCargo holds funds. Posted journals are immutable; corrections are made by reversal.
 */
import type { CurrencyCode } from '../money';
import type { LedgerAccountType, LedgerJournalKind } from '../model';

export class LedgerError extends Error {
    constructor(
        public readonly code:
            'UNBALANCED' | 'EMPTY' | 'NON_POSITIVE_AMOUNT' | 'MIXED_CURRENCY' | 'ALREADY_REVERSED' | 'CANNOT_REVERSE_REVERSAL',
        message: string
    ) {
        super(message);
        this.name = 'LedgerError';
    }
}

export interface EntryDraft {
    accountCode: string;
    direction: 'DEBIT' | 'CREDIT';
    amountMinor: bigint;
    currency: CurrencyCode;
}

export interface JournalDraft {
    idempotencyKey: string;
    kind: LedgerJournalKind;
    transactionId?: string;
    externalReference?: string;
    providerEventId?: string;
    description: string;
    entries: EntryDraft[];
}

/** Chart of accounts. Codes are deterministic so the same account is reused across journals. */
export const accounts = {
    /** Asset: funds the partner reports holding for TrustCargo-arranged transactions. */
    partnerClearing: (provider: string, currency: CurrencyCode) => ({
        code: `PARTNER_CLEARING:${provider}:${currency}`,
        name: `Partner clearing (${provider}, ${currency}) — reported by partner`,
        type: 'ASSET' as LedgerAccountType,
        currency
    }),
    /** Liability: amount held for a transaction, owed to one of the parties per contract. */
    transactionHeld: (transactionId: string, currency: CurrencyCode) => ({
        code: `TX_HELD:${transactionId}:${currency}`,
        name: `Transaction funds held at partner (${currency})`,
        type: 'LIABILITY' as LedgerAccountType,
        currency,
        transactionId
    }),
    /** Liability: release authorised, awaiting partner payout confirmation. */
    sellerPayable: (transactionId: string, currency: CurrencyCode) => ({
        code: `SELLER_PAYABLE:${transactionId}:${currency}`,
        name: `Seller payable — release authorised (${currency})`,
        type: 'LIABILITY' as LedgerAccountType,
        currency,
        transactionId
    }),
    /** Liability: refund authorised, awaiting partner confirmation. */
    buyerRefundable: (transactionId: string, currency: CurrencyCode) => ({
        code: `BUYER_REFUNDABLE:${transactionId}:${currency}`,
        name: `Buyer refundable — refund authorised (${currency})`,
        type: 'LIABILITY' as LedgerAccountType,
        currency,
        transactionId
    })
};

export function validateJournal(draft: JournalDraft): void {
    if (draft.entries.length < 2) throw new LedgerError('EMPTY', 'A journal needs at least two entries');
    const currency = draft.entries[0]!.currency;
    let debit = 0n;
    let credit = 0n;
    for (const e of draft.entries) {
        if (e.amountMinor <= 0n) throw new LedgerError('NON_POSITIVE_AMOUNT', 'Entry amounts must be strictly positive');
        if (e.currency !== currency) throw new LedgerError('MIXED_CURRENCY', 'Multi-currency journals are not supported in the MVP');
        if (e.direction === 'DEBIT') debit += e.amountMinor;
        else credit += e.amountMinor;
    }
    if (debit !== credit) throw new LedgerError('UNBALANCED', `Journal unbalanced: debit ${debit} ≠ credit ${credit}`);
}

/** Builds the mirror journal used to correct a posted journal. */
export function buildReversal(
    original: { id: string; kind: LedgerJournalKind; reversesJournalId?: string; transactionId?: string; externalReference?: string },
    entries: EntryDraft[],
    reason: string
): JournalDraft {
    if (original.kind === 'REVERSAL' || original.reversesJournalId) {
        throw new LedgerError('CANNOT_REVERSE_REVERSAL', 'A reversal cannot itself be reversed; post a new journal instead');
    }
    return {
        idempotencyKey: `reversal:${original.id}`,
        kind: 'REVERSAL',
        transactionId: original.transactionId,
        externalReference: original.externalReference,
        description: `Reversal of ${original.id}: ${reason}`,
        entries: entries.map((e) => ({ ...e, direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT' }))
    };
}

/** Signed balance following the account's normal side (debit-normal for assets/expenses). */
export function normalBalance(type: LedgerAccountType, debits: bigint, credits: bigint): bigint {
    return type === 'ASSET' || type === 'EXPENSE' ? debits - credits : credits - debits;
}

/* ------------------------------------------------------------------ journal templates */

interface TemplateArgs {
    provider: string;
    transactionId: string;
    currency: CurrencyCode;
    amountMinor: bigint;
    externalReference: string;
    providerEventId?: string;
}

export const journalTemplates = {
    fundsReportedReceived: (a: TemplateArgs): JournalDraft => ({
        idempotencyKey: `funds:${a.provider}:${a.externalReference}`,
        kind: 'FUNDS_REPORTED_RECEIVED',
        transactionId: a.transactionId,
        externalReference: a.externalReference,
        providerEventId: a.providerEventId,
        description: 'Partner reported buyer funds received',
        entries: [
            {
                accountCode: accounts.partnerClearing(a.provider, a.currency).code,
                direction: 'DEBIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            },
            {
                accountCode: accounts.transactionHeld(a.transactionId, a.currency).code,
                direction: 'CREDIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            }
        ]
    }),
    releaseAuthorized: (a: TemplateArgs & { payoutId: string }): JournalDraft => ({
        idempotencyKey: `release:${a.payoutId}`,
        kind: 'RELEASE_AUTHORIZED',
        transactionId: a.transactionId,
        externalReference: a.externalReference,
        description: 'Release instruction authorised (awaiting partner payout)',
        entries: [
            {
                accountCode: accounts.transactionHeld(a.transactionId, a.currency).code,
                direction: 'DEBIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            },
            {
                accountCode: accounts.sellerPayable(a.transactionId, a.currency).code,
                direction: 'CREDIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            }
        ]
    }),
    payoutSettled: (a: TemplateArgs & { payoutId: string }): JournalDraft => ({
        idempotencyKey: `payout:${a.payoutId}`,
        kind: 'PAYOUT_SETTLED',
        transactionId: a.transactionId,
        externalReference: a.externalReference,
        providerEventId: a.providerEventId,
        description: 'Partner reported payout executed',
        entries: [
            {
                accountCode: accounts.sellerPayable(a.transactionId, a.currency).code,
                direction: 'DEBIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            },
            {
                accountCode: accounts.partnerClearing(a.provider, a.currency).code,
                direction: 'CREDIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            }
        ]
    }),
    refundAuthorized: (a: TemplateArgs & { refundId: string }): JournalDraft => ({
        idempotencyKey: `refund-auth:${a.refundId}`,
        kind: 'REFUND_AUTHORIZED',
        transactionId: a.transactionId,
        externalReference: a.externalReference,
        description: 'Refund instruction authorised (awaiting partner confirmation)',
        entries: [
            {
                accountCode: accounts.transactionHeld(a.transactionId, a.currency).code,
                direction: 'DEBIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            },
            {
                accountCode: accounts.buyerRefundable(a.transactionId, a.currency).code,
                direction: 'CREDIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            }
        ]
    }),
    refundSettled: (a: TemplateArgs & { refundId: string }): JournalDraft => ({
        idempotencyKey: `refund:${a.refundId}`,
        kind: 'REFUND_SETTLED',
        transactionId: a.transactionId,
        externalReference: a.externalReference,
        providerEventId: a.providerEventId,
        description: 'Partner reported refund executed',
        entries: [
            {
                accountCode: accounts.buyerRefundable(a.transactionId, a.currency).code,
                direction: 'DEBIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            },
            {
                accountCode: accounts.partnerClearing(a.provider, a.currency).code,
                direction: 'CREDIT',
                amountMinor: a.amountMinor,
                currency: a.currency
            }
        ]
    })
};
