import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@dfn/ui';
import { ReconcileButton } from '@/components/admin/admin-actions';
import { apiFetch } from '@/lib/api-server';
import { formatDate } from '@/lib/format';
import { getT } from '@/lib/i18n-server';

export default async function AdminLedgerPage() {
  const [{ t, locale }, data] = await Promise.all([getT(), apiFetch<any>('/v1/admin/ledger?pageSize=50')]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>{t('admin.ledger')}</CardTitle>
            <CardDescription>
              {data.accounts.length} accounts · {data.transactions.total} postings · {t('app.sandbox')}
            </CardDescription>
          </div>
          <ReconcileButton />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Normal</TableHead>
                <TableHead className="text-right">Balance (minor)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.accounts.map((a: any) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.code}</TableCell>
                  <TableCell className="text-xs">{a.type}</TableCell>
                  <TableCell className="text-xs">{a.normalBalance}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{a.balance}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Postings</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {data.transactions.items.map((tx: any) => (
              <li key={tx.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {tx.kind} · {tx.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tx.status} · {formatDate(tx.postedAt, locale, true)}
                  </span>
                </div>
                <ul className="mt-1 grid gap-1 font-mono text-xs text-muted-foreground sm:grid-cols-2">
                  {tx.entries.map((e: any) => (
                    <li key={e.id}>
                      {e.direction.padEnd(6)} {e.amountMinor} {e.currencyCode} → {e.account.code}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {data.reconciliations.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Reconciliation jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {data.reconciliations.map((j: any) => (
                <li key={j.id} className="flex items-center justify-between">
                  <span>
                    {j.status} · {j.accountsChecked} accounts · {j.differencesFound} differences
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(j.startedAt, locale, true)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
