import { allocateByBps, fromDTO, parseMoney, type CurrencyCode, toDTO } from '@/domain/money';
import { diffTerms, totalShareBps, validateMilestoneTerms } from '@/domain/transaction/contract';
import { PRE_FUNDING_STATUSES } from '@/domain/transaction/state-machine';
import type { ContractTerms, ContractVersion, MilestoneTerm, Transaction, TransactionParty } from '@/domain/model';
import { normalizeVin } from '@/domain/vehicle/vin';
import {
    acceptContractSchema,
    amendContractSchema,
    createVehicleTransactionSchema,
    type CreateVehicleTransactionInput
} from '@/lib/validation/schemas';
import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { hashCanonical, randomToken, sha256Hex } from '@/server/security/crypto';
import { AppError, forbidden, notFound } from '@/server/errors';
import { storableValue, truncateText } from '@/server/text';
import { accessTransaction, audit, notify, securitySettings, type Deps } from './context';
import type { Workflow } from './workflow';
import { currentMilestones } from './workflow';

export interface RiskHook {
    evaluateInTx(db: Db, transactionId: string): Promise<void>;
}

function parseOrThrow<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
    input: unknown
): T {
    const r = schema.safeParse(input);
    if (!r.success) throw new AppError('VALIDATION', 'Invalid input', { issues: r.error.issues });
    return r.data;
}

