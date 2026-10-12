import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@dfn/ui';
import { formatDate } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import { GateLevelBadge, GateStatusBadge } from './gates-status-badge';

/** Shapes returned by GET /v1/admin/gates, /v1/admin/gates/:code and /v1/admin/gates/providers. */
export interface GateActor {
  id: string;
  name: string;
  email: string;
}
export interface GateDto {
  code: string;
  title: string;
  jurisdiction: string;
  referenceDoc: string;
  level: string;
  status: string;
  notes: string | null;
  evidenceRef: string | null;
  firstApprover: GateActor | null;
  firstApprovedAt: string | null;
  secondApprover: GateActor | null;
  secondApprovedAt: string | null;
  approvals: number;
  approvalsRequired: number;
  requiredFor: string[];
  createdAt: string;
  updatedAt: string;
  trackingOnly: true;
  disclaimer: { fr: string; en: string };
  nextActions: Array<'PROGRESS' | 'APPROVE' | 'REVOKE'>;
}
export interface GateEventDto {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  evidenceRef: string | null;
  actor: GateActor | null;
  createdAt: string;
}
export interface GateDetailDto extends GateDto {
  events: GateEventDto[];
}
export interface GatesListDto {
  mode: 'sandbox';
  trackingOnly: true;
  disclaimer: { fr: string; en: string };
  canManage: boolean;
  summary: { total: number; byStatus: Record<string, number> };
  items: GateDto[];
}
export interface ProviderStatus {
  kind: string;
  envVar: string;
  configuredCode: string;
  sandbox: boolean;
  activatable: boolean;
  simulated: boolean;
  requiredGates: Array<{ code: string; title: string; status: string; satisfied: boolean }>;
  requiredGatesSatisfied: number;
  referenceAdapter: { name: string; package: string; reachableFromEnv: false } | null;
}
export interface ProvidersDto {
  mode: 'sandbox';
  trackingOnly: true;
  disclaimer: { fr: string; en: string };
  providers: ProviderStatus[];
}

type T = (path: string) => string;

/** Gate title in the interface language; the API's (French) title for a code without a key. */
export function gateTitle(t: T, gate: { code: string; title: string }): string {
  const key = `gatesAdmin.titles.${gate.code}`;
  const localized = t(key);
  return localized === key ? gate.title : localized;
}

function Approvers({ gate, t }: { gate: GateDto; t: T }) {
  if (!gate.firstApprover) return <span className="text-muted-foreground">{t('gatesAdmin.noApprover')}</span>;
  return (
    <div className="space-y-0.5 text-xs">
      <p>
        <span className="font-medium tabular-nums">
          {gate.approvals}/{gate.approvalsRequired}
        </span>{' '}
        {t('gatesAdmin.approvals')}
      </p>
      <p className="text-muted-foreground">
        {gate.firstApprover.name}
        {gate.secondApprover ? ` · ${gate.secondApprover.name}` : ''}
      </p>
    </div>
  );
}

/** R1–R10 register: code, title, jurisdiction, level, status, approvers and last update. */
export function GatesRegisterTable({ gates, t, locale }: { gates: GateDto[]; t: T; locale: Locale }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('gatesAdmin.columns.code')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.title')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.jurisdiction')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.level')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.status')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.approvers')}</TableHead>
          <TableHead>{t('gatesAdmin.columns.updatedAt')}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {gates.map((gate) => (
          <TableRow key={gate.code}>
            <TableCell className="font-mono font-semibold">{gate.code}</TableCell>
            <TableCell className="max-w-md">
              <Link href={`/admin/gates/${gate.code}`} className="text-sm hover:underline">
                {gateTitle(t, gate)}
              </Link>
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{gate.jurisdiction}</TableCell>
            <TableCell>
              <GateLevelBadge level={gate.level} t={t} />
            </TableCell>
            <TableCell>
              <GateStatusBadge status={gate.status} t={t} />
            </TableCell>
            <TableCell>
              <Approvers gate={gate} t={t} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
              {formatDate(gate.updatedAt, locale, true)}
            </TableCell>
            <TableCell className="text-right">
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/gates/${gate.code}`}>
                  {t('gatesAdmin.open')} <ArrowRight />
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
