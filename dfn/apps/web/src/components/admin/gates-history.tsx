import { EmptyState } from '@dfn/ui';
import { formatDate } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import type { GateEventDto } from './gates-register-table';
import { GateStatusBadge } from './gates-status-badge';

type T = (path: string) => string;

/** Event history of a gate (newest first): action, transition, actor, note and evidence. */
export function GatesHistory({ events, t, locale }: { events: GateEventDto[]; t: T; locale: Locale }) {
  if (events.length === 0) return <EmptyState title={t('gatesAdmin.historyEmpty')} />;
  return (
    <ol className="space-y-4">
      {events.map((e) => {
        const action = t(`gatesAdmin.eventActions.${e.action}`);
        return (
          <li key={e.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {action === `gatesAdmin.eventActions.${e.action}` ? e.action : action}
              </span>
              {e.fromStatus ? <GateStatusBadge status={e.fromStatus} t={t} /> : null}
              <span aria-hidden="true">→</span>
              <GateStatusBadge status={e.toStatus} t={t} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatDate(e.createdAt, locale, true)}
              {e.actor ? ` · ${t('gatesAdmin.by')} ${e.actor.name} (${e.actor.email})` : ''}
            </p>
            {e.note ? <p className="mt-2 whitespace-pre-wrap text-sm">{e.note}</p> : null}
            {e.evidenceRef ? (
              <p className="mt-1 text-xs">
                <span className="text-muted-foreground">{t('gatesAdmin.evidence')} : </span>
                <span className="break-all font-mono">{e.evidenceRef}</span>
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