export class TransactionService {
    risk!: RiskHook;

    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow
    ) {}

    private now() {
        return this.deps.clock.now().toISOString();
    }

    /**
     * The terms as stored (storable-text rule: lone surrogates as U+FFFD, U+0000 refused), so the content hash that
     * acceptances bind to is the hash of the stored terms, and an unchanged amendment is recognised as such.
     */
    private buildTerms(
        terms: Omit<ContractTerms, 'totalAmount' | 'milestones'>,
        amount: ReturnType<typeof parseMoney>,
        milestones: MilestoneTerm[]
    ): ContractTerms {
        return storableValue({ ...terms, totalAmount: toDTO(amount), milestones }, 'terms');
    }

    private async createVersion(
        db: Db,
        tx: Transaction,
        contractId: string,
        versionNumber: number,
        terms: ContractTerms,
        createdBy: string,
        changeSummary?: string
    ) {
        const stored = storableValue(terms, 'terms'); // hashed as stored (buildTerms already did it for its callers)
        const version: ContractVersion = {
            id: this.deps.ids.id(),
            contractId,
            transactionId: tx.id,
            versionNumber,
            terms: stored,
            contentHash: hashCanonical(stored),
            status: 'PROPOSED',
            changeSummary,
            createdBy,
            createdAt: this.now()
        };
        await db.contractVersions.insert(version);
        const amounts = allocateByBps(
            fromDTO(stored.totalAmount),
            stored.milestones.map((m) => m.shareBps)
        );
        for (const [i, m] of stored.milestones.entries()) {
            await db.milestones.insert({
                id: this.deps.ids.id(),
                transactionId: tx.id,
                contractVersionId: version.id,
                sequence: i + 1,
                key: m.key,
                title: m.title,
                description: m.description,
                shareBps: m.shareBps,
                amount: amounts[i]!,
                requiredEvidence: m.requiredEvidence,
                status: 'PENDING'
            });
        }
        return version;
    }

    async createVehicleTransaction(actor: Actor, rawInput: CreateVehicleTransactionInput) {
        const input = parseOrThrow(createVehicleTransactionSchema, rawInput);
        const milestoneIssues = validateMilestoneTerms(input.milestones);
        if (milestoneIssues.length) throw new AppError('VALIDATION', 'Invalid milestones', { milestoneIssues });
        const currency = input.price.currency as CurrencyCode;
        let amount;
        try {
            amount = parseMoney(input.price.amount, currency);
        } catch (e) {
            throw new AppError('VALIDATION', (e as Error).message);
        }
        if (amount.amountMinor <= 0n) throw new AppError('VALIDATION', 'Amount must be positive');
        if (input.buyer.email === actor.email.toLowerCase()) throw new AppError('VALIDATION', 'The buyer must be a different person');

        return this.deps.uow.run(async (db) => {
            const corridor = (
                await db.corridors.findBy({
                    originCountry: input.vehicle.originCountry,
                    destinationCountry: input.vehicle.destinationCountry
                })
            )[0];
            if (!corridor || !corridor.enabled) throw new AppError('VALIDATION', 'Corridor not supported', { field: 'corridor' });
            if (!corridor.allowedCurrencies.includes(currency))
                throw new AppError('VALIDATION', 'Currency not allowed on this corridor', { field: 'currency' });

            const user = await db.users.get(actor.userId);
            if (!user || user.status !== 'ACTIVE') throw forbidden();
            let organization;
            if (input.sellerOrganizationId) {
                const membership = await db.organizationMembers.findOne({
                    organizationId: input.sellerOrganizationId,
                    userId: actor.userId
                });
                if (!membership) throw forbidden('Not a member of this organization');
                organization = await db.organizations.get(input.sellerOrganizationId);
            }

            const now = this.now();
            const seq = await db.nextSequence('transaction_reference');
            const tx: Transaction = {
                id: this.deps.ids.id(),
                reference: `TC-${now.slice(0, 4)}-${String(seq).padStart(5, '0')}`,
                type: 'VEHICLE_PURCHASE',
                status: 'DRAFT',
                title: `${input.vehicle.make} ${input.vehicle.model} ${input.vehicle.year}`,
                amount,
                corridorId: corridor.id,
                sellerOrganizationId: organization?.id,
                createdBy: actor.userId,
                version: 1,
                createdAt: now,
                updatedAt: now,
                isDemo: this.deps.config.mode === 'demo'
            };
            await db.transactions.insert(tx);
            await db.transactionParties.insert({
                id: this.deps.ids.id(),
                transactionId: tx.id,
                role: 'SELLER',
                userId: actor.userId,
                organizationId: organization?.id,
                displayName: organization?.legalName ?? user.fullName,
                email: user.email,
                status: 'JOINED',
                joinedAt: now,
                createdAt: now
            });
            await db.transactionParties.insert({
                id: this.deps.ids.id(),
                transactionId: tx.id,
                role: 'BUYER',
                displayName: input.buyer.companyName ?? input.buyer.fullName,
                email: input.buyer.email,
                status: 'INVITED',
                createdAt: now
            });
            if (input.inspector) {
                await db.transactionParties.insert({
                    id: this.deps.ids.id(),
                    transactionId: tx.id,
                    role: 'INSPECTOR',
                    displayName: input.inspector.companyName ?? input.inspector.fullName,
                    email: input.inspector.email,
                    status: 'INVITED',
                    createdAt: now
                });
            }
            await db.vehicles.insert({
                id: this.deps.ids.id(),
                transactionId: tx.id,
                ...input.vehicle,
                vin: normalizeVin(input.vehicle.vin)
            });
            const contract = { id: this.deps.ids.id(), transactionId: tx.id, createdAt: now };
            await db.contracts.insert(contract);
            const version = await this.createVersion(
                db,
                tx,
                contract.id,
                1,
                this.buildTerms(input.terms, amount, input.milestones),
                actor.userId
            );
            const saved = await db.transactions.update(tx.id, { currentContractVersionId: version.id }, { expectedVersion: tx.version });
            await audit(
                this.deps,
                db,
                actor,
                'transaction.created',
                { type: 'transaction', id: tx.id },
                {
                    transactionId: tx.id,
                    metadata: { reference: tx.reference, amountMinor: amount.amountMinor.toString(), currency, contractVersion: 1 }
                }
            );
            await this.risk.evaluateInTx(db, tx.id);
            return saved;
        });
    }

    /** Moves DRAFT → AWAITING_PARTIES and issues single-use invitation links (returned once, stored hashed). */
    async sendInvitations(actor: Actor, transactionId: string) {
        return this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER'], write: true });
            const updated = await this.workflow.transition(db, tx, 'SEND_INVITATIONS', 'SELLER', actor);
            const links = await this.issueInvitations(db, actor, updated);
            return { transaction: updated, links };
        });
    }

    private async issueInvitations(db: Db, actor: Actor, tx: Transaction, onlyPartyId?: string) {
        const settings = await securitySettings(db);
        const parties = (await db.transactionParties.findBy({ transactionId: tx.id })).filter(
            (p) => p.status === 'INVITED' && (!onlyPartyId || p.id === onlyPartyId)
        );
        const links: { partyId: string; role: TransactionParty['role']; email: string; url: string }[] = [];
        for (const party of parties) {
            const token = randomToken();
            await db.transactionParties.update(party.id, {
                invitationTokenHash: sha256Hex(token),
                invitationExpiresAt: new Date(this.deps.clock.now().getTime() + settings.invitationTtlHours * 3_600_000).toISOString()
            });
            links.push({ partyId: party.id, role: party.role, email: party.email, url: `${this.deps.config.appUrl}/invite/${token}` });
            const existingUser = await db.users.findOne({ email: party.email });
            await notify(this.deps, db, existingUser?.id, 'invitation.received', { reference: tx.reference, title: tx.title }, tx.id);
            await audit(
                this.deps,
                db,
                actor,
                'party.invited',
                { type: 'transaction_party', id: party.id },
                { transactionId: tx.id, metadata: { role: party.role } }
            );
        }
        return links;
    }

    async regenerateInvitation(actor: Actor, transactionId: string, partyId: string) {
        return this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER'], write: true });
            if (tx.status === 'DRAFT' || ['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(tx.status))
                throw new AppError('PRECONDITION_FAILED', 'Invitations cannot be issued in this state');
            const links = await this.issueInvitations(db, actor, tx, partyId);
            if (!links.length) throw notFound('Pending invitation');
            return links[0]!;
        });
    }

    private async findInvitation(db: Db, token: string) {
        if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
        const party = await db.transactionParties.findOne({ invitationTokenHash: sha256Hex(token) });
        if (!party || party.status !== 'INVITED') return undefined;
        if (!party.invitationExpiresAt || new Date(party.invitationExpiresAt) < this.deps.clock.now()) return undefined;
        return party;
    }

    /** Minimal, non-sensitive summary shown to the holder of a valid invitation link. */
    async previewInvitation(token: string) {
        return this.deps.uow.run(async (db) => {
            const party = await this.findInvitation(db, token);
            if (!party) throw notFound('Invitation');
            const tx = (await db.transactions.get(party.transactionId))!;
            const seller = await db.transactionParties.findOne({ transactionId: tx.id, role: 'SELLER' });
            const vehicle = await db.vehicles.findOne({ transactionId: tx.id });
            const [local, domain] = party.email.split('@');
            return {
                reference: tx.reference,
                title: tx.title,
                amount: toDTO(tx.amount),
                role: party.role,
                sellerName: seller?.displayName ?? '',
                vehicle: vehicle
                    ? {
                          make: vehicle.make,
                          model: vehicle.model,
                          year: vehicle.year,
                          originCountry: vehicle.originCountry,
                          destinationCountry: vehicle.destinationCountry
                      }
                    : undefined,
                inviteeEmailMasked: `${truncateText(local!, 2)}•••@${domain}`,
                expiresAt: party.invitationExpiresAt!
            };
        });
    }

    /** Invitations addressed to the signed-in user's (verified) email address. */
    async pendingInvitations(actor: Actor) {
        return this.deps.uow.run(async (db) => {
            const parties = (await db.transactionParties.findBy({ email: actor.email.toLowerCase(), status: 'INVITED' })).filter(
                (p) => p.invitationExpiresAt && new Date(p.invitationExpiresAt) > this.deps.clock.now()
            );
            return Promise.all(
                parties.map(async (p) => {
                    const tx = (await db.transactions.get(p.transactionId))!;
                    const seller = await db.transactionParties.findOne({ transactionId: tx.id, role: 'SELLER' });
                    return {
                        partyId: p.id,
                        role: p.role,
                        reference: tx.reference,
                        title: tx.title,
                        amount: toDTO(tx.amount),
                        sellerName: seller?.displayName ?? ''
                    };
                })
            );
        });
    }

    /** In-app equivalent of the emailed link, for a signed-in user whose email matches the invitation. */
    async acceptInvitationForParty(actor: Actor, partyId: string) {
        return this.joinParty(actor, async (db) => {
            const party = await db.transactionParties.get(partyId);
            if (
                !party ||
                party.status !== 'INVITED' ||
                !party.invitationExpiresAt ||
                new Date(party.invitationExpiresAt) < this.deps.clock.now()
            )
                return undefined;
            return party;
        });
    }

    async acceptInvitation(actor: Actor, token: string) {
        return this.joinParty(actor, (db) => this.findInvitation(db, token));
    }

    private async joinParty(actor: Actor, find: (db: Db) => Promise<TransactionParty | undefined>) {
        return this.deps.uow.run(async (db) => {
            const party = await find(db);
            if (!party) throw notFound('Invitation');
            if (party.email.toLowerCase() !== actor.email.toLowerCase()) {
                await audit(
                    this.deps,
                    db,
                    actor,
                    'party.invitation_rejected_wrong_account',
                    { type: 'transaction_party', id: party.id },
                    { transactionId: party.transactionId }
                );
                throw forbidden('This invitation was issued to another email address');
            }
            const already = (await db.transactionParties.findBy({ transactionId: party.transactionId, userId: actor.userId })).filter(
                (p) => p.status === 'JOINED'
            );
            if (already.length) throw new AppError('CONFLICT', 'You are already a party to this transaction');
            const now = this.now();
            await db.transactionParties.update(party.id, {
                userId: actor.userId,
                status: 'JOINED',
                joinedAt: now,
                invitationTokenHash: undefined
            });
            const tx = (await db.transactions.get(party.transactionId))!;
            await audit(
                this.deps,
                db,
                actor,
                'party.joined',
                { type: 'transaction_party', id: party.id },
                { transactionId: tx.id, metadata: { role: party.role } }
            );
            const seller = await db.transactionParties.findOne({ transactionId: tx.id, role: 'SELLER' });
            await notify(this.deps, db, seller?.userId, 'party.joined', { reference: tx.reference, role: party.role }, tx.id);
            const advanced = await this.workflow.autoAdvance(db, tx.id);
            await this.risk.evaluateInTx(db, tx.id);
            return advanced;
        });
    }

    async declineInvitation(actor: Actor, token: string, reason?: string) {
        const kept = reason === undefined ? undefined : truncateText(reason, 500);
        return this.deps.uow.run(async (db) => {
            const party = await this.findInvitation(db, token);
            if (!party) throw notFound('Invitation');
            if (party.email.toLowerCase() !== actor.email.toLowerCase())
                throw forbidden('This invitation was issued to another email address');
            await db.transactionParties.update(party.id, { status: 'DECLINED', invitationTokenHash: undefined });
            const tx = (await db.transactions.get(party.transactionId))!;
            await audit(
                this.deps,
                db,
                actor,
                'party.declined',
                { type: 'transaction_party', id: party.id },
                { transactionId: tx.id, metadata: { reason: kept } }
            );
            const seller = await db.transactionParties.findOne({ transactionId: tx.id, role: 'SELLER' });
            await notify(this.deps, db, seller?.userId, 'party.declined', { reference: tx.reference }, tx.id);
        });
    }

    async cancel(actor: Actor, transactionId: string, reason: string) {
        if (!reason.trim()) throw new AppError('VALIDATION', 'A reason is required');
        const kept = truncateText(reason, 500);
        return this.deps.uow.run(async (db) => {
            const { tx, party } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER', 'BUYER'], write: true });
            const updated = await this.workflow.transition(db, tx, 'CANCEL', party!.role as 'SELLER' | 'BUYER', actor, {
                patch: { cancellationReason: kept, closedAt: this.now() },
                metadata: { reason: kept }
            });
            for (const i of await db.paymentInstructions.findBy({ transactionId, status: 'CREATED' })) {
                await db.paymentInstructions.update(i.id, { status: 'CANCELLED', updatedAt: this.now() });
            }
            for (const p of await db.transactionParties.findBy({ transactionId })) {
                if (p.userId && p.userId !== actor.userId)
                    await notify(this.deps, db, p.userId, 'transaction.cancelled', { reference: tx.reference }, tx.id);
            }
            return updated;
        });
    }

    /* ------------------------------------------------------------------ contract */

    async decideContract(actor: Actor, transactionId: string, rawInput: unknown) {
        const input = parseOrThrow(acceptContractSchema, rawInput);
        return this.deps.uow.run(async (db) => {
            const { tx, party } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER', 'BUYER'], write: true });
            if (!['DRAFT', 'AWAITING_PARTIES', 'IDENTITY_VERIFICATION', 'AWAITING_AGREEMENT'].includes(tx.status)) {
                throw new AppError('PRECONDITION_FAILED', 'Contract decisions are closed in this state', { status: tx.status });
            }
            const user = (await db.users.get(actor.userId))!;
            if (input.decision === 'ACCEPTED' && user.kycStatus !== 'VERIFIED') {
                throw new AppError('PRECONDITION_FAILED', 'Identity verification is required before accepting a contract', {
                    failedGuards: ['KYC_INCOMPLETE']
                });
            }
            const version = await db.contractVersions.get(input.contractVersionId);
            if (!version || version.transactionId !== tx.id) throw notFound('Contract version');
            if (version.id !== tx.currentContractVersionId || version.contentHash !== input.contentHash) {
                throw new AppError('CONFLICT', 'The contract has changed. Please review the latest version before deciding.');
            }
            const existing = await db.contractAcceptances.findOne({ contractVersionId: version.id, partyId: party!.id });
            if (existing) throw new AppError('CONFLICT', 'You already recorded a decision on this version');
            await db.contractAcceptances.insert({
                id: this.deps.ids.id(),
                transactionId: tx.id,
                contractVersionId: version.id,
                partyId: party!.id,
                userId: actor.userId,
                decision: input.decision,
                contentHash: version.contentHash,
                comment: input.comment,
                decidedAt: this.now()
            });
            await audit(
                this.deps,
                db,
                actor,
                input.decision === 'ACCEPTED' ? 'contract.accepted' : 'contract.declined',
                { type: 'contract_version', id: version.id },
                {
                    transactionId: tx.id,
                    metadata: { versionNumber: version.versionNumber, contentHash: version.contentHash, role: party!.role }
                }
            );
            const other = (await db.transactionParties.findBy({ transactionId: tx.id })).find(
                (p) => p.id !== party!.id && (p.role === 'SELLER' || p.role === 'BUYER')
            );
            await notify(
                this.deps,
                db,
                other?.userId,
                input.decision === 'ACCEPTED' ? 'contract.accepted' : 'contract.declined',
                { reference: tx.reference },
                tx.id
            );
            const advanced = await this.workflow.autoAdvance(db, tx.id);
            if (advanced.status === 'AWAITING_FUNDING') await db.contractVersions.update(version.id, { status: 'ACCEPTED' });
            return advanced;
        });
    }

    /** Creates a new contract version. Every party must accept again (acceptances bind to the content hash). */
    async amendContract(actor: Actor, transactionId: string, rawInput: unknown) {
        const input = parseOrThrow(amendContractSchema, rawInput);
        const issues = validateMilestoneTerms(input.milestones);
        if (issues.length) throw new AppError('VALIDATION', 'Invalid milestones', { milestoneIssues: issues });
        return this.deps.uow.run(async (db) => {
            const { tx } = await accessTransaction(db, actor, transactionId, { roles: ['SELLER'], write: true });
            if (!(PRE_FUNDING_STATUSES as readonly string[]).includes(tx.status))
                throw new AppError('PRECONDITION_FAILED', 'The contract can no longer be amended', { status: tx.status });
            const currency = input.price.currency as CurrencyCode;
            const corridor = await db.corridors.get(tx.corridorId);
            if (!corridor?.allowedCurrencies.includes(currency)) throw new AppError('VALIDATION', 'Currency not allowed on this corridor');
            const amount = parseMoney(input.price.amount, currency);
            const previous = (await db.contractVersions.get(tx.currentContractVersionId!))!;
            const { changeSummary, ...rest } = input;
            const terms = this.buildTerms(rest.terms, amount, rest.milestones);
            if (hashCanonical(terms) === previous.contentHash)
                throw new AppError('VALIDATION', 'No change compared with the current version');
            const version = await this.createVersion(
                db,
                tx,
                previous.contractId,
                previous.versionNumber + 1,
                terms,
                actor.userId,
                changeSummary
            );
            await db.contractVersions.update(previous.id, { status: 'SUPERSEDED' });
            for (const m of await db.milestones.findBy({ contractVersionId: previous.id }))
                await db.milestones.update(m.id, { status: 'CANCELLED' });
            for (const i of await db.paymentInstructions.findBy({ transactionId: tx.id, status: 'CREATED' })) {
                await db.paymentInstructions.update(i.id, {
                    status: 'CANCELLED',
                    updatedAt: this.now(),
                    failureReason: 'Superseded by contract amendment'
                });
            }
            const patch = { currentContractVersionId: version.id, amount, title: tx.title };
            const changedFields = diffTerms(previous.terms, terms);
            let updated: Transaction;
            if (tx.status === 'AWAITING_AGREEMENT' || tx.status === 'AWAITING_FUNDING') {
                updated = await this.workflow.transition(db, { ...tx }, 'CONTRACT_AMENDED', 'SELLER', actor, {
                    patch,
                    extra: { milestonesShareBps: totalShareBps(rest.milestones) },
                    metadata: { versionNumber: version.versionNumber, changedFields }
                });
            } else {
                updated = await db.transactions.update(tx.id, { ...patch, updatedAt: this.now() }, { expectedVersion: tx.version });
                await audit(
                    this.deps,
                    db,
                    actor,
                    'transaction.contract_amended',
                    { type: 'transaction', id: tx.id },
                    { transactionId: tx.id, metadata: { versionNumber: version.versionNumber, changedFields } }
                );
            }
            const buyer = await db.transactionParties.findOne({ transactionId: tx.id, role: 'BUYER' });
            await notify(
                this.deps,
                db,
                buyer?.userId,
                'contract.amended',
                { reference: tx.reference, version: String(version.versionNumber) },
                tx.id
            );
            await this.risk.evaluateInTx(db, tx.id);
            return updated;
        });
    }

    /* ------------------------------------------------------------------ queries */

    async listForActor(actor: Actor) {
        return this.deps.uow.run(async (db) => {
            const own = await db.transactionParties.findBy({ userId: actor.userId });
            const memberships = await db.organizationMembers.findBy({ userId: actor.userId });
            const orgParties = (
                await Promise.all(memberships.map((m) => db.transactionParties.findBy({ organizationId: m.organizationId })))
            ).flat();
            const ids = new Set(
                [...own.filter((p) => p.status === 'JOINED'), ...orgParties.filter((p) => p.status === 'JOINED')].map(
                    (p) => p.transactionId
                )
            );
            const txs = (await Promise.all([...ids].map((id) => db.transactions.get(id)))).filter((t): t is Transaction => Boolean(t));
            return Promise.all(
                txs
                    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                    .map(async (t) => {
                        const parties = await db.transactionParties.findBy({ transactionId: t.id });
                        const mine = parties.find((p) => p.userId === actor.userId && p.status === 'JOINED');
                        const counterparty = parties.find((p) => (mine?.role === 'BUYER' ? p.role === 'SELLER' : p.role === 'BUYER'));
                        return { transaction: t, myRole: mine?.role, counterpartyName: counterparty?.displayName ?? '' };
                    })
            );
        });
    }

    async milestonesOf(db: Db, tx: Transaction) {
        return currentMilestones(db, tx);
    }
}
