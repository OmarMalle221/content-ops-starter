'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Label, Select, Textarea } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { FormMessage } from '@/components/form-message';

export function UserStatusButton({ user }: { user: any }) {
  const { t } = useI18n();
  const router = useRouter();
  const [reason, setReason] = useState('');
  const next = user.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
  return (
    <ActionDialog
      trigger={
        <Button size="sm" variant={next === 'SUSPENDED' ? 'destructive' : 'outline'}>
          {next === 'SUSPENDED' ? t('admin.suspend') : t('admin.activate')}
        </Button>
      }
      title={`${next === 'SUSPENDED' ? t('admin.suspend') : t('admin.activate')} — ${user.email}`}
      variant={next === 'SUSPENDED' ? 'destructive' : 'default'}
      disabled={reason.trim().length < 3}
      onConfirm={() =>
        api(`/v1/admin/users/${user.id}/status`, { method: 'POST', json: { status: next, reason } }).then(
          () => router.refresh(),
        )
      }
    >
      <div className="space-y-2">
        <Label htmlFor="reason">{t('dispute.rationale')}</Label>
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ActionDialog>
  );
}

export function UserRoleSelect({ user }: { user: any }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Select
        aria-label="Role"
        className="h-8 w-36 text-xs"
        value={user.globalRole}
        onChange={(e) =>
          api(`/v1/admin/users/${user.id}/role`, { method: 'POST', json: { globalRole: e.target.value } })
            .then(() => router.refresh())
            .catch((err) => setError(errorMessage(err)))
        }
      >
        <option>USER</option>
        <option>COMPLIANCE</option>
        <option>ADMIN</option>
      </Select>
      <FormMessage error={error} />
    </div>
  );
}

export function ReviewVerificationButtons({ id }: { id: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [notes, setNotes] = useState('');
  return (
    <div className="flex gap-2">
      {(['APPROVE', 'REJECT'] as const).map((decision) => (
        <ActionDialog
          key={decision}
          trigger={
            <Button size="sm" variant={decision === 'APPROVE' ? 'success' : 'destructive'}>
              {decision === 'APPROVE' ? t('admin.approve') : t('admin.reject')}
            </Button>
          }
          title={decision === 'APPROVE' ? t('admin.approve') : t('admin.reject')}
          variant={decision === 'APPROVE' ? 'success' : 'destructive'}
          disabled={notes.trim().length < 3}
          onConfirm={() =>
            api(`/v1/admin/verifications/${id}/review`, { method: 'POST', json: { decision, notes } }).then(
              () => router.refresh(),
            )
          }
        >
          <div className="space-y-2">
            <Label htmlFor={`notes-${id}`}>{t('admin.notes')}</Label>
            <Textarea id={`notes-${id}`} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </ActionDialog>
      ))}
    </div>
  );
}

export function RiskAlertActions({ alert }: { alert: any }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const options =
    alert.status === 'OPEN'
      ? ['START_REVIEW', 'CONFIRM', 'DISMISS']
      : alert.status === 'REVIEWING'
        ? ['CONFIRM', 'DISMISS']
        : ['CONTEST'];
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((action) => (
        <ActionDialog
          key={action}
          trigger={
            <Button size="sm" variant={action === 'CONFIRM' ? 'destructive' : 'outline'}>
              {action.replace('_', ' ')}
            </Button>
          }
          title={`${action} — ${alert.ruleCode}`}
          disabled={note.trim().length < 3}
          onConfirm={() =>
            api(`/v1/admin/risk-alerts/${alert.id}/actions`, { method: 'POST', json: { action, note } }).then(
              () => router.refresh(),
            )
          }
        >
          <div className="space-y-2">
            <Label htmlFor={`note-${alert.id}`}>Note</Label>
            <Textarea id={`note-${alert.id}`} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </ActionDialog>
      ))}
    </div>
  );
}

export function ReconcileButton() {
  const { t } = useI18n();
  const router = useRouter();
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            setResult(await api('/v1/admin/ledger/reconcile', { method: 'POST' }));
            router.refresh();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setLoading(false);
          }
        }}
      >
        {t('admin.reconcile')}
      </Button>
      {result ? (
        <p
          className={`text-sm ${result.differences.length || result.unbalancedTransactions.length ? 'text-destructive' : 'text-success'}`}
        >
          {result.accountsChecked} accounts · {result.differences.length} differences ·{' '}
          {result.unbalancedTransactions.length} unbalanced
        </p>
      ) : null}
      <FormMessage error={error} />
    </div>
  );
}
