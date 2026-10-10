import Link from 'next/link';
import { MailOpen } from 'lucide-react';
import { Brand } from '@/components/app/brand';
import { InviteResponse } from '@/components/app/invite-response';
import { KeyValue } from '@/components/app/layout-bits';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { formatMoney, fromDTO } from '@/domain/money';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { clientFingerprint, getActor } from '@/server/auth/session';
import { getApp } from '@/server/instance';
import { pseudonymize } from '@/server/security/crypto';

export const metadata = { title: 'Invitation', referrer: 'no-referrer' };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const { t, intl } = await getI18n();
    const app = await getApp();
    const fp = await clientFingerprint();
    const allowed = app.rateLimiter.consume(`invite-preview:${pseudonymize(app.config.sessionSecret, fp.ip)}`, 30, 10 * 60_000).allowed;
    const preview = allowed ? await app.transactions.previewInvitation(token).catch(() => undefined) : undefined;
    const actor = await getActor();
    return (
        <main id="main" className="mx-auto flex min-h-[80dvh] max-w-lg flex-col justify-center gap-6 px-4 py-10">
            <Brand className="self-center" />
            <Card>
                <CardContent className="space-y-5 py-6">
                    <div className="space-y-1 text-center">
                        <MailOpen className="mx-auto size-8 text-primary" aria-hidden />
                        <h1 className="text-lg font-semibold">{t('invite.title')}</h1>
                    </div>
                    {!preview ? (
                        <Alert tone="danger">{allowed ? t('invite.invalid') : t('errors.RATE_LIMITED')}</Alert>
                    ) : (
                        <>
                            <p className="text-center text-sm">
                                {t('invite.from', { seller: preview.sellerName, role: t(`partyRole.${preview.role}`) })}
                            </p>
                            <KeyValue
                                items={[
                                    { label: t('common.reference'), value: <span className="font-mono">{preview.reference}</span> },
                                    { label: t('tx.vehicle'), value: preview.title },
                                    { label: t('common.amount'), value: formatMoney(fromDTO(preview.amount), intl) },
                                    {
                                        label: t('tx.route'),
                                        value: preview.vehicle
                                            ? `${preview.vehicle.originCountry} → ${preview.vehicle.destinationCountry}`
                                            : '—'
                                    }
                                ]}
                            />
                            <p className="text-xs text-muted-foreground">
                                {t('invite.forEmail', { email: preview.inviteeEmailMasked })} ·{' '}
                                {t('invite.expires', { date: fmtDate(preview.expiresAt, intl) })}
                            </p>
                            {actor ? (
                                <InviteResponse token={token} />
                            ) : (
                                <Alert tone="info" title={t('invite.signInFirst')}>
                                    <Link href="/" className="font-medium underline">
                                        {t('landing.signInAs')}
                                    </Link>
                                </Alert>
                            )}
                            <p className="text-xs text-muted-foreground">{t('app.notABank')}</p>
                        </>
                    )}
                </CardContent>
            </Card>
        </main>
    );
}
