import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Permission, orgRoleHas, type OrgRole } from '@dfn/shared';
import { Badge, EmptyState, cn } from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { OrgPicker } from '@/components/wallet/org-picker';
import { DocsCard } from '@/components/developers/docs-card';
import { KeysSection } from '@/components/developers/keys-section';
import { LogsSection } from '@/components/developers/logs-section';
import { WebhooksSection } from '@/components/developers/webhooks-section';
import {
  devHref,
  type ApiCredential,
  type ApiRequestLog,
  type Catalog,
  type DevTab,
  type Paginated,
  type Webhook,
  type WebhookDelivery,
} from '@/components/developers/types';
import { ApiError, apiFetch, getSession } from '@/lib/api-server';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Développeurs' };

const TABS: DevTab[] = ['keys', 'webhooks', 'logs'];
const LOGS_PAGE_SIZE = 25;
const DELIVERIES_PAGE_SIZE = 20;

/** 403 from the API (role changed since the session was issued) is rendered, not thrown. */
async function allowed<T>(promise: Promise<T>): Promise<T | 'forbidden'> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return 'forbidden';
    throw e;
  }
}

export default async function DevelopersPage({
  searchParams,
}: {
  searchParams: Promise<{
    organizationId?: string;
    tab?: string;
    includeRevoked?: string;
    keyId?: string;
    webhookId?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const [{ t }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const org = orgs.find((o) => o.id === organizationId)!;
  const tab: DevTab = TABS.includes(sp.tab as DevTab) ? (sp.tab as DevTab) : 'keys';
  const includeRevoked = sp.includeRevoked === 'true';
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);

  const catalog = await apiFetch<Catalog>('/v1/api-credentials/catalog');
  // Permission.API_MANAGE — display only, the API enforces it.
  let forbidden = !orgRoleHas(org.role as OrgRole, Permission.API_MANAGE);
  let credentials: ApiCredential[] = [];
  let webhooks: Webhook[] = [];
  if (!forbidden) {
    const [keys, hooks] = await Promise.all([
      allowed(
        apiFetch<{ items: ApiCredential[] }>(
          `/v1/api-credentials?organizationId=${organizationId}&includeRevoked=true`,
        ),
      ),
      allowed(
        apiFetch<{ items: Webhook[] }>(`/v1/webhooks?organizationId=${organizationId}&includeRevoked=true`),
      ),
    ]);
    if (keys === 'forbidden' || hooks === 'forbidden') forbidden = true;
    else {
      credentials = keys.items;
      webhooks = hooks.items;
    }
  }

  // Journal: default to the most recent key (revoked keys keep their history readable).
  const selectedKey =
    tab === 'logs' ? (credentials.find((c) => c.id === sp.keyId) ?? credentials[0] ?? null) : null;
  const logs = selectedKey
    ? await apiFetch<Paginated<ApiRequestLog>>(
        `/v1/api-credentials/${selectedKey.id}/logs?page=${page}&pageSize=${LOGS_PAGE_SIZE}`,
      )
    : null;
  const selectedWebhook =
    tab === 'webhooks' ? (webhooks.find((w) => w.id === sp.webhookId) ?? webhooks[0] ?? null) : null;
  const deliveries = selectedWebhook
    ? await apiFetch<Paginated<WebhookDelivery>>(
        `/v1/webhooks/${selectedWebhook.id}/deliveries?page=${page}&pageSize=${DELIVERIES_PAGE_SIZE}`,
      )
    : null;

  const visibleCredentials = includeRevoked ? credentials : credentials.filter((c) => c.status !== 'REVOKED');
  const visibleWebhooks = includeRevoked ? webhooks : webhooks.filter((w) => w.status !== 'REVOKED');

  return (
    <>
      <PageHeader
        title={t('dev.title')}
        subtitle={t('dev.subtitle')}
        actions={
          <OrgPicker
            organizations={orgs}
            value={organizationId}
            basePath="/developers"
            extra={`&tab=${tab}`}
          />
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="sandbox">{t('app.sandbox')}</Badge>
        <span>{t('dev.note')}</span>
      </div>
      <nav className="mb-6 flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label={t('dev.title')}>
        {TABS.map((key) => (
          <Link
            key={key}
            href={devHref(organizationId, key)}
            aria-current={tab === key ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium',
              tab === key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(`dev.tabs.${key}`)}
          </Link>
        ))}
      </nav>

      {forbidden ? (
        <EmptyState
          icon={<ShieldAlert />}
          title={t('dev.insufficientRole')}
          description={`${t('dev.insufficientRoleHint')} — ${org.name}`}
        />
      ) : tab === 'keys' ? (
        <div className="space-y-6">
          <KeysSection
            organizationId={organizationId}
            credentials={visibleCredentials}
            scopes={catalog.scopes}
            includeRevoked={includeRevoked}
          />
          <DocsCard scopes={catalog.scopes} docsPath={catalog.docsPath} />
        </div>
      ) : tab === 'webhooks' ? (
        <WebhooksSection
          organizationId={organizationId}
          webhooks={visibleWebhooks}
          allWebhooks={webhooks}
          events={catalog.webhookEvents}
          includeRevoked={includeRevoked}
          selected={selectedWebhook}
          deliveries={deliveries}
        />
      ) : (
        <LogsSection
          organizationId={organizationId}
          credentials={credentials}
          selected={selectedKey}
          logs={logs}
        />
      )}
    </>
  );
}
