import { ScrollText } from 'lucide-react';
import { EmptyState } from '@/components/app/layout-bits';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Translator } from '@/i18n';
import type { TransactionView } from '@/lib/dto';
import { fmtDate } from '@/lib/format';

export function HistoryTab({ view, t, intl }: { view: TransactionView; t: Translator; intl: string }) {
    return (
        <Card>
            <CardHeader className="block">
                <CardTitle>{t('history.title')}</CardTitle>
                <CardDescription>{t('history.integrity')}</CardDescription>
            </CardHeader>
            <CardContent>
                {view.timeline.length === 0 ? (
                    <EmptyState icon={ScrollText} title={t('history.empty')} />
                ) : (
                    <ol className="relative space-y-4 border-l pl-5">
                        {view.timeline.map((e) => (
                            <li key={e.id} className="relative">
                                <span
                                    className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-primary"
                                    aria-hidden
                                />
                                <p className="text-sm font-medium">
                                    <code className="text-xs">{e.action}</code>
                                    {typeof e.metadata.to === 'string' && (
                                        <span className="ml-2 text-muted-foreground">→ {t(`status.${e.metadata.to}`)}</span>
                                    )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {e.actor} · {fmtDate(e.at, intl, true)}
                                    {typeof e.metadata.role === 'string' && ` · ${t(`partyRole.${e.metadata.role}`)}`}
                                    {typeof e.metadata.type === 'string' && ` · ${t(`documentType.${e.metadata.type}`)}`}
                                </p>
                            </li>
                        ))}
                    </ol>
                )}
            </CardContent>
        </Card>
    );
}
