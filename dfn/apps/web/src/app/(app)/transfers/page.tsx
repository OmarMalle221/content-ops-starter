import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@dfn/ui';
import { CORRIDORS, COUNTRIES } from '@dfn/shared';
import { PageHeader } from '@/components/shell/page-header';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Transferts' };

export default async function TransfersPage() {
  const { t, locale } = await getT();
  const states = ['CREATED', 'QUOTED', 'AUTHORIZED', 'PROCESSING', 'SETTLED'];
  return (
    <>
      <PageHeader title={t('transfers.title')} subtitle={t('transfers.subtitle')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Diaspora Transfer — Phase 4</CardTitle>
            <CardDescription>{t('transfers.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-wrap items-center gap-2 text-xs font-medium">
              {states.map((s, i) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="rounded-full border px-2 py-1">{s}</span>
                  {i < states.length - 1 ? <span aria-hidden>→</span> : null}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">
              + FAILED · EXPIRED · CANCELLED · REVIEW_REQUIRED
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Corridors</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {CORRIDORS.map((c) => (
                <li key={`${c.origin}-${c.destination}`} className="flex items-center justify-between">
                  <span>
                    {COUNTRIES[c.origin].name[locale]} → {COUNTRIES[c.destination].name[locale]}
                  </span>
                  <span className="text-xs text-muted-foreground">{c.status}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
