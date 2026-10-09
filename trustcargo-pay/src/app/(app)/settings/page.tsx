import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { PageHeader, KeyValue, Mono } from '@/components/app/layout-bits';
import { PayoutAccountForm } from '@/components/app/payout-account-form';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate, fmtPct } from '@/lib/format';
import { requireActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export const metadata = { title: 'Paramètres' };

export default async function SettingsPage() {
    const actor = await requireActor();
    const { t, intl } = await getI18n();
    const app = await getApp();
    const { user, orgs } = await app.deps.uow.run(async (db) => {
        const memberships = await db.organizationMembers.findBy({ userId: actor.userId });
        const orgs = await Promise.all(
            memberships.map(async (m) => ({
                membership: m,
                org: (await db.organizations.get(m.organizationId))!,
                owners: await db.beneficialOwners.findBy({ organizationId: m.organizationId }),
                members: await Promise.all(
                    (await db.organizationMembers.findBy({ organizationId: m.organizationId })).map(async (x) => ({
                        role: x.role,
                        name: (await db.users.get(x.userId))?.fullName ?? ''
                    }))
                )
            }))
        );
        return { user: (await db.users.get(actor.userId))!, orgs };
    });
    const accounts = await app.paymentAccounts.listOwn(actor);
    const owners = [
        { value: `USER:${user.id}`, label: user.fullName },
        ...orgs.filter((o) => o.membership.role !== 'MEMBER').map((o) => ({ value: `ORGANIZATION:${o.org.id}`, label: o.org.legalName }))
    ];
    return (
        <>
            <PageHeader title={t('settings.title')} />
            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('settings.profile')}</CardTitle>
                        <ToneBadge tone={toneFor(user.kycStatus)}>KYC : {t(`kyc.${user.kycStatus}`)}</ToneBadge>
                    </CardHeader>
                    <CardContent>
                        <KeyValue
                            items={[
                                { label: 'Nom', value: user.fullName },
                                { label: 'Courriel', value: user.email },
                                { label: 'Ville', value: `${user.city ?? ''} (${user.country})` },
                                { label: 'Rôles', value: user.platformRoles.join(', ') || '—' }
                            ]}
                        />
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <KeyRound className="size-4 text-muted-foreground" aria-hidden /> {t('settings.mfa')}
                        </CardTitle>
                        <ToneBadge tone="success">{t('settings.mfaActive')}</ToneBadge>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            {actor.mfaVerifiedAt ? t('settings.mfaLast', { date: fmtDate(actor.mfaVerifiedAt, intl, true) }) : t('mfa.why')}
                        </p>
                        <Link href="/mfa?next=/settings" className="text-sm font-medium text-primary underline">
                            {t('settings.mfaVerifyNow')}
                        </Link>
                    </CardContent>
                </Card>
                <Card className="lg:col-span-2">
                    <CardHeader className="block">
                        <CardTitle>{t('settings.payoutAccounts')}</CardTitle>
                        <CardDescription>{t('settings.payoutHelp')}</CardDescription>
                    </CardHeader>
                    {accounts.length > 0 && (
                        <Table>
                            <THead>
                                <tr>
                                    <TH>{t('settings.holder')}</TH>
                                    <TH>{t('settings.bank')}</TH>
                                    <TH>Compte</TH>
                                    <TH>{t('wizard.currency')}</TH>
                                    <TH>{t('common.status')}</TH>
                                    <TH>{t('common.date')}</TH>
                                </tr>
                            </THead>
                            <TBody>
                                {accounts.map((a) => (
                                    <TR key={a.id}>
                                        <TD>{a.holderName}</TD>
                                        <TD>{a.bankName}</TD>
                                        <TD>
                                            <Mono>{a.maskedIdentifier}</Mono>
                                        </TD>
                                        <TD>{a.currency}</TD>
                                        <TD>
                                            <ToneBadge tone={a.status === 'VERIFIED' ? 'success' : 'neutral'}>{a.status}</ToneBadge>
                                        </TD>
                                        <TD className="text-xs">{fmtDate(a.createdAt, intl)}</TD>
                                    </TR>
                                ))}
                            </TBody>
                        </Table>
                    )}
                    <CardContent className="border-t">
                        <PayoutAccountForm owners={owners} />
                    </CardContent>
                </Card>
                {orgs.map(({ org, owners: bos, members }) => (
                    <Card key={org.id}>
                        <CardHeader>
                            <CardTitle>
                                {t('settings.organization')} — {org.legalName}
                            </CardTitle>
                            <ToneBadge tone={toneFor(org.kybStatus)}>KYB : {t(`kyc.${org.kybStatus}`)}</ToneBadge>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <KeyValue
                                items={[
                                    { label: 'N° d’enregistrement', value: <Mono>{org.registrationNumber}</Mono> },
                                    { label: 'Type', value: org.type },
                                    { label: t('settings.members'), value: members.map((m) => `${m.name} (${m.role})`).join(', ') },
                                    {
                                        label: t('settings.beneficialOwners'),
                                        value: bos.map((b) => `${b.fullName} — ${fmtPct(b.ownershipBps, intl)}`).join(', ') || '—'
                                    }
                                ]}
                            />
                        </CardContent>
                    </Card>
                ))}
            </div>
        </>
    );
}
