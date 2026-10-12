import Link from 'next/link';
import {
  Badge,
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
import { gateTitle, type ProviderStatus } from './gates-register-table';

type T = (path: string) => string;

function kindLabel(t: T, kind: string) {
  const v = t(`gatesAdmin.kinds.${kind}`);
  return v === `gatesAdmin.kinds.${kind}` ? kind : v;
}

/**
 * Configured providers (KYC_PROVIDER … PAYOUT_PROVIDER): sandbox status, the gates a licensed
 * partner would require (each linking to its gate page) and the contract-test reference adapter.
 */
export function GatesProvidersCard({ providers, t }: { providers: ProviderStatus[]; t: T }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gatesAdmin.providers.title')}</CardTitle>
        <CardDescription>{t('gatesAdmin.providers.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('gatesAdmin.providers.kind')}</TableHead>
              <TableHead>{t('gatesAdmin.providers.code')}</TableHead>
              <TableHead>{t('gatesAdmin.providers.mode')}</TableHead>
              <TableHead>{t('gatesAdmin.providers.gates')}</TableHead>
              <TableHead>{t('gatesAdmin.providers.referenceAdapter')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((p) => (
              <TableRow key={p.kind}>
                <TableCell>
                  <p className="font-medium">{kindLabel(t, p.kind)}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{p.envVar}</p>
                </TableCell>
                <TableCell className="font-mono text-sm">{p.configuredCode}</TableCell>
                <TableCell>
                  {p.sandbox ? (
                    <Badge variant="sandbox">{t('gatesAdmin.providers.sandbox')}</Badge>
                  ) : (
                    <Badge variant="destructive">{t('gatesAdmin.providers.refused')}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {p.requiredGates.map((g) => (
                      <Link
                        key={g.code}
                        href={`/admin/gates/${g.code}`}
                        title={gateTitle(t, g)}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[11px] hover:underline ${
                          g.satisfied ? 'border-success/40 text-success' : 'text-muted-foreground'
                        }`}
                      >
                        {g.code}
                      </Link>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {p.requiredGatesSatisfied}/{p.requiredGates.length} {t('gatesAdmin.providers.satisfied')}
                  </p>
                </TableCell>
                <TableCell>
                  {p.referenceAdapter ? (
                    <>
                      <p className="font-mono text-xs">{p.referenceAdapter.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {p.referenceAdapter.package} — {t('gatesAdmin.providers.referenceHint')}
                      </p>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('gatesAdmin.providers.none')}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
