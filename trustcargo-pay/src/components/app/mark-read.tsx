'use client';
import { markNotificationsReadAction } from '@/app/actions/account';
import { ActionForm, SubmitButton } from './action-form';
import { useI18n } from './i18n-provider';

export function MarkAllRead() {
    const { t } = useI18n();
    return (
        <ActionForm action={markNotificationsReadAction}>
            <SubmitButton variant="secondary" size="sm">
                {t('notifications.markAll')}
            </SubmitButton>
        </ActionForm>
    );
}
