'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserCheck } from 'lucide-react';
import { Button, Select } from '@dfn/ui';
import { api, errorMessage } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';

const UNASSIGN = '__unassign__';

/**
 * Assignee cell: current assignee, "assign to me" and reassign / unassign through
 * POST /v1/admin/risk-alerts/:id/assign. Only the actions the API lists in `nextActions` are shown.
 */
export function ReviewQueueAssign({
  alert,
  assignees,
}: {
  alert: {
    id: string;
    assignedTo: { id: string; name: string } | null;
    assignedAt: string | null;
    nextActions: string[];
  };
  assignees: Array<{ id: string; name: string }>;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = (a: string) => alert.nextActions.includes(a);

  const assign = async (assigneeUserId: string | null) => {
    setLoading(true);
    setError(null);
    try {
      await api(`/v1/admin/risk-alerts/${alert.id}/assign`, { method: 'POST', json: { assigneeUserId } });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const others = assignees.filter((u) => u.id !== alert.assignedTo?.id);
  return (
    <div className="space-y-1 text-xs">
      <p>
        <span className="text-muted-foreground">{t('reviewQueue.assign.assignee')} : </span>
        <span className="font-medium">{alert.assignedTo?.name ?? t('reviewQueue.assign.nobody')}</span>
        {alert.assignedTo && alert.assignedAt ? (
          <span className="text-muted-foreground">
            {' '}
            ({t('reviewQueue.assign.since')} {formatDate(alert.assignedAt, locale, true)})
          </span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {can('ASSIGN_TO_ME') ? (
          <Button size="sm" variant="outline" loading={loading} onClick={() => assign('me')}>
            <UserCheck /> {t('reviewQueue.assign.assignToMe')}
          </Button>
        ) : null}
        {can('ASSIGN') && (others.length || can('UNASSIGN')) ? (
          <Select
            aria-label={t('reviewQueue.assign.reassign')}
            className="h-8 w-44 text-xs"
            value=""
            disabled={loading}
            onChange={(e) => {
              const v = e.target.value;
              if (v) void assign(v === UNASSIGN ? null : v);
            }}
          >
            <option value="">{t('reviewQueue.assign.reassign')}</option>
            {others.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
            {can('UNASSIGN') ? <option value={UNASSIGN}>{t('reviewQueue.assign.unassign')}</option> : null}
          </Select>
        ) : null}
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
