'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FileText, MessageSquareWarning, Send } from 'lucide-react';
import { Button, Label, Textarea, cn } from '@dfn/ui';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { useI18n } from '@/lib/i18n-client';
import { StatusBadge } from '@/components/status-badge';
import { ActionDialog } from './action-dialog';
import { UploadDocumentDialog } from './upload-dialog';

export function MilestoneCard({ tx, milestone, documents }: { tx: any; milestone: any; documents: any[] }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [changes, setChanges] = useState('');
  // Server-driven: a party whose organisation role lacks TRANSACTION_MANAGE (VIEWER) gets neither.
  const actions: string[] = tx.nextActions ?? [];
  const canSubmit =
    tx.myRole === 'SELLER' &&
    actions.includes('SUBMIT_MILESTONE') &&
    ['PENDING', 'CHANGES_REQUESTED'].includes(milestone.status) &&
    ['FUNDED', 'IN_PROGRESS', 'DISPUTED'].includes(tx.status);
  const canReview =
    tx.myRole === 'BUYER' && actions.includes('REQUEST_CHANGES') && milestone.status === 'SUBMITTED';
  const frozen = tx.releaseFrozen || tx.status === 'DISPUTED';
  const sellerDocs = documents.filter((d) => d.transactionId === tx.id);
  const requiredKinds: string[] = milestone.requiredEvidence ?? [];
  const selectedKinds = new Set(sellerDocs.filter((d) => selected.includes(d.id)).map((d) => d.kind));
  const missing = requiredKinds.filter((k) => !selectedKinds.has(k));

  return (
    <li
      className={cn(
        'rounded-lg border p-4',
        milestone.status === 'RELEASED' && 'border-success/40 bg-success/5',
        milestone.status === 'SUBMITTED' && 'border-warning/50',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {milestone.sequence}. {milestone.title}
          </p>
          {milestone.description ? (
            <p className="text-sm text-muted-foreground">{milestone.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {t('tx.requiredEvidence')}: {requiredKinds.map((k) => t(`docs.kinds.${k}`)).join(', ') || '—'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-semibold tabular-nums">{formatMoney(milestone.amount, locale)}</span>
          <StatusBadge status={milestone.status} />
        </div>
      </div>
      {milestone.rejectionNote && milestone.status === 'CHANGES_REQUESTED' ? (
        <p className="mt-2 rounded-md bg-warning/10 p-2 text-xs text-foreground">
          <MessageSquareWarning className="mr-1 inline size-3.5 text-warning" /> {milestone.rejectionNote}
        </p>
      ) : null}
      {milestone.evidences?.length ? (
        <ul className="mt-3 space-y-1">
          {milestone.evidences.map((e: any) => (
            <li key={e.id} className="flex items-center gap-2 text-sm">
              <FileText className="size-4 text-muted-foreground" />
              <a
                className="text-primary hover:underline"
                href={`/api/v1/documents/${e.document.id}/download`}
              >
                {e.document.title}
              </a>
              <span className="text-xs text-muted-foreground">
                · {t(`docs.kinds.${e.document.kind}`)} · {formatDate(e.createdAt, locale)}
              </span>
              {e.note ? <span className="text-xs text-muted-foreground">— {e.note}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canSubmit ? (
          <>
            <UploadDocumentDialog
              transactionId={tx.id}
              defaultKind={requiredKinds[0] ?? 'PROOF_OF_SHIPMENT'}
              onUploaded={(doc) => setSelected((s) => [...s, doc.id])}
            />
            <ActionDialog
              trigger={
                <Button size="sm">
                  <Send /> {t('actions.SUBMIT_MILESTONE')}
                </Button>
              }
              title={`${t('actions.SUBMIT_MILESTONE')} — ${milestone.title}`}
              description={`${t('tx.requiredEvidence')}: ${requiredKinds.map((k) => t(`docs.kinds.${k}`)).join(', ')}`}
              disabled={selected.length === 0 || missing.length > 0}
              onConfirm={async () => {
                await api(`/v1/transactions/${tx.id}/milestones/${milestone.id}/submit`, {
                  method: 'POST',
                  json: { documentIds: selected, note: note || undefined },
                });
                setSelected([]);
                setNote('');
                router.refresh();
              }}
            >
              <div className="space-y-2">
                <Label>{t('tx.evidence')}</Label>
                {sellerDocs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('common.empty')}</p>
                ) : null}
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                  {sellerDocs.map((d) => (
                    <li key={d.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.includes(d.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id),
                            )
                          }
                        />
                        <span className="truncate">{d.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {t(`docs.kinds.${d.kind}`)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {missing.length ? (
                  <p className="text-xs text-warning">
                    {missing.map((k) => t(`docs.kinds.${k}`)).join(', ')}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label htmlFor={`note-${milestone.id}`}>{t('tx.noteOptional')}</Label>
                <Textarea
                  id={`note-${milestone.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </ActionDialog>
          </>
        ) : null}
        {canReview ? (
          <>
            <ActionDialog
              trigger={
                <Button
                  size="sm"
                  variant="success"
                  disabled={frozen}
                  title={frozen ? t('dispute.frozen') : undefined}
                >
                  <CheckCircle2 /> {t('actions.APPROVE_MILESTONE')}
                </Button>
              }
              title={`${t('actions.APPROVE_MILESTONE')} — ${formatMoney(milestone.amount, locale)}`}
              description={t('app.sandbox')}
              variant="success"
              onConfirm={() =>
                api(`/v1/transactions/${tx.id}/milestones/${milestone.id}/approve`, {
                  method: 'POST',
                  json: { note: note || undefined },
                }).then(() => router.refresh())
              }
            >
              <div className="space-y-2">
                <Label htmlFor={`approve-note-${milestone.id}`}>{t('tx.noteOptional')}</Label>
                <Textarea
                  id={`approve-note-${milestone.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </ActionDialog>
            <ActionDialog
              trigger={
                <Button size="sm" variant="outline">
                  <MessageSquareWarning /> {t('actions.REQUEST_CHANGES')}
                </Button>
              }
              title={t('actions.REQUEST_CHANGES')}
              disabled={changes.trim().length < 3}
              onConfirm={() =>
                api(`/v1/transactions/${tx.id}/milestones/${milestone.id}/request-changes`, {
                  method: 'POST',
                  json: { note: changes },
                }).then(() => router.refresh())
              }
            >
              <div className="space-y-2">
                <Label htmlFor={`changes-${milestone.id}`}>{t('tx.note')}</Label>
                <Textarea
                  id={`changes-${milestone.id}`}
                  value={changes}
                  onChange={(e) => setChanges(e.target.value)}
                  required
                />
              </div>
            </ActionDialog>
            {frozen ? <p className="w-full text-xs text-destructive">{t('dispute.frozen')}</p> : null}
          </>
        ) : null}
      </div>
    </li>
  );
}
