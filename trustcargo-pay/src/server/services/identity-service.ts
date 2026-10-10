import type { Db } from '@/server/ports/db';
import type { Actor } from '@/server/auth/actor';
import { SYSTEM, hasRole } from '@/server/auth/actor';
import { AppError, forbidden, notFound } from '@/server/errors';
import { audit, notify, type Deps } from './context';
import type { Workflow } from './workflow';
import type { RiskService } from './risk-service';

export class IdentityService {
    constructor(
        private readonly deps: Deps,
        private readonly workflow: Workflow,
        private readonly risk: RiskService
    ) {}

    /** Starts a (simulated) KYC session with the identity provider. */
    async start(actor: Actor) {
        const user = await this.deps.uow.run(async (db) => {
            const u = await db.users.get(actor.userId);
            if (!u) throw notFound('User');
            if (u.kycStatus === 'VERIFIED') throw new AppError('CONFLICT', 'Identity already verified');
            return u;
        });
        const { providerReference } = await this.deps.identity.startVerification({
            id: user.id,
            fullName: user.fullName,
            country: user.country
        });
        return this.deps.uow.run(async (db) => {
            const now = this.deps.clock.now().toISOString();
            const verification = await db.identityVerifications.insert({
                id: this.deps.ids.id(),
                subjectType: 'USER',
                subjectId: user.id,
                provider: this.deps.identity.name,
                providerReference,
                status: 'PENDING',
                level: 'BASIC',
                checks: [],
                simulated: this.deps.identity.simulated,
                createdAt: now
            });
            await db.users.update(user.id, { kycStatus: 'PENDING' });
            await audit(
                this.deps,
                db,
                actor,
                'kyc.started',
                { type: 'identity_verification', id: verification.id },
                { metadata: { provider: this.deps.identity.name } }
            );
            return verification;
        });
    }

    /**
     * Fetches the provider result. In simulation, `outcome` selects the simulated result; with a real
     * provider this would be driven by the provider's signed callback instead.
     */
    async complete(actor: Actor, verificationId: string, outcome: 'APPROVE' | 'REJECT' | 'REVIEW' = 'APPROVE') {
        const verification = await this.deps.uow.run(async (db) => {
            const v = await db.identityVerifications.get(verificationId);
            if (!v || v.subjectId !== actor.userId) throw notFound('Verification');
            if (v.status !== 'PENDING') throw new AppError('CONFLICT', 'Verification already completed');
            return v;
        });
        const result = await this.deps.identity.fetchResult(
            verification.providerReference,
            this.deps.identity.simulated ? outcome : undefined
        );
        const user = await this.deps.uow.run(async (db) => db.users.get(actor.userId));
        const screening =
            result.status === 'VERIFIED'
                ? await this.deps.screening.screen({ id: user!.id, type: 'USER', name: user!.fullName, country: user!.country })
                : undefined;
        return this.deps.uow.run(async (db) => {
            const now = this.deps.clock.now().toISOString();
            const updated = await db.identityVerifications.update(verificationId, {
                status: result.status,
                verifiedName: result.verifiedName,
                documentType: result.documentType,
                documentCountry: result.documentCountry,
                documentExpiresAt: result.documentExpiresAt,
                checks: result.checks,
                completedAt: result.status === 'PENDING' ? undefined : now
            });
            await db.users.update(actor.userId, { kycStatus: result.status === 'PENDING' ? 'PENDING' : result.status });
            if (screening) {
                await db.screeningResults.insert({
                    id: this.deps.ids.id(),
                    subjectType: 'USER',
                    subjectId: actor.userId,
                    provider: this.deps.screening.name,
                    simulated: this.deps.screening.simulated,
                    checkedAt: now,
                    ...screening
                });
            }
            await audit(
                this.deps,
                db,
                SYSTEM,
                'kyc.result_received',
                { type: 'identity_verification', id: verificationId },
                { metadata: { status: result.status, simulated: this.deps.identity.simulated } }
            );
            await this.afterKycChange(db, actor.userId);
            return updated;
        });
    }

    /** Manual decision by a compliance analyst on a verification flagged for review. */
    async review(actor: Actor, verificationId: string, decision: 'VERIFIED' | 'REJECTED', note: string) {
        if (!hasRole(actor, 'compliance_analyst')) throw forbidden();
        if (note.trim().length < 5) throw new AppError('VALIDATION', 'A justification is required');
        return this.deps.uow.run(async (db) => {
            const v = await db.identityVerifications.get(verificationId);
            if (!v) throw notFound('Verification');
            if (v.status !== 'PENDING') throw new AppError('CONFLICT', 'Only pending verifications can be reviewed');
            if (v.subjectId === actor.userId) throw forbidden('You cannot review your own verification');
            const now = this.deps.clock.now().toISOString();
            const updated = await db.identityVerifications.update(verificationId, {
                status: decision,
                reviewedBy: actor.userId,
                reviewNote: note,
                completedAt: now
            });
            if (v.subjectType === 'USER') {
                await db.users.update(v.subjectId, { kycStatus: decision });
                await notify(this.deps, db, v.subjectId, decision === 'VERIFIED' ? 'kyc.verified' : 'kyc.rejected', {});
                await this.afterKycChange(db, v.subjectId);
            } else {
                await db.organizations.update(v.subjectId, { kybStatus: decision });
            }
            await audit(
                this.deps,
                db,
                actor,
                'kyc.reviewed',
                { type: 'identity_verification', id: verificationId },
                { metadata: { decision } }
            );
            return updated;
        });
    }

    private async afterKycChange(db: Db, userId: string) {
        for (const party of await db.transactionParties.findBy({ userId })) {
            await this.workflow.autoAdvance(db, party.transactionId);
            await this.risk.evaluateInTx(db, party.transactionId);
        }
    }

    async listPending(actor: Actor) {
        if (!hasRole(actor, 'compliance_analyst', 'auditor')) throw forbidden();
        return this.deps.uow.run(async (db) => {
            const all = await db.identityVerifications.list();
            return Promise.all(
                all
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map(async (v) => ({
                        verification: v,
                        subjectName:
                            v.subjectType === 'USER'
                                ? (await db.users.get(v.subjectId))?.fullName
                                : (await db.organizations.get(v.subjectId))?.legalName
                    }))
            );
        });
    }
}
