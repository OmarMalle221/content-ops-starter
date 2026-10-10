'use client';
import * as React from 'react';
import { acceptInvitationForPartyAction, pendingInvitationsAction } from '@/app/actions/transactions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fmtMoney } from '@/lib/format';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

type Invitation = NonNullable<Awaited<ReturnType<typeof pendingInvitationsAction>>['data']>[number];

/**
 * Invitations addressed to the signed-in user. Loaded through a server action, not while rendering the page: with
 * Supabase Auth the e-mail they are matched on is first re-checked with the provider, which may refresh its session
 * cookies (only an action or a route handler can write them back).
 */
export function PendingInvitations() {
    const { t, intl } = useI18n();
    const [invitations, setInvitations] = React.useState<Invitation[]>([]);
    React.useEffect(() => {
        let current = true;
        void pendingInvitationsAction().then((r) => {
            if (current && r.ok && r.data) setInvitations(r.data);
        });
        return () => {
            current = false;
        };
    }, []);
    if (invitations.length === 0) return null;
    return (
        <Card className="mb-6">
            <CardHeader>
                <CardTitle>{t('dashboard.invitations')}</CardTitle>
            </CardHeader>
            <CardContent className="divide-y p-0">
                {invitations.map((inv) => (
                    <div key={inv.partyId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm font-medium">
                                {inv.title} · <span className="text-muted-foreground">{inv.reference}</span>
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {t('invite.from', { seller: inv.sellerName, role: t(`partyRole.${inv.role}`) })} —{' '}
                                {fmtMoney(inv.amount, intl)}
                            </p>
                        </div>
                        <ActionForm
                            action={acceptInvitationForPartyAction}
                            successMessage={t('common.success')}
                            onSuccess={() => setInvitations((list) => list.filter((x) => x.partyId !== inv.partyId))}
                        >
                            <input type="hidden" name="partyId" value={inv.partyId} />
                            <SubmitButton size="sm">{t('dashboard.acceptInvitation')}</SubmitButton>
                        </ActionForm>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
