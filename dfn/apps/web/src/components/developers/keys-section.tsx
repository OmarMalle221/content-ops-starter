import Link from 'next/link';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
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
import { formatDate, statusVariant } from '@/lib/format';
import { getT } from '@/lib/i18n-server';
import { ApiKeyActions } from './api-key-actions';
import { ApiKeyCreateDialog } from './api-key-create-dialog';
import { devHref, type ApiCredential, type ScopeOption } from './types';

export async function KeysSection({
  organizationId,
  credentials,
  scopes,
  includeRevoked,
}: {
  organizationId: string;
  credentials: ApiCredential[];
  scopes: ScopeOption[];
  includeRevoked: boolean;
}) {
  const { t, locale } = await getT();
  const toggleHref = devHref(organizationId, 'keys', { includeRevoked: includeRevoked ? undefined : 'true' });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> {t('dev.keys.title')}
          </CardTitle>
          <CardDescription>{t('dev.keys.description')}</CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={toggleHref}>
              {includeRevoked ? <EyeOff /> : <Eye />}{' '}
              {includeRevoked ? t('dev.keys.hideRevoked') : t('dev.keys.showRevoked')}
            </Link>
          </Button>
          <ApiKeyCreateDialog organizationId={organizationId} scopes={scopes} size="sm" />
        </div>
      </CardHeader>
      <CardContent>
        {credentials.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title={t('dev.keys.empty')}
            description={t('dev.keys.emptyHint')}
            action={<ApiKeyCreateDialog organizationId={organizationId} scopes={scopes} />}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.name')}</TableHead>
                <TableHead>{t('dev.keys.key')}</TableHead>
                <TableHead>{t('dev.keys.scopes')}</TableHead>
                <TableHead>{t('dev.keys.rateLimit')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('dev.keys.lastUsed')}</TableHead>
                <TableHead>{t('dev.keys.expires')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map((c) => (
                <TableRow key={c.id} className={c.status === 'ACTIVE' ? '' : 'opacity-60'}>
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.description ? `${c.description} · ` : ''}
                      {t('dev.keys.createdBy')}{' '}
                      {c.createdBy ? `${c.createdBy.firstName} ${c.createdBy.lastName}` : '—'} ·{' '}
                      {formatDate(c.createdAt, locale)}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{c.keyDisplay}</TableCell>
                  <TableCell>
                    <div className="flex max-w-[260px] flex-wrap gap-1">
                      {c.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="font-mono text-[11px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {c.rateLimitPerMinute} {t('dev.keys.perMinute')}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(c.status)}>{t(`dev.statuses.${c.status}`)}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {c.lastUsedAt ? formatDate(c.lastUsedAt, locale, true) : t('dev.keys.never')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {c.expiresAt ? formatDate(c.expiresAt, locale) : t('dev.keys.noExpiry')}
                  </TableCell>
                  <TableCell className="text-right">
                    <ApiKeyActions credential={c} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
