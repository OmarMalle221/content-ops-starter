import Link from 'next/link';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Users } from 'lucide-react';
import { Permission, orgRoleHas, type OrgRole } from '@dfn/shared';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { PageHeader } from '@/components/shell/page-header';
import { StatusBadge } from '@/components/status-badge';
import { BeneficiaryCreateDialog } from '@/components/wallet/beneficiary-create-dialog';
import { BeneficiaryRemoveButton } from '@/components/wallet/beneficiary-remove-button';
import { OrgPicker } from '@/components/wallet/org-picker';
import { apiFetch, getSession } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export const metadata = { title: 'Bénéficiaires' };

interface Beneficiary {
  id: string;
  organizationId: string;
  name: string;
  country: string;
  currencyCode: string;
  method: 'BANK_ACCOUNT' | 'MOBILE_MONEY';
  accountIdentifierMasked: string;
  institutionName: string | null;
  phone: string | null;
  email: string | null;
  status: 'ACTIVE' | 'REMOVED';
  createdAt: string;
}

export default async function BeneficiariesPage({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; includeRemoved?: string }>;
}) {
  const sp = await searchParams;
  const [{ t, locale }, session] = await Promise.all([getT(), getSession()]);
  const orgs = session!.user.organizations;
  const organizationId =
    sp.organizationId && orgs.some((o) => o.id === sp.organizationId) ? sp.organizationId : orgs[0].id;
  const org = orgs.find((o) => o.id === organizationId)!;
  const canManage = orgRoleHas(org.role as OrgRole, Permission.BENEFICIARY_MANAGE);
  const includeRemoved = sp.includeRemoved === 'true';
  const { items } = await apiFetch<{ items: Beneficiary[] }>(
    `/v1/beneficiaries?organizationId=${organizationId}${includeRemoved ? '&includeRemoved=true' : ''}`,
  );
  const toggleHref = `/wallet/beneficiaries?organizationId=${organizationId}${includeRemoved ? '' : '&includeRemoved=true'}`;

  return (
    <>
      <PageHeader
        title={t('beneficiary.title')}
        subtitle={t('beneficiary.subtitle')}
        actions={
          <>
            <OrgPicker organizations={orgs} value={organizationId} basePath="/wallet/beneficiaries" />
            <Button asChild variant="ghost">
              <Link href={`/wallet?organizationId=${organizationId}`}>
                <ArrowLeft /> {t('beneficiary.backToWallet')}
              </Link>
            </Button>
            {canManage ? <BeneficiaryCreateDialog organizationId={organizationId} /> : null}
          </>
        }
      />
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" /> {org.name}
            </CardTitle>
            <CardDescription>
              <Badge variant="sandbox">{t('app.sandbox')}</Badge> · {t('beneficiary.encryptedHint')}
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={toggleHref}>
              {includeRemoved ? <EyeOff /> : <Eye />}{' '}
              {includeRemoved ? t('beneficiary.hideRemoved') : t('beneficiary.showRemoved')}
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={<Users />}
              title={t('beneficiary.empty')}
              description={t('beneficiary.emptyHint')}
              action={canManage ? <BeneficiaryCreateDialog organizationId={organizationId} /> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.name')}</TableHead>
                  <TableHead>{t('beneficiary.method')}</TableHead>
                  <TableHead>{t('beneficiary.identifier')}</TableHead>
                  <TableHead>{t('beneficiary.country')}</TableHead>
                  <TableHead>{t('common.currency')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('beneficiary.addedOn')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((b) => (
                  <TableRow key={b.id} className={b.status === 'REMOVED' ? 'opacity-60' : ''}>
                    <TableCell>
                      <div className="font-medium">{b.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[b.institutionName, b.email, b.phone].filter(Boolean).join(' · ')}
                      </div>
                    </TableCell>
                    <TableCell>{t(`beneficiary.methods.${b.method}`)}</TableCell>
                    <TableCell className="font-mono">{b.accountIdentifierMasked}</TableCell>
                    <TableCell>{b.country}</TableCell>
                    <TableCell>{b.currencyCode}</TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(b.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      {b.status === 'ACTIVE' ? (
                        <div className="flex justify-end gap-1">
                          <Button asChild variant="ghost" size="sm">
                            <Link
                              href={`/transfers/new?organizationId=${organizationId}&beneficiaryId=${b.id}`}
                            >
                              {t('beneficiary.sendTo')} <ArrowRight />
                            </Link>
                          </Button>
                          {canManage ? <BeneficiaryRemoveButton beneficiary={b} /> : null}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
