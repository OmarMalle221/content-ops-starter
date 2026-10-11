import { Download, FileText, Plus } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@dfn/ui';
import { BusinessHeader } from '@/components/business/business-header';
import { DocumentFilters } from '@/components/business/document-filters';
import { DocumentFormDialog } from '@/components/business/document-form';
import { DocumentsTable } from '@/components/business/documents-table';
import { apiFetch } from '@/lib/api-server';
import { isoDateInDays, resolveWorkspace } from '../_shared/workspace';

export const metadata = { title: 'Factures' };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; status?: string; search?: string; scope?: string }>;
}) {
  const sp = await searchParams;
  const ws = await resolveWorkspace(sp);
  const { t, locale, organizationId } = ws;
  const scope = sp.scope === 'RECEIVED' ? 'RECEIVED' : 'ISSUED';
  const qs = new URLSearchParams({ organizationId, pageSize: '50', scope });
  if (sp.status) qs.set('status', sp.status);
  if (sp.search) qs.set('search', sp.search);
  const [invoices, counterparties] = await Promise.all([
    apiFetch<any>(`/v1/invoices?${qs.toString()}`),
    ws.canInvoice
      ? apiFetch<any[]>(`/v1/organizations/${organizationId}/counterparties`)
      : Promise.resolve([]),
  ]);
  const createDialog = ws.canInvoice ? (
    <DocumentFormDialog
      kind="INVOICE"
      organizationId={organizationId}
      counterparties={counterparties}
      defaultDueDate={isoDateInDays(30)}
      trigger={
        <Button>
          <Plus /> {t('invoicing.new')}
        </Button>
      }
    />
  ) : null;
  return (
    <>
      <BusinessHeader
        ws={ws}
        title={t('invoicing.title')}
        subtitle={t('invoicing.subtitle')}
        basePath="/business/invoices"
        actions={
          <>
            <Button asChild variant="outline" title={t('invoicing.exportHint')}>
              <a href={`/api/v1/invoices.csv?organizationId=${organizationId}`}>
                <Download /> {t('invoicing.export')}
              </a>
            </Button>
            {createDialog}
          </>
        }
      />
      <div className="mb-4">
        <DocumentFilters
          kind="INVOICE"
          organizationId={organizationId}
          status={sp.status}
          search={sp.search}
          scope={scope}
        />
      </div>
      {invoices.items.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title={t('invoicing.empty')}
          description={t('invoicing.emptyHint')}
          action={createDialog ?? undefined}
        />
      ) : (
        <Card>
          <CardContent className="pt-6">
            <DocumentsTable
              kind="INVOICE"
              rows={invoices.items}
              organizationId={organizationId}
              locale={locale}
              t={t}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {invoices.total} · {t('app.sandbox')}
            </p>
          </CardContent>
        </Card>
      )}
    </>
  );
}
