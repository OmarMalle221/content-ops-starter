import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, buttonClass, Card, Checkbox, Loading, Notice, PageTitle, RadioGroup, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf, GRANTOR_LABELS, LEGAL_BASIS_LABELS } from '../../i18n/files.fr';
import { recordFileConsent, revokeFileConsent, type FileConsentType, type LegalBasis } from '../../lib/careFiles';
import { consentText } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { ConsentTextDetails } from '../consents/ConsentTextDetails';
import { documents as td } from '../../i18n/documents.fr';
import { activeAiConsent } from '../documents/useDocuments';
import { useFileContext } from './FileLayout';
import { fileKeys, useCareRecipient, useFileConsents, useMembers } from './useFile';

const REPRESENTATIVE_BASES: LegalBasis[] = ['homologated_protection_mandate', 'tutorship', 'power_of_attorney', 'other'];

/**
 * Consentement de la personne aidée, sans lequel la base refuse tout ajout au dossier.
 * - L'aidante ou l'aidant principal enregistre un formulaire signé par la personne, ou l'accord de son
 *   représentant légal.
 * - La personne aidée, si elle a un accès, donne ou retire son accord elle-même.
 */
export function FileConsentPage() {
    const { file, access } = useFileContext();
    const consents = useFileConsents(file.id);
    const members = useMembers(file.id);
    const recipient = useCareRecipient(file.id);
    const text = consentText('care_recipient_data');
    const [editing, setEditing] = useState(false);
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    if (consents.isPending || members.isPending) return <Loading />;

    const role = access.membership?.role;
    const isOwner = access.membership?.access_level === 'owner';
    const isRecipient = role === 'care_recipient';
    const active = access.recipientConsent;
    const latest = consents.data?.find((c) => c.consent_type === 'care_recipient_data');
    const withdrawnByRecipient = Boolean(
        latest?.revoked_at && members.data?.some((m) => m.user_id === latest.revoked_by && m.role === 'care_recipient')
    );

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.consentTitle}</PageTitle>
            <p>{isRecipient ? tf.recipientIntro : tf.consentIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}

            <Card className="flex flex-col gap-2">
                <h2 className="text-xl font-bold">{active ? tf.consentActive : tf.consentNone}</h2>
                {active && (
                    <>
                        <p>{GRANTOR_LABELS[active.granted_by]}</p>
                        {active.legal_basis && <p>{LEGAL_BASIS_LABELS[active.legal_basis]}</p>}
                        {active.representative_name && <p>{tf.representative(active.representative_name)}</p>}
                        <p className="text-muted">
                            {tf.consentRecordedOn(formatDate(active.granted_at))} — {fr.consents.versionOf(formatDate(active.text_version))}
                        </p>
                    </>
                )}
                {!active && latest?.revoked_at && <p>{tf.consentRevoked(formatDate(latest.revoked_at))}</p>}
            </Card>

            <section className="flex flex-col gap-2" aria-labelledby="consent-text-title">
                <h2 id="consent-text-title" className="text-xl font-bold">
                    {text.title}
                </h2>
                <p>{text.summary}</p>
                <ConsentTextDetails text={text} open={!active} />
            </section>

            {isRecipient && (
                <RecipientActions
                    fileId={file.id}
                    version={text.version}
                    activeId={active?.id}
                    activeInApp={active?.granted_by === 'care_recipient_in_app'}
                    onStatus={setStatus}
                />
            )}

            {isOwner && withdrawnByRecipient && !active && <Notice tone="info">{tf.withdrawnByRecipient}</Notice>}

            {isOwner && (!active || editing) && (
                <OwnerForm
                    fileId={file.id}
                    version={text.version}
                    allowSignedForm={!withdrawnByRecipient}
                    hasProfile={Boolean(recipient.data)}
                    onDone={(message) => {
                        setEditing(false);
                        setStatus({ tone: 'success', text: message });
                    }}
                />
            )}

            {isOwner && active && !editing && (
                <div className="flex flex-col gap-3">
                    <Button variant="secondary" onClick={() => setEditing(true)}>
                        {tf.recordConsent}
                    </Button>
                    <RevokeBox consentId={active.id} fileId={file.id} onStatus={setStatus} />
                </div>
            )}

            {(isOwner || isRecipient) && (
                <AiConsentSection fileId={file.id} isOwner={isOwner} isRecipient={isRecipient} recipientConsentActive={Boolean(active)} />
            )}
        </div>
    );
}

