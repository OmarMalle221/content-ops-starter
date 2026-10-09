'use server';
import type { ActionState } from '@/lib/action-state';
import { runAction, str } from './_run';

export async function startKycAction(_: ActionState) {
    return runAction(async ({ app, actor }) => (await app.identity.start(actor)).id, {
        revalidate: ['/verification'],
        rateLimit: { key: 'kyc', limit: 10, windowMs: 3_600_000 }
    });
}

export async function completeKycAction(_: ActionState, form: FormData) {
    const outcome = str(form, 'outcome');
    return runAction(
        async ({ app, actor }) =>
            (
                await app.identity.complete(
                    actor,
                    str(form, 'verificationId'),
                    outcome === 'REJECT' ? 'REJECT' : outcome === 'REVIEW' ? 'REVIEW' : 'APPROVE'
                )
            ).status,
        {
            revalidate: ['/verification', '/dashboard']
        }
    );
}

export async function addPayoutAccountAction(_: ActionState, form: FormData) {
    return runAction(
        async ({ app, actor }) => {
            const [type, id] = str(form, 'owner').split(':') as ['USER' | 'ORGANIZATION', string];
            const account = await app.paymentAccounts.addOrReplace(
                actor,
                {
                    holderName: str(form, 'holderName'),
                    bankName: str(form, 'bankName'),
                    country: str(form, 'country'),
                    currency: str(form, 'currency'),
                    last4: str(form, 'last4')
                },
                { type, id }
            );
            return account.maskedIdentifier;
        },
        { revalidate: ['/settings'], rateLimit: { key: 'payout-account', limit: 5, windowMs: 3_600_000 } }
    );
}

export async function markNotificationsReadAction(_: ActionState) {
    return runAction(async ({ app, actor }) => app.notifications.markAllRead(actor), { revalidate: ['/notifications'] });
}
