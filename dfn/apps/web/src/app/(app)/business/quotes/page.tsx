import { FileText, Plus } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { DocumentFilters } from '@/components/business/document-filters';
import { DocumentFormDialog } from '@/components/business/document-form';
import { DocumentsTable } from '@/components/business/documents-table';
import { apiFetch } from '@/lib/api-server';
import { isoDateInDays, resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Devis' };

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; status?: string; search?: string }>;
}) {
  const sp = await searchParams;
  const ws = await resolveWorkspace(sp);
  const { t, locale, organizationId } = ws;
  const qs = new URLSearchParams({ organizationId, pageSize: '50' });
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);
  const [quotes, counterparties] = await Promise.all([
    apiFetch<any>(`/v1/quotes?${qs.toString()}`),
    ws.canInvoice
      ? apiFetch<any[]>(`/v1/organizations/${organizationId}/counterparties`)
      : Promise.resolve([]),
  ]);
  const createDialog = ws.canInvoice ? (
    <DocumentFormDialog
      kind="QUOTE"
      organizationId={organizationId}
      counterparties={counterparties}
      defaultDueDate={isoDateInDays(30)}
      trigger={
        <Button>
          <Plus /> {t('quotesX.new')}
        </Button>
      }
    />
  ) : null;
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('quotesX.title')}
        subtitle={t('quotesX.subtitle')}
        basePath="/business/quotes"
        actions={createDialog}
      />
      <div className="mb-4">
        <DocumentFilters kind="QUOTE" organizationId={organizationId} status={sp.status} search={sp.search} />
      </div>
      {quotes.items.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title={t('quotesX.empty')}
          description={t('quotesX.emptyHint')}
          action={createDialog ?? undefined}
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <DocumentsTable
              kind="QUOTE"
              rows={quotes.items}
              organizationId={organizationId}
              locale={locale}
              t={t}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {quotes.total} · {t('quotesX.expiredHint')} · {t('app.sandbox')}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
