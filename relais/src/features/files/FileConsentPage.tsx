import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, buttonClass, Card, Checkbox, Loading, Notice, PageTitle, RadioGroup, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf, GRANTOR_LABELS, LEGAL_BASIS_LABELS } from '../../i18n/files.fr';
import { recordFileConsent, revokeFileConsent, type LegalBasis } from '../../lib/careFiles';
import { consentText } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { ConsentTextDetails } from '../consents/ConsentTextDetails';
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
        </div>
    );
}

function OwnerForm({
    fileId,
    version,
    allowSignedForm,
    hasProfile,
    onDone
}: {
    fileId: string;
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
                    ? { fileId, version, grantedBy: 'care_recipient_signed_form', legalBasis: 'person_consents' }
                    : { fileId, version, grantedBy: 'legal_representative', legalBasis, representativeName: representative.trim() }
            );
            await queryClient.invalidateQueries({ queryKey: fileKeys.consents(fileId) });
            // Première fois : on enchaîne avec le profil de la personne aidée.
            if (!hasProfile) navigate(`/dossiers/${fileId}/profil`);
            else onDone(tf.recorded);
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
                {busy ? tf.saving : tf.save}
            </Button>
        </form>
    );
}

function RecipientActions({
    fileId,
    version,
    activeId,
    activeInApp,
    onStatus
}: {
    fileId: string;
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
            await recordFileConsent({ fileId, version, grantedBy: 'care_recipient_in_app', legalBasis: 'person_consents' });
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
                    {tf.recipientGive}
                </Button>
            )}
            {activeId && <RevokeBox consentId={activeId} fileId={fileId} onStatus={onStatus} />}
        </div>
    );
}

function RevokeBox({
    consentId,
    fileId,
    onStatus
}: {
    consentId: string;
    fileId: string;
    onStatus: (status: { tone: 'success' | 'error'; text: string }) => void;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);

    async function revoke() {
        setBusy(true);
        try {
            await revokeFileConsent(consentId);
            await queryClient.invalidateQueries({ queryKey: fileKeys.consents(fileId) });
            onStatus({ tone: 'success', text: tf.revoked });
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
                {tf.revoke}
            </Button>
        );
    }
    return (
        <div role="group" aria-labelledby="revoke-file-consent" className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
            <p id="revoke-file-consent" className="font-bold">
                {tf.confirmRevoke}
            </p>
            <p>{tf.revokeEffect}</p>
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
