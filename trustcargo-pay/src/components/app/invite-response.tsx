'use client';
import { useRouter } from 'next/navigation';
import { acceptInvitationAction, declineInvitationAction } from '@/app/actions/transactions';
import type { ActionState } from '@/lib/action-state';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

export function InviteResponse({ token }: { token: string }) {
    const { t } = useI18n();
    const router = useRouter();
    return (
        <div className="flex flex-col gap-2 sm:flex-row">
            <ActionForm
                action={acceptInvitationAction}
                onSuccess={(s: ActionState) => router.push(`/transactions/${s.data as string}?tab=contract`)}
            >
                <input type="hidden" name="token" value={token} />
                <SubmitButton data-testid="join-transaction">{t('invite.join')}</SubmitButton>
            </ActionForm>
            <ActionForm action={declineInvitationAction} onSuccess={() => router.push('/dashboard')}>
                <input type="hidden" name="token" value={token} />
                <SubmitButton variant="secondary">{t('invite.decline')}</SubmitButton>
            </ActionForm>
        </div>
    );
}