/** Consentement distinct et facultatif : lecture automatique des documents (règle no 4). */
function AiConsentSection({
    fileId,
    isOwner,
    isRecipient,
    recipientConsentActive
}: {
    fileId: string;
    isOwner: boolean;
    isRecipient: boolean;
    recipientConsentActive: boolean;
}) {
    const consents = useFileConsents(fileId);
    const members = useMembers(fileId);
    const text = consentText('ai_document_processing');
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    const active = activeAiConsent(consents.data);
    const latest = consents.data?.find((c) => c.consent_type === 'ai_document_processing');
    const withdrawnByRecipient = Boolean(
        latest?.revoked_at && members.data?.some((m) => m.user_id === latest.revoked_by && m.role === 'care_recipient')
    );

    return (
        <section aria-labelledby="ai-consent-title" className="flex flex-col gap-3 border-t-2 border-line pt-5">
            <h2 id="ai-consent-title" className="text-2xl font-bold">
                {td.aiConsentTitle}
            </h2>
            <p>{td.aiConsentIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <Card className="flex flex-col gap-2">
                <h3 className="text-xl font-bold">{active ? td.aiConsentActive : td.aiConsentNone}</h3>
                {active && (
                    <>
                        <p>{GRANTOR_LABELS[active.granted_by]}</p>
                        {active.representative_name && <p>{tf.representative(active.representative_name)}</p>}
                        <p className="text-muted">{tf.consentRecordedOn(formatDate(active.granted_at))}</p>
                    </>
                )}
                {!active && latest?.revoked_at && <p>{td.aiConsentRevoked(formatDate(latest.revoked_at))}</p>}
            </Card>
            <p className="font-bold">{text.title}</p>
            <p>{text.summary}</p>
            <ConsentTextDetails text={text} open={false} />
            {!recipientConsentActive ? (
                <Notice tone="info">{td.aiConsentNeedsRecipient}</Notice>
            ) : (
                <>
                    {isRecipient && (
                        <RecipientActions
                            fileId={fileId}
                            type="ai_document_processing"
                            version={text.version}
                            activeId={active?.id}
                            activeInApp={active?.granted_by === 'care_recipient_in_app'}
                            onStatus={setStatus}
                        />
                    )}
                    {isOwner && !active && (
                        <OwnerForm
                            fileId={fileId}
                            type="ai_document_processing"
                            version={text.version}
                            allowSignedForm={!withdrawnByRecipient}
                            hasProfile
                            onDone={setStatusText(setStatus)}
                        />
                    )}
                    {isOwner && active && (
                        <RevokeBox consentId={active.id} fileId={fileId} type="ai_document_processing" onStatus={setStatus} />
                    )}
                </>
            )}
        </section>
    );
}

const setStatusText =
    (set: (status: { tone: 'success' | 'error'; text: string }) => void) =>
    (message: string): void =>
        set({ tone: 'success', text: message });

function OwnerForm({
    fileId,
    type = 'care_recipient_data',
    version,
    allowSignedForm,
    hasProfile,
    onDone
}: {
    fileId: string;
    type?: FileConsentType;
    version: string;
    allowSignedForm: boolean;
    hasProfile: boolean;
    onDone: (message: string) => void;
}) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [option, setOption] = useState<'self' | 'representative' | null>(allowSignedForm ? null : 'representative');
    const [attested, setAttested] = useState(false);
    const [legalBasis, setLegalBasis] = useState<LegalBasis>('homologated_protection_mandate');
    const [representative, setRepresentative] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!option) return setError(tf.chooseOption);
        if (option === 'representative' && representative.trim() === '') return setError(tf.representativeRequired);
        if (!attested) return setError(tf.attestRequired);
        setBusy(true);
        setError(null);
        try {
            await recordFileConsent(
                option === 'self'
                    ? { fileId, type, version, grantedBy: 'care_recipient_signed_form', legalBasis: 'person_consents' }
                    : { fileId, type, version, grantedBy: 'legal_representative', legalBasis, representativeName: representative.trim() }
            );
            await queryClient.invalidateQueries({ queryKey: fileKeys.consents(fileId) });
            // Première fois : on enchaîne avec le profil de la personne aidée.
            if (!hasProfile) navigate(`/dossiers/${fileId}/profil`);
            else onDone(type === 'ai_document_processing' ? td.aiRecorded : tf.recorded);
        } catch {
            setError(fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    const options: Array<{ value: 'self' | 'representative'; label: string; description?: string }> = [
        ...(allowSignedForm ? [{ value: 'self' as const, label: tf.optionSelf, description: tf.optionSelfHint }] : []),
        { value: 'representative', label: tf.optionRepresentative }
    ];

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <RadioGroup
                legend={tf.whoConsents}
                name="consent-option"
                value={option}
                options={options}
                onChange={(value) => {
                    setOption(value);
                    setAttested(false);
                }}
            />
            {option === 'self' && (
                <>
                    <Link to={`/dossiers/${fileId}/formulaire-consentement`} className={buttonClass('secondary')}>
                        {tf.printForm}
                    </Link>
                    <Checkbox label={tf.attestSelf} checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                </>
            )}
            {option === 'representative' && (
                <>
                    <SelectField
                        label={tf.legalBasisLabel}
                        value={legalBasis}
                        onChange={(e) => setLegalBasis(e.target.value as LegalBasis)}
                        options={REPRESENTATIVE_BASES.map((b) => ({ value: b, label: LEGAL_BASIS_LABELS[b] ?? b }))}
                    />
                    <TextField
                        label={tf.representativeLabel}
                        hint={tf.representativeHint}
                        value={representative}
                        maxLength={120}
                        onChange={(e) => setRepresentative(e.target.value)}
                    />
                    <Checkbox label={tf.attestRepresentative} checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                </>
            )}
            <Notice tone="info">{tf.noRepresentative}</Notice>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy}>
                {busy ? tf.saving : type === 'ai_document_processing' ? td.aiRecord : tf.save}
            </Button>
        </form>
    );
}

