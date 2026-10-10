import { accounts, buildReversal, normalBalance, validateJournal, type JournalDraft } from '@/domain/ledger/ledger';
import type { CurrencyCode } from '@/domain/money';
import type { LedgerAccount, LedgerJournal } from '@/domain/model';
import type { Db } from '@/server/ports/db';
import type { Actor, AnyActor } from '@/server/auth/actor';
import { hasRole, mfaIsRecent } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { audit, securitySettings, type Deps } from './context';

type AccountSpec = { code: string; name: string; type: LedgerAccount['type']; currency: CurrencyCode; transactionId?: string };

function specForCode(code: string): AccountSpec {
    const [kind, a, b] = code.split(':') as [string, string, CurrencyCode];
    switch (kind) {
        case 'PARTNER_CLEARING':
            return accounts.partnerClearing(a, b);
        case 'TX_HELD':
            return accounts.transactionHeld(a, b);
        case 'SELLER_PAYABLE':
            return accounts.sellerPayable(a, b);
        case 'BUYER_REFUNDABLE':
            return accounts.buyerRefundable(a, b);
        default:
            throw new Error(`Unknown ledger account code ${code}`);
    }
}

export class LedgerService {
    constructor(private readonly deps: Deps) {}

    private async ensureAccount(db: Db, code: string): Promise<LedgerAccount> {
        const existing = await db.ledgerAccounts.findOne({ code });
        if (existing) return existing;
        const spec = specForCode(code);
        return db.ledgerAccounts.insert({ id: this.deps.ids.id(), ...spec, createdAt: this.deps.clock.now().toISOString() });
    }

    /**
     * Posts a journal atomically. Idempotent: re-posting the same idempotency key returns the
     * existing journal without creating entries (protects against duplicate webhook processing).
     */
    async post(db: Db, draft: JournalDraft, postedBy: AnyActor): Promise<{ journal: LedgerJournal; duplicate: boolean }> {
        const existing = await db.ledgerJournals.findOne({ idempotencyKey: draft.idempotencyKey });
        if (existing) return { journal: existing, duplicate: true };
        validateJournal(draft);
        const journal: LedgerJournal = {
            id: this.deps.ids.id(),
            idempotencyKey: draft.idempotencyKey,
            kind: draft.kind,
            transactionId: draft.transactionId,
            externalReference: draft.externalReference,
            providerEventId: draft.providerEventId,
            description: draft.description,
            reversesJournalId: draft.kind === 'REVERSAL' ? draft.idempotencyKey.replace('reversal:', '') : undefined,
            postedBy: postedBy.kind === 'USER' ? postedBy.userId : postedBy.id,
            postedAt: this.deps.clock.now().toISOString()
        };
        await db.ledgerJournals.insert(journal);
        for (const e of draft.entries) {
            const account = await this.ensureAccount(db, e.accountCode);
            if (account.currency !== e.currency) throw new AppError('CONFLICT', 'Entry currency differs from account currency');
            await db.ledgerEntries.insert({
                id: this.deps.ids.id(),
                journalId: journal.id,
                accountId: account.id,
                direction: e.direction,
                amountMinor: e.amountMinor,
                currency: e.currency
            });
        }
        return { journal, duplicate: false };
    }

    async balance(db: Db, code: string): Promise<bigint> {
        const account = await db.ledgerAccounts.findOne({ code });
        if (!account) return 0n;
        const entries = await db.ledgerEntries.findBy({ accountId: account.id });
        let debits = 0n;
        let credits = 0n;
        for (const e of entries) {
            if (e.direction === 'DEBIT') debits += e.amountMinor;
            else credits += e.amountMinor;
        }
        return normalBalance(account.type, debits, credits);
    }

    async transactionBalances(db: Db, transactionId: string, currency: CurrencyCode) {
        return {
            held: await this.balance(db, accounts.transactionHeld(transactionId, currency).code),
            sellerPayable: await this.balance(db, accounts.sellerPayable(transactionId, currency).code),
            buyerRefundable: await this.balance(db, accounts.buyerRefundable(transactionId, currency).code)
        };
    }

    /** Global integrity check: for each currency, total debits must equal total credits. */
    async trialBalance(db: Db): Promise<{ currency: string; debits: string; credits: string; balanced: boolean }[]> {
        const totals = new Map<string, { d: bigint; c: bigint }>();
        for (const e of await db.ledgerEntries.list()) {
            const t = totals.get(e.currency) ?? { d: 0n, c: 0n };
            if (e.direction === 'DEBIT') t.d += e.amountMinor;
            else t.c += e.amountMinor;
            totals.set(e.currency, t);
        }
        return [...totals].map(([currency, t]) => ({ currency, debits: t.d.toString(), credits: t.c.toString(), balanced: t.d === t.c }));
    }

    /** Corrects a posted journal by posting its mirror. Requires finance role + recent MFA. */
    async reverse(actor: Actor, journalId: string, reason: string) {
        if (!hasRole(actor, 'finance_operator')) throw forbidden();
        return this.deps.uow.run(async (db) => {
            const settings = await securitySettings(db);
            if (!mfaIsRecent(actor, settings.sensitiveActionMfaMaxAgeMinutes, this.deps.clock.now()))
                throw new AppError('MFA_REQUIRED', 'Recent MFA required');
            const original = await db.ledgerJournals.get(journalId);
            if (!original) throw notFound('Journal');
            if (await db.ledgerJournals.findOne({ idempotencyKey: `reversal:${journalId}` }))
                throw new AppError('CONFLICT', 'Journal already reversed');
            const entries = await db.ledgerEntries.findBy({ journalId });
            const accountsById = new Map((await db.ledgerAccounts.list()).map((a) => [a.id, a]));
            const draft = buildReversal(
                original,
                entries.map((e) => ({
                    accountCode: accountsById.get(e.accountId)!.code,
                    direction: e.direction,
                    amountMinor: e.amountMinor,
                    currency: e.currency
                })),
                reason
            );
            const { journal } = await this.post(db, draft, actor);
            await audit(
                this.deps,
                db,
                actor,
                'ledger.journal_reversed',
                { type: 'ledger_journal', id: journalId },
                { transactionId: original.transactionId, metadata: { reversalJournalId: journal.id, reason } }
            );
            return journal;
        });
    }
}
