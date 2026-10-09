import { PageHeader } from '@/components/app/layout-bits';
import { CreateWizard } from '@/components/wizard/create-wizard';
import { getI18n } from '@/i18n/server';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Nouvelle transaction' };

export default async function NewTransactionPage() {
    const actor = await requireActor();
    const { t } = await getI18n();
    const app = await getApp();
    const { organizations, user, corridor } = await app.deps.uow.run(async (db) => {
        const memberships = await db.organizationMembers.findBy({ userId: actor.userId });
        const orgs = (await Promise.all(memberships.map((m) => db.organizations.get(m.organizationId)))).filter(
            (o): o is NonNullable<typeof o> => Boolean(o)
        );
        return {
            organizations: orgs
                .filter((o) => o.type === 'DEALER' || o.type === 'EXPORTER')
                .map((o) => ({ id: o.id, legalName: o.legalName })),
            user: await db.users.get(actor.userId),
            corridor: await db.corridors.findOne({ code: 'CA-SN' })
        };
    });
    return (
        <>
            <PageHeader title={t('wizard.title')} description={t('app.notABank')} />
            <CreateWizard
                organizations={organizations}
                currencies={corridor?.allowedCurrencies ?? ['CAD']}
                kycVerified={user?.kycStatus === 'VERIFIED'}
            />
        </>
    );
}
