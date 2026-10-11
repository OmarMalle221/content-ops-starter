'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import {
  COUNTRIES,
  CURRENCIES,
  DocumentKind,
  TransactionCategory,
  computeFeeMinor,
  minorToDecimalString,
  parseDecimalToMinor,
} from '@dfn/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
} from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { FormMessage } from '@/components/form-message';
import { CopyButton } from '@/components/copy-button';

interface Org {
  id: string;
  name: string;
  type: 'PERSONAL' | 'BUSINESS';
  role: string;
}

export function NewTransactionForm({
  organizations,
  defaultCountry,
}: {
  organizations: Org[];
  defaultCountry: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({
    organizationId: organizations.find((o) => o.type === 'PERSONAL')?.id ?? organizations[0]?.id ?? '',
    title: '',
    description: '',
    category: 'VEHICLE',
    currencyCode: 'CAD',
    amount: '',
    originCountry: defaultCountry || 'CA',
    destinationCountry: 'SN',
    sellerEmail: '',
    sellerName: '',
    deliveryDeadlineDays: 60,
    inspectionWindowDays: 5,
    governingLaw: 'Canada (Québec)',
    additionalClauses: '',
  });
  const [milestones, setMilestones] = useState([
    { title: '', amount: '', requiredEvidence: 'BILL_OF_LADING' },
    { title: '', amount: '', requiredEvidence: 'PROOF_OF_SHIPMENT' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState<any>(null);

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const totals = useMemo(() => {
    try {
      const amount = form.amount ? parseDecimalToMinor(form.amount, form.currencyCode) : 0n;
      const sum = milestones.reduce(
        (a, m) => a + (m.amount ? parseDecimalToMinor(m.amount, form.currencyCode) : 0n),
        0n,
      );
      const fee = computeFeeMinor(amount, 150);
      return { amount, sum, fee, total: amount + fee, ok: amount > 0n && sum === amount };
    } catch {
      return { amount: 0n, sum: 0n, fee: 0n, total: 0n, ok: false };
    }
  }, [form.amount, form.currencyCode, milestones]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!totals.ok) {
      setError(t('tx.sumMismatch'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api('/v1/transactions', {
        method: 'POST',
        json: {
          organizationId: form.organizationId || undefined,
          title: form.title,
          description: form.description,
          category: form.category,
          currencyCode: form.currencyCode,
          amount: form.amount,
          originCountry: form.originCountry,
          destinationCountry: form.destinationCountry,
          seller: { email: form.sellerEmail, name: form.sellerName || undefined },
          milestones: milestones.map((m) => ({
            title: m.title,
            amount: m.amount,
            requiredEvidence: [m.requiredEvidence],
          })),
          terms: {
            deliveryDeadlineDays: Number(form.deliveryDeadlineDays),
            inspectionWindowDays: Number(form.inspectionWindowDays),
            governingLaw: form.governingLaw,
            additionalClauses: form.additionalClauses || undefined,
          },
        },
      });
      setCreated(res);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    const url = `${window.location.origin}${new URL(created.invitation.acceptUrl).pathname}`;
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {created.reference} — {created.title}
          </CardTitle>
          <CardDescription>{t('tx.invitationHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t('tx.invitationLink')}</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">{url}</code>
              <CopyButton value={url} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/transactions/${created.id}`)}>{t('common.details')}</Button>
            <Button variant="outline" onClick={() => router.push('/transactions')}>
              {t('tx.list')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {t('tx.step')} 1 — {t('common.details')}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {organizations.length > 1 ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="organizationId">{t('wallet.organization')}</Label>
              <Select id="organizationId" value={form.organizationId} onChange={set('organizationId')}>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.type === 'PERSONAL' ? t('business.personal') : o.role})
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="title">{t('tx.title')}</Label>
            <Input
              id="title"
              required
              minLength={3}
              value={form.title}
              onChange={set('title')}
              placeholder="Toyota Hilux 2019 — Montréal → Dakar"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="description">{t('common.description')}</Label>
            <Textarea
              id="description"
              required
              minLength={10}
              value={form.description}
              onChange={set('description')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">{t('tx.category')}</Label>
            <Select id="category" value={form.category} onChange={set('category')}>
              {Object.values(TransactionCategory).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="amount">{t('tx.amount')}</Label>
              <Input
                id="amount"
                inputMode="decimal"
                required
                placeholder="18500.00"
                value={form.amount}
                onChange={set('amount')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="currencyCode">{t('common.currency')}</Label>
              <Select id="currencyCode" value={form.currencyCode} onChange={set('currencyCode')}>
                {Object.keys(CURRENCIES).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="originCountry">{t('tx.origin')}</Label>
            <Select id="originCountry" value={form.originCountry} onChange={set('originCountry')}>
              {Object.values(COUNTRIES).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name[locale]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="destinationCountry">{t('tx.destination')}</Label>
            <Select
              id="destinationCountry"
              value={form.destinationCountry}
              onChange={set('destinationCountry')}
            >
              {Object.values(COUNTRIES).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name[locale]}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('tx.step')} 2 — {t('tx.seller')}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sellerEmail">{t('tx.sellerEmail')}</Label>
            <Input
              id="sellerEmail"
              type="email"
              required
              value={form.sellerEmail}
              onChange={set('sellerEmail')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sellerName">{t('tx.sellerName')}</Label>
            <Input id="sellerName" value={form.sellerName} onChange={set('sellerName')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('tx.step')} 3 — {t('tx.milestones')}
          </CardTitle>
          <CardDescription>{t('tx.sumMismatch')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {milestones.map((m, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_140px_220px_auto]">
              <div className="space-y-1">
                <Label htmlFor={`m-title-${i}`}>{t('tx.milestoneTitle')}</Label>
                <Input
                  id={`m-title-${i}`}
                  required
                  minLength={2}
                  value={m.title}
                  onChange={(e) =>
                    setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`m-amount-${i}`}>{t('tx.milestoneAmount')}</Label>
                <Input
                  id={`m-amount-${i}`}
                  inputMode="decimal"
                  required
                  value={m.amount}
                  onChange={(e) =>
                    setMilestones((ms) => ms.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`m-ev-${i}`}>{t('tx.requiredEvidence')}</Label>
                <Select
                  id={`m-ev-${i}`}
                  value={m.requiredEvidence}
                  onChange={(e) =>
                    setMilestones((ms) =>
                      ms.map((x, j) => (j === i ? { ...x, requiredEvidence: e.target.value } : x)),
                    )
                  }
                >
                  {Object.values(DocumentKind).map((k) => (
                    <option key={k} value={k}>
                      {t(`docs.kinds.${k}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('tx.removeMilestone')}
                  disabled={milestones.length <= 1}
                  onClick={() => setMilestones((ms) => ms.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={milestones.length >= 12}
              onClick={() =>
                setMilestones((ms) => [
                  ...ms,
                  { title: '', amount: '', requiredEvidence: 'PROOF_OF_SHIPMENT' },
                ])
              }
            >
              <Plus /> {t('tx.addMilestone')}
            </Button>
            <p className={`text-sm tabular-nums ${totals.ok ? 'text-success' : 'text-muted-foreground'}`}>
              {minorToDecimalString(totals.sum, form.currencyCode)} / {form.amount || '0'} {form.currencyCode}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {t('tx.step')} 4 — {t('tx.terms')}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="deliveryDeadlineDays">{t('tx.deliveryDeadline')}</Label>
            <Input
              id="deliveryDeadlineDays"
              type="number"
              min={1}
              max={365}
              value={form.deliveryDeadlineDays}
              onChange={set('deliveryDeadlineDays')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inspectionWindowDays">{t('tx.inspectionWindow')}</Label>
            <Input
              id="inspectionWindowDays"
              type="number"
              min={0}
              max={30}
              value={form.inspectionWindowDays}
              onChange={set('inspectionWindowDays')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="governingLaw">{t('tx.governingLaw')}</Label>
            <Input id="governingLaw" value={form.governingLaw} onChange={set('governingLaw')} />
          </div>
          <div className="space-y-2 sm:col-span-3">
            <Label htmlFor="additionalClauses">Clauses additionnelles / Additional clauses</Label>
            <Textarea
              id="additionalClauses"
              value={form.additionalClauses}
              onChange={set('additionalClauses')}
            />
          </div>
          <div className="rounded-lg bg-muted p-4 text-sm sm:col-span-3">
            <div className="flex justify-between">
              <span>{t('tx.fee')}</span>
              <span className="tabular-nums">
                {minorToDecimalString(totals.fee, form.currencyCode)} {form.currencyCode}
              </span>
            </div>
            <div className="mt-1 flex justify-between font-semibold">
              <span>{t('tx.totalToFund')}</span>
              <span className="tabular-nums">
                {minorToDecimalString(totals.total, form.currencyCode)} {form.currencyCode}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <FormMessage error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" loading={loading}>
          {t('tx.create')}
        </Button>
      </div>
    </form>
  );
}
