import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/app/layout-bits';
import { getI18n } from '@/i18n/server';

export default async function NotFound() {
    const { t } = await getI18n();
    return (
        <EmptyState icon={SearchX} title={t('errors.NOT_FOUND')}>
            <Link href="/transactions" className="font-medium text-primary underline">
                {t('nav.transactions')}
            </Link>
        </EmptyState>
    );
}
