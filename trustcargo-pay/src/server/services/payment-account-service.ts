import { payoutAccountSchema } from '@/lib/validation/schemas';
import type { CurrencyCode } from '@/domain/money';
import type { PaymentAccount } from '@/domain/model';
import type { Actor } from '@/server/auth/actor';
import { mfaIsRecent } from '@/server/auth/actor';
import { AppError, forbidden } from '@/server/errors';
import { randomToken } from '@/server/security/crypto';
import { audit, notify, securitySettings, type Deps } from './context';
import type { RiskService } from './risk-service';

/**
 * Payout (beneficiary) accounts. TrustCargo stores only a masked identifier and the partner's
 * vault token: full account numbers are collected by the partner's hosted form (simulated here).
 */
export class PaymentAccountService {
    constructor(
        private readonly deps: Deps,
        private readonly risk: RiskService
    ) {}

    async listOwn(actor: Actor) {
        return this.deps.uow.run(async (db) => {
            const memberships = await db.organizationMembers.findBy({ userId: actor.userId });
            const own = await db.paymentAccounts.findBy({ ownerType: 'USER', ownerId: actor.userId });
            const org = (
                await Promise.all(
                    memberships.map((m) => db.paymentAccounts.findBy({ ownerType: 'ORGANIZATION', ownerId: m.organizationId }))
                )
            ).flat();
            return [...own, ...org].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        });
    }

    async addOrReplace(actor: Actor, rawInput: unknown, owner: { type: 'USER' | 'ORGANIZATION'; id: string }) {
        const parsed = payoutAccountSchema.safeParse(rawInput);
        if (!parsed.success) throw new AppError('VALIDATION', 'Invalid account', { issues: parsed.error.issues });
        const input = parsed.data;
        return this.deps.uow.run(async (db) => {
            const settings = await securitySettings(db);
            if (!mfaIsRecent(actor, settings.sensitiveActionMfaMaxAgeMinutes, this.deps.clock.now())) {
                throw new AppError('MFA_REQUIRED', 'Changing payout details requires a recent MFA verification');
            }
            if (owner.type === 'USER' && owner.id !== actor.userId) throw forbidden();
            if (owner.type === 'ORGANIZATION') {
                const m = await db.organizationMembers.findOne({ organizationId: owner.id, userId: actor.userId });
                if (!m || m.role === 'MEMBER') throw forbidden('Only organization owners/admins can change payout details');
            }
            const now = this.deps.clock.now().toISOString();
            const previous = (
                await db.paymentAccounts.findBy({ ownerType: owner.type, ownerId: owner.id, currency: input.currency as CurrencyCode })
            ).find((a) => a.status !== 'DISABLED');
            if (previous) await db.paymentAccounts.update(previous.id, { status: 'DISABLED', disabledAt: now });
            const account: PaymentAccount = {
                id: this.deps.ids.id(),
                ownerType: owner.type,
                ownerId: owner.id,
                holderName: input.holderName,
                currency: input.currency as CurrencyCode,
                country: input.country,
                bankName: input.bankName,
                maskedIdentifier: `•••• ${input.last4}`,
                providerToken: `sim_vault_${randomToken(12)}`,
                // Simulation: the partner would verify ownership (e.g. micro-deposits / account validation API).
                status: 'VERIFIED',
                createdAt: now,
                verifiedAt: now,
                replacesAccountId: previous?.id
            };
            await db.paymentAccounts.insert(account);
            await audit(
                this.deps,
                db,
                actor,
                previous ? 'payment_account.replaced' : 'payment_account.added',
                { type: 'payment_account', id: account.id },
                {
                    metadata: { ownerType: owner.type, currency: account.currency, replaces: previous?.id }
                }
            );
            await notify(this.deps, db, actor.userId, 'security.payout_account_changed', { masked: account.maskedIdentifier });
            const parties =
                owner.type === 'USER'
                    ? await db.transactionParties.findBy({ userId: owner.id })
                    : await db.transactionParties.findBy({ organizationId: owner.id });
            for (const p of parties) await this.risk.evaluateInTx(db, p.transactionId);
            return account;
        });
    }
}
