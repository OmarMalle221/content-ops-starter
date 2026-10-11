import Link from 'next/link';
import { ArrowRight, ScrollText } from 'lucide-react';
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
import { formatDate, type BadgeVariant } from '@/lib/format';
import { getT } from '@/lib/i18n-server';
import { RecordPicker } from './record-picker';
import { devHref, type ApiCredential, type ApiRequestLog, type Paginated } from './types';

export function httpStatusVariant(code: number): BadgeVariant {
  if (code < 300) return 'success';
  if (code < 500) return 'warning';
  return 'destructive';
}

export async function LogsSection({
  organizationId,
  credentials,
  selected,
  logs,
}: {
  organizationId: string;
  credentials: ApiCredential[];
  selected: ApiCredential | null;
  logs: Paginated<ApiRequestLog> | null;
}) {
  const { t, locale } = await getT();
  const totalPages = logs ? Math.max(1, Math.ceil(logs.total / logs.pageSize)) : 1;
  const pageHref = (page: number) =>
    devHref(organizationId, 'logs', { keyId: selected?.id, page: page > 1 ? page : undefined });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4" /> {t('dev.logs.title')}
          </CardTitle>
          <CardDescription>{t('dev.logs.description')}</CardDescription>
        </div>
        {selected ? (
          <RecordPicker
            label={t('dev.logs.selectKey')}
            options={credentials.map((c) => ({ id: c.id, label: `${c.name} · ${c.keyDisplay}` }))}
            value={selected.id}
            basePath="/developers"
            query={{ organizationId, tab: 'logs' }}
            param="keyId"
          />
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!selected || !logs ? (
          <EmptyState
            icon={<ScrollText />}
            title={t('dev.logs.noKeys')}
            description={t('app.sandbox')}
            action={
              <Button asChild variant="outline">
                <Link href={devHref(organizationId, 'keys')}>
                  {t('dev.tabs.keys')} <ArrowRight />
                </Link>
              </Button>
            }
          />
        ) : logs.items.length === 0 ? (
          <EmptyState
            icon={<ScrollText />}
            title={t('dev.logs.empty')}
            description={t('dev.logs.emptyHint')}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {logs.total} {t('dev.logs.results')} · {t('app.sandbox')}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('common.date')}</TableHead>
                  <TableHead>{t('dev.logs.method')}</TableHead>
                  <TableHead>{t('dev.logs.path')}</TableHead>
                  <TableHead>{t('dev.logs.statusCode')}</TableHead>
                  <TableHead className="text-right">{t('dev.logs.duration')}</TableHead>
                  <TableHead>{t('dev.logs.ip')}</TableHead>
                  <TableHead>{t('dev.logs.requestId')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.items.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDate(l.createdAt, locale, true)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{l.method}</TableCell>
                    <TableCell className="max-w-[320px] truncate font-mono text-xs" title={l.path}>
                      {l.path}
                    </TableCell>
                    <TableCell>
                      <Badge variant={httpStatusVariant(l.statusCode)} className="font-mono">
                        {l.statusCode}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.durationMs} ms</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{l.ip ?? '—'}</TableCell>
                    <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
                      {l.requestId ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {totalPages > 1 ? (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('dev.logs.page')} {logs.page} / {totalPages}
                </span>
                <div className="flex gap-2">
                  {logs.page > 1 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={pageHref(logs.page - 1)}>{t('dev.logs.previous')}</Link>
                    </Button>
                  ) : null}
                  {logs.page < totalPages ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={pageHref(logs.page + 1)}>{t('dev.logs.next')}</Link>
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
