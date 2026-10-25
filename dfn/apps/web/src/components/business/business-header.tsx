import { Badge } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { OrgPicker } from '@/components/wallet/org-picker';
import { CreateOrganizationDialog } from '@/components/forms/business-forms';
import type { BusinessWorkspace } from '@/app/(app)/business/_shared/workspace';
import { BusinessTabs } from './business-tabs';

/** Shared header of every Diaspora Business page: title, organisation strip, sandbox badge and tabs. */
export function BusinessHeader({
  ws,
  title,
  subtitle,
  basePath,
  actions,
}: {
  ws: BusinessWorkspace;
  title: string;
  subtitle?: string;
  basePath: string;
  actions?: React.ReactNode;
}) {
  const { t, org, orgs, organizationId, myRole } = ws;
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            <OrgPicker organizations={orgs} value={organizationId} basePath={basePath} />
            <CreateOrganizationDialog />
            {actions}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{org.name}</h2>
        <Badge variant={org.type === 'BUSINESS' ? 'default' : 'muted'}>
          {org.type === 'BUSINESS' ? 'BUSINESS' : t('business.personal')}
        </Badge>
        <StatusBadge status={org.verificationStatus} />
        {myRole ? <Badge variant="secondary">{myRole}</Badge> : null}
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
      </div>
      <BusinessTabs
        organizationId={organizationId}
        canViewReports={ws.canViewReports}
        canDecideLinks={ws.canDecideLinks}
      />
    </>
  );
}
