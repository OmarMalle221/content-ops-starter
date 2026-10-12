'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, PencilLine, Undo2 } from 'lucide-react';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { Button, Input, Label, Textarea } from '@dfn/ui';
import { ActionDialog } from '@/components/transactions/action-dialog';
import { FormMessage } from '@/components/form-message';
import { StepUpFields } from '@/components/security/step-up-fields';
import type { StepUpProof } from '@/components/security/webauthn-client';
import { ClientApiError, api, errorMessage } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n-client';

type GateAction = 'PROGRESS' | 'APPROVE' | 'REVOKE';
const MIN = 3;

/**
 * Progress / approve / revoke forms of a regulatory gate. Only the actions offered by the API
 * (server-driven `nextActions`) are rendered — COMPLIANCE staff receive none, so they see no
 * control at all. Every button posts to /v1/admin/gates/:code/{progress|approve|revoke}.
 * Approve and revoke carry a fresh second-factor proof: a code, or a passkey assertion when this
 * browser supports WebAuthn and the account has a passkey (same STEP_UP ceremony as transfers).
 */
export function GateActions({
  code,
  status,
  nextActions,
}: {
  code: string;
  status: string;
  nextActions: GateAction[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [note, setNote] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const assertion = useRef<AuthenticationResponseJSON | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const secondApproval = status === 'PENDING_SECOND_APPROVAL';

  const reset = () => {
    setNote('');
    setEvidenceRef('');
    setMfaCode('');
  };

  const submit = async (action: GateAction) => {
    const path = action === 'PROGRESS' ? 'progress' : action === 'APPROVE' ? 'approve' : 'revoke';
    const proof: StepUpProof = assertion.current
      ? { passkeyAssertion: assertion.current }
      : mfaCode.trim()
        ? { mfaCode: mfaCode.trim() }
        : {};
    assertion.current = null;
    const body =
      action === 'PROGRESS'
        ? { status: 'IN_PROGRESS', note, ...(evidenceRef.trim() ? { evidenceRef } : {}) }
        : action === 'APPROVE'
          ? { note, evidenceRef, ...proof }
          : { note, ...proof };
    try {
      await api(`/v1/admin/gates/${encodeURIComponent(code)}/${path}`, { method: 'POST', json: body });
    } catch (e) {
      if (e instanceof ClientApiError) {
        const key = `gatesAdmin.errors.${e.body.code}`;
        const localized = t(key);
        throw new Error(localized === key ? errorMessage(e) : localized);
      }
      throw e;
    }
    setSuccess(t(`gatesAdmin.done.${action}`));
    reset();
    router.refresh();
  };

  const noteValid = note.trim().length >= MIN;
  const evidenceValid = evidenceRef.trim().length >= MIN;
  const evidenceOptionalValid = evidenceRef.trim().length === 0 || evidenceValid;

  const noteField = (
    <div className="space-y-2">
      <Label htmlFor={`gate-note-${code}`}>{t('gatesAdmin.form.note')}</Label>
      <Textarea
        id={`gate-note-${code}`}
        value={note}
        maxLength={2000}
        placeholder={t('gatesAdmin.form.notePlaceholder')}
        onChange={(e) => setNote(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t('gatesAdmin.form.minChars')}</p>
    </div>
  );
  const evidenceField = (required: boolean) => (
    <div className="space-y-2">
      <Label htmlFor={`gate-evidence-${code}`}>
        {required ? t('gatesAdmin.form.evidenceRequired') : t('gatesAdmin.form.evidenceOptional')}
      </Label>
      <Input
        id={`gate-evidence-${code}`}
        value={evidenceRef}
        maxLength={500}
        placeholder={t('gatesAdmin.form.evidencePlaceholder')}
        onChange={(e) => setEvidenceRef(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t('gatesAdmin.form.evidenceHint')}</p>
    </div>
  );

  const mfaField = (formComplete: boolean) => (
    <StepUpFields
      id={`gate-mfa-${code}`}
      code={mfaCode}
      onCodeChange={setMfaCode}
      hint={t('gatesAdmin.form.mfaHint')}
      passkeyDisabled={!formComplete}
      onPasskey={(a, form) => {
        // The dialog's own submit path runs the request (loading, error, close on success).
        assertion.current = a;
        form?.requestSubmit();
      }}
    />
  );

  if (nextActions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('gatesAdmin.noActions')}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {nextActions.includes('PROGRESS') ? (
          <ActionDialog
            trigger={
              <Button size="sm" variant="outline" onClick={() => setSuccess(null)}>
                <PencilLine /> {t('gatesAdmin.actions.progress')}
              </Button>
            }
            title={`${t('gatesAdmin.actions.progress')} — ${code}`}
            description={t('gatesAdmin.form.progressDescription')}
            confirmLabel={t('gatesAdmin.actions.progress')}
            disabled={!noteValid || !evidenceOptionalValid}
            onConfirm={() => submit('PROGRESS')}
          >
            {noteField}
            {evidenceField(false)}
          </ActionDialog>
        ) : null}
        {nextActions.includes('APPROVE') ? (
          <ActionDialog
            trigger={
              <Button size="sm" variant="success" onClick={() => setSuccess(null)}>
                <CheckCircle2 />{' '}
                {secondApproval ? t('gatesAdmin.actions.approveSecond') : t('gatesAdmin.actions.approve')}
              </Button>
            }
            title={`${secondApproval ? t('gatesAdmin.actions.approveSecond') : t('gatesAdmin.actions.approve')} — ${code}`}
            description={
              secondApproval
                ? t('gatesAdmin.form.approveSecondDescription')
                : t('gatesAdmin.form.approveDescription')
            }
            confirmLabel={
              secondApproval ? t('gatesAdmin.actions.approveSecond') : t('gatesAdmin.actions.approve')
            }
            variant="success"
            disabled={!noteValid || !evidenceValid}
            onConfirm={() => submit('APPROVE')}
          >
            {noteField}
            {evidenceField(true)}
            {mfaField(noteValid && evidenceValid)}
          </ActionDialog>
        ) : null}
        {nextActions.includes('REVOKE') ? (
          <ActionDialog
            trigger={
              <Button size="sm" variant="destructive" onClick={() => setSuccess(null)}>
                <Undo2 /> {t('gatesAdmin.actions.revoke')}
              </Button>
            }
            title={`${t('gatesAdmin.actions.revoke')} — ${code}`}
            description={t('gatesAdmin.form.revokeDescription')}
            confirmLabel={t('gatesAdmin.actions.revoke')}
            variant="destructive"
            disabled={!noteValid}
            onConfirm={() => submit('REVOKE')}
          >
            {noteField}
            {mfaField(noteValid)}
          </ActionDialog>
        ) : null}
      </div>
      <FormMessage success={success} />
    </div>
  );
}
