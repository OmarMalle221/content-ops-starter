'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft, Coins, Flame, Landmark } from 'lucide-react';
import { Badge, Button, Input, Label, Select, Textarea } from '@dfn/ui';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { FormMessage } from '@/components/form-message';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import type { DdaOperation, DdaOrganizationsResponse } from './dda-types';

type Organization = DdaOrganizationsResponse['items'][number];

const AMOUNT_RE = /^\d{1,13}([.,]\d{1,2})?$/;
const SIGNED_AMOUNT_RE = /^-?\d{1,13}([.,]\d{1,2})?$/;

const normalize = (value: string) => value.trim().replace(',', '.');

function OrganizationSelect({
  id,
  label,
  organizations,
  value,
  onChange,
}: {
  id: string;
  label: string;
  organizations: Organization[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('ddaLab.forms.selectOrganization')}</option>
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} · {o.type} · {o.country}
          </option>
        ))}
      </Select>
    </div>
  );
}

function UnitsInput({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder = '1000.00',
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function NoteInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} maxLength={300} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function SimulationHeader() {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="sandbox">{t('app.sandbox')}</Badge>
      <Badge variant="warning">
        {t('ddaLab.parity')} — {t('ddaLab.hypothesis')}
      </Badge>
    </div>
  );
}

async function post(path: string, json: Record<string, unknown>): Promise<DdaOperation> {
  try {
    return await api<DdaOperation>(path, { method: 'POST', json });
  } catch (e) {
    throw new Error(errorMessage(e));
  }
}

/**
 * Mint / transfer / redeem / reserve-adjustment simulators of the DDA research lab. Every call
 * writes a fictitious operation (admin-only API) and refreshes the server-rendered dashboard.
 */