function RecipientActions({
    fileId,
    type = 'care_recipient_data',
    version,
    activeId,
    activeInApp,
    onStatus
}: {
    fileId: string;
    type?: FileConsentType;
    version: string;
    activeId: string | undefined;
    activeInApp: boolean;
    onStatus: (status: { tone: 'success' | 'error'; text: string }) => void;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);

    async function give() {
        setBusy(true);
        try {
            await recordFileConsent({ fileId, type, version, grantedBy: 'care_recipient_in_app', legalBasis: 'person_consents' });
            await queryClient.invalidateQueries({ queryKey: fileKeys.consents(fileId) });
            onStatus({ tone: 'success', text: tf.recorded });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-3">
            {!activeInApp && (
                <Button onClick={() => void give()} disabled={busy}>
                    {type === 'ai_document_processing' ? td.aiRecipientGive : tf.recipientGive}
                </Button>
            )}
            {activeId && <RevokeBox consentId={activeId} fileId={fileId} type={type} onStatus={onStatus} />}
        </div>
    );
}

function RevokeBox({
    consentId,
    fileId,
    type = 'care_recipient_data',
    onStatus
}: {
    consentId: string;
    fileId: string;
    type?: FileConsentType;
    onStatus: (status: { tone: 'success' | 'error'; text: string }) => void;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const ai = type === 'ai_document_processing';
    const labelId = ai ? 'revoke-ai-consent' : 'revoke-file-consent';

    async function revoke() {
        setBusy(true);
        try {
            await revokeFileConsent(consentId, type);
            await queryClient.invalidateQueries({ queryKey: fileKeys.consents(fileId) });
            onStatus({ tone: 'success', text: ai ? td.aiRevoked : tf.revoked });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    }

    if (!confirming) {
        return (
            <Button variant="secondary" onClick={() => setConfirming(true)}>
                {ai ? td.aiRevoke : tf.revoke}
            </Button>
        );
    }
    return (
        <div role="group" aria-labelledby={labelId} className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
            <p id={labelId} className="font-bold">
                {ai ? td.aiConfirmRevoke : tf.confirmRevoke}
            </p>
            <p>{ai ? td.aiRevokeEffect : tf.revokeEffect}</p>
            <div className="flex flex-wrap gap-2">
                <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
                    {tf.confirm}
                </Button>
                <Button variant="secondary" onClick={() => setConfirming(false)}>
                    {tf.cancel}
                </Button>
            </div>
        </div>
    );
}
