import { ReprocessEvent } from '@/components/admin/forms';
import { PageHeader, KeyValue, Mono } from '@/components/app/layout-bits';
import { ToneBadge, toneFor } from '@/components/app/status';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { getI18n } from '@/i18n/server';
import { fmtDate } from '@/lib/format';
import { hasRole } from '@/server/auth/actor';
import { requireStaff } from '@/server/auth/session';
import { getApp } from '@/server/instance';

export default async function Partners() {
    const actor = await requireStaff(['finance_operator', 'platform_admin', 'auditor'], '/admin/partners');
    const { t, intl } = await getI18n();
    const app = await getApp();
    const connections = await app.admin.providerConnections(actor);
    const events = hasRole(actor, 'finance_operator', 'auditor') ? await app.admin.providerEvents(actor) : [];
    return (
        <>
            <PageHeader title={t('nav.partners')} />
            <Alert tone="warning" className="mb-6" title={t('payment.simulationNotice')}>
                {t('landing.disclaimer')}
            </Alert>
            <div className="space-y-6">
                {connections.map((c) => (
                    <Card key={c.id}>
                        <CardHeader>
                            <CardTitle>{c.displayName}</CardTitle>
                            <ToneBadge tone={c.environment === 'PRODUCTION' ? 'success' : 'warning'}>{c.environment}</ToneBadge>
                        </CardHeader>
                        <CardContent>
                            <KeyValue
                                items={[
                                    { label: 'Provider', value: <Mono>{c.provider}</Mono> },
                                    { label: t('common.status'), value: c.status },
                                    { label: t('admin.capabilities'), value: c.capabilities.join(', ') },
                                    { label: t('admin.secretRef'), value: <Mono>{c.webhookSecretRef}</Mono> },
                                    { label: t('admin.regulatory'), value: c.regulatoryStatusNote }
                                ]}
                            />
                        </CardContent>
                    </Card>
                ))}
                {events.length > 0 && (
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.events')}</CardTitle>
                        </CardHeader>
                        <Table>
                            <THead>
                                <tr>
                                    <TH>{t('common.date')}</TH>
                                    <TH>Type</TH>
                                    <TH>ID externe</TH>
                                    <TH>Signature</TH>
                                    <TH>{t('common.status')}</TH>
                                    <TH />
                                </tr>
                            </THead>
                            <TBody>
                                {events.map((e) => (
                                    <TR key={e.id}>
                                        <TD className="text-xs whitespace-nowrap">{fmtDate(e.receivedAt, intl, true)}</TD>
                                        <TD>
                                            <Mono>{e.type}</Mono>
                                        </TD>
                                        <TD>
                                            <Mono>{e.externalEventId}</Mono>
                                        </TD>
                                        <TD>
                                            {e.signatureVerified ? (
                                                <ToneBadge tone="success">HMAC ✓</ToneBadge>
                                            ) : (
                                                <ToneBadge tone="danger">✗</ToneBadge>
                                            )}
                                        </TD>
                                        <TD>
                                            <ToneBadge tone={toneFor(e.status)}>{e.status}</ToneBadge>
                                            {e.error && <p className="mt-1 text-xs text-danger">{e.error}</p>}
                                        </TD>
                                        <TD>
                                            {e.status === 'FAILED' && hasRole(actor, 'finance_operator') && (
                                                <ReprocessEvent eventId={e.id} />
                                            )}
                                        </TD>
                                    </TR>
                                ))}
                            </TBody>
                        </Table>
                    </Card>
                )}
            </div>
        </>
    );
}
