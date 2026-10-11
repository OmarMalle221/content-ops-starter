'use client';
import { useState } from 'react';
import { Activity } from 'lucide-react';
import { Badge, Button, Input, Label } from '@dfn/ui';
import { FormMessage } from '@/components/form-message';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { formatBps, type DdaStressResult } from './dda-types';

const PERCENT_RE = /^\d{1,3}([.,]\d{1,2})?$/;

function parsePercent(value: string): number | null {
  if (!PERCENT_RE.test(value.trim())) return null;
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * De-peg / liquidity stress tester: POST /v1/admin/dda/stress-test is a pure computation on the
 * current fictitious state (nothing is written). Results are rendered with the simulation badges.
 */
export function DdaStressTester() {
  const { t, locale } = useI18n();
  const [redemption, setRedemption] = useState('30');
  const [haircut, setHaircut] = useState('0');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DdaStressResult | null>(null);

  const redemptionPercent = parsePercent(redemption);
  const reserveHaircutPercent = parsePercent(haircut);
  const valid = redemptionPercent !== null && reserveHaircutPercent !== null;

  const rows: Array<[string, string]> = result
    ? [
        [t('ddaLab.stress.supply'), formatMoney(result.supply, locale)],
        [t('ddaLab.stress.reserve'), formatMoney(result.reserveUsd, locale)],
        [t('ddaLab.stress.coverageBefore'), formatBps(result.coverageBeforeBps, locale)],
        [t('ddaLab.stress.redeemed'), formatMoney(result.redeemedUnits, locale)],
        [t('ddaLab.stress.remaining'), formatMoney(result.remainingSupply, locale)],
        [t('ddaLab.stress.reserveAfterHaircut'), formatMoney(result.reserveAfterHaircut, locale)],
        [t('ddaLab.stress.reserveAfterRedemptions'), formatMoney(result.reserveAfterRedemptions, locale)],
        [t('ddaLab.stress.shortfall'), formatMoney(result.shortfallUsd, locale)],
        [t('ddaLab.stress.coverageAfter'), formatBps(result.coverageAfterBps, locale)],
      ]
    : [];

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) {
          setError(t('ddaLab.stress.invalid'));
          return;
        }
        setLoading(true);
        setError(null);
        try {
          const r = await api<DdaStressResult>('/v1/admin/dda/stress-test', {
            method: 'POST',
            json: { redemptionPercent, reserveHaircutPercent },
          });
          setResult(r);
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setLoading(false);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="dda-stress-redemption">{t('ddaLab.stress.redemption')}</Label>
          <Input
            id="dda-stress-redemption"
            inputMode="decimal"
            value={redemption}
            onChange={(e) => setRedemption(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('ddaLab.stress.redemptionHint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="dda-stress-haircut">{t('ddaLab.stress.haircut')}</Label>
          <Input
            id="dda-stress-haircut"
            inputMode="decimal"
            value={haircut}
            onChange={(e) => setHaircut(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('ddaLab.stress.haircutHint')}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" loading={loading} disabled={!valid}>
          <Activity /> {t('ddaLab.stress.run')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('ddaLab.stress.pure')}</span>
      </div>
      <FormMessage error={error} />

      {result ? (
        <div className="space-y-3 rounded-lg border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{t('ddaLab.stress.results')}</span>
            <Badge variant={result.verdict === 'COVERED' ? 'success' : 'destructive'}>
              {t('ddaLab.stress.verdict')}: {t(`ddaLab.stress.${result.verdict}`)}
            </Badge>
            <Badge variant="sandbox">{t('app.sandbox')}</Badge>
            <Badge variant="warning">
              {t('ddaLab.parity')} — {t('ddaLab.hypothesis')}
            </Badge>
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {rows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-center justify-between gap-4 border-b py-1 last:border-0"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('ddaLab.stress.notes')}
            </p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">{result.disclaimer}</p>
        </div>
      ) : null}
    </form>
  );
}
