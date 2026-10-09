'use client';
import * as React from 'react';
import { Send } from 'lucide-react';
import { regenerateInvitationAction, sendInvitationsAction } from '@/app/actions/transactions';
import { ActionForm, SubmitButton } from '@/components/app/action-form';
import { useI18n } from '@/components/app/i18n-provider';
import type { ActionState } from '@/lib/action-state';
import { InviteLinks } from './invite-links';

type Links = { role: string; email: string; url: string }[];

export function SendInvitations({ transactionId }: { transactionId: string }) {
    const { t } = useI18n();
    const [links, setLinks] = React.useState<Links>();
    return links ? (
        <InviteLinks links={links} />
    ) : (
        <ActionForm action={sendInvitationsAction} onSuccess={(s: ActionState) => setLinks(s.data as Links)}>
            <input type="hidden" name="transactionId" value={transactionId} />
            <SubmitButton>
                <Send aria-hidden /> {t('tx.invite')}
            </SubmitButton>
        </ActionForm>
    );
}

export function RegenerateInvitation({ transactionId, partyId }: { transactionId: string; partyId: string }) {
    const { t } = useI18n();
    const [links, setLinks] = React.useState<Links>();
    return links ? (
        <InviteLinks links={links} />
    ) : (
        <ActionForm action={regenerateInvitationAction} onSuccess={(s: ActionState) => setLinks(s.data as Links)}>
            <input type="hidden" name="transactionId" value={transactionId} />
            <input type="hidden" name="partyId" value={partyId} />
            <SubmitButton size="sm" variant="secondary">
                {t('tx.regenerate')}
            </SubmitButton>
        </ActionForm>
    );
}