export function DdaSimulators({ organizations }: { organizations: Organization[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [last, setLast] = useState<DdaOperation | null>(null);

  const [mintOrg, setMintOrg] = useState('');
  const [mintUnits, setMintUnits] = useState('');
  const [mintReserve, setMintReserve] = useState('');
  const [mintNote, setMintNote] = useState('');

  const [fromOrg, setFromOrg] = useState('');
  const [toOrg, setToOrg] = useState('');
  const [transferUnits, setTransferUnits] = useState('');
  const [transferNote, setTransferNote] = useState('');

  const [redeemOrg, setRedeemOrg] = useState('');
  const [redeemUnits, setRedeemUnits] = useState('');
  const [redeemNote, setRedeemNote] = useState('');

  const [delta, setDelta] = useState('');
  const [reserveNote, setReserveNote] = useState('');

  const done = (row: DdaOperation) => {
    setLast(row);
    router.refresh();
  };

  const mintValid =
    !!mintOrg &&
    AMOUNT_RE.test(mintUnits.trim()) &&
    (!mintReserve.trim() || AMOUNT_RE.test(mintReserve.trim()));
  const transferValid = !!fromOrg && !!toOrg && fromOrg !== toOrg && AMOUNT_RE.test(transferUnits.trim());
  const redeemValid = !!redeemOrg && AMOUNT_RE.test(redeemUnits.trim());
  const reserveValid = SIGNED_AMOUNT_RE.test(delta.trim()) && reserveNote.trim().length >= 3;

  if (!organizations.length) {
    return <FormMessage error={t('ddaLab.forms.noOrganizations')} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <ActionDialog
          trigger={
            <Button variant="accent">
              <Coins /> {t('ddaLab.forms.mint')}
            </Button>
          }
          title={t('ddaLab.forms.mintTitle')}
          description={t('ddaLab.forms.mintDescription')}
          confirmLabel={`${t('ddaLab.forms.confirmPrefix')} — ${t('ddaLab.forms.mint')}`}
          variant="accent"
          disabled={!mintValid}
          onConfirm={async () => {
            const row = await post('/v1/admin/dda/mint', {
              organizationId: mintOrg,
              units: normalize(mintUnits),
              ...(mintReserve.trim() ? { reserveUsd: normalize(mintReserve) } : {}),
              ...(mintNote.trim() ? { note: mintNote.trim() } : {}),
              currencyCode: 'DDA',
            });
            setMintUnits('');
            setMintReserve('');
            setMintNote('');
            done(row);
          }}
        >
          <SimulationHeader />
          <OrganizationSelect
            id="dda-mint-org"
            label={t('ddaLab.forms.organization')}
            organizations={organizations}
            value={mintOrg}
            onChange={setMintOrg}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <UnitsInput
              id="dda-mint-units"
              label={t('ddaLab.forms.units')}
              hint={t('ddaLab.forms.unitsHint')}
              value={mintUnits}
              onChange={setMintUnits}
            />
            <UnitsInput
              id="dda-mint-reserve"
              label={t('ddaLab.forms.reserveUsd')}
              hint={t('ddaLab.forms.reserveUsdHint')}
              value={mintReserve}
              onChange={setMintReserve}
              placeholder="0.00"
            />
          </div>
          <NoteInput
            id="dda-mint-note"
            label={t('ddaLab.forms.note')}
            value={mintNote}
            onChange={setMintNote}
          />
        </ActionDialog>

        <ActionDialog
          trigger={
            <Button variant="outline">
              <ArrowRightLeft /> {t('ddaLab.forms.transfer')}
            </Button>
          }
          title={t('ddaLab.forms.transferTitle')}
          description={t('ddaLab.forms.transferDescription')}
          confirmLabel={`${t('ddaLab.forms.confirmPrefix')} — ${t('ddaLab.forms.transfer')}`}
          disabled={!transferValid}
          onConfirm={async () => {
            const row = await post('/v1/admin/dda/transfer', {
              fromOrganizationId: fromOrg,
              toOrganizationId: toOrg,
              units: normalize(transferUnits),
              ...(transferNote.trim() ? { note: transferNote.trim() } : {}),
              currencyCode: 'DDA',
            });
            setTransferUnits('');
            setTransferNote('');
            done(row);
          }}
        >
          <SimulationHeader />
          <div className="grid gap-4 sm:grid-cols-2">
            <OrganizationSelect
              id="dda-transfer-from"
              label={t('ddaLab.forms.from')}
              organizations={organizations}
              value={fromOrg}
              onChange={setFromOrg}
            />
            <OrganizationSelect
              id="dda-transfer-to"
              label={t('ddaLab.forms.to')}
              organizations={organizations}
              value={toOrg}
              onChange={setToOrg}
            />
          </div>
          <UnitsInput
            id="dda-transfer-units"
            label={t('ddaLab.forms.units')}
            hint={t('ddaLab.forms.unitsHint')}
            value={transferUnits}
            onChange={setTransferUnits}
          />
          <NoteInput
            id="dda-transfer-note"
            label={t('ddaLab.forms.note')}
            value={transferNote}
            onChange={setTransferNote}
          />
        </ActionDialog>

        <ActionDialog
          trigger={
            <Button variant="outline">
              <Flame /> {t('ddaLab.forms.redeem')}
            </Button>
          }
          title={t('ddaLab.forms.redeemTitle')}
          description={t('ddaLab.forms.redeemDescription')}
          confirmLabel={`${t('ddaLab.forms.confirmPrefix')} — ${t('ddaLab.forms.redeem')}`}
          variant="destructive"
          disabled={!redeemValid}
          onConfirm={async () => {
            const row = await post('/v1/admin/dda/redeem', {
              organizationId: redeemOrg,
              units: normalize(redeemUnits),
              ...(redeemNote.trim() ? { note: redeemNote.trim() } : {}),
              currencyCode: 'DDA',
            });
            setRedeemUnits('');
            setRedeemNote('');
            done(row);
          }}
        >
          <SimulationHeader />
          <OrganizationSelect
            id="dda-redeem-org"
            label={t('ddaLab.forms.organization')}
            organizations={organizations}
            value={redeemOrg}
            onChange={setRedeemOrg}
          />
          <UnitsInput
            id="dda-redeem-units"
            label={t('ddaLab.forms.units')}
            hint={t('ddaLab.forms.unitsHint')}
            value={redeemUnits}
            onChange={setRedeemUnits}
          />
          <NoteInput
            id="dda-redeem-note"
            label={t('ddaLab.forms.note')}
            value={redeemNote}
            onChange={setRedeemNote}
          />
        </ActionDialog>

        <ActionDialog
          trigger={
            <Button variant="outline">
              <Landmark /> {t('ddaLab.forms.reserve')}
            </Button>
          }
          title={t('ddaLab.forms.reserveTitle')}
          description={t('ddaLab.forms.reserveDescription')}
          confirmLabel={`${t('ddaLab.forms.confirmPrefix')} — ${t('ddaLab.forms.reserve')}`}
          disabled={!reserveValid}
          onConfirm={async () => {
            const row = await post('/v1/admin/dda/reserve-adjustments', {
              deltaUsd: normalize(delta),
              note: reserveNote.trim(),
            });
            setDelta('');
            setReserveNote('');
            done(row);
          }}
        >
          <SimulationHeader />
          <UnitsInput
            id="dda-reserve-delta"
            label={t('ddaLab.forms.deltaUsd')}
            hint={t('ddaLab.forms.deltaUsdHint')}
            value={delta}
            onChange={setDelta}
            placeholder="-250.00"
          />
          <NoteInput
            id="dda-reserve-note"
            label={t('ddaLab.forms.noteRequired')}
            value={reserveNote}
            onChange={setReserveNote}
          />
        </ActionDialog>
      </div>

      {last ? (
        <p className="text-sm text-muted-foreground">
          {t('ddaLab.forms.lastResult')}: {t(`ddaLab.operations.kinds.${last.operation}`)} ·{' '}
          <Link
            className="font-mono underline-offset-4 hover:underline"
            href={`/admin/dda/trace/${last.reference}`}
          >
            {last.reference}
          </Link>{' '}
          ·{' '}
          {last.operation === 'RESERVE_ADJUSTMENT'
            ? formatMoney(last.reserveDeltaUsd, locale)
            : formatMoney(last.units, locale)}{' '}
          · {t('ddaLab.simulated').toLowerCase()}
        </p>
      ) : null}
    </div>
  );
}
