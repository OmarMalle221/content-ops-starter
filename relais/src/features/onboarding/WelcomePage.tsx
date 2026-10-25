import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { queryKeys, useMyConsents, useProfile } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Card, Loading, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { grantConsent, updateDisplayName } from '../../lib/api';
import { activeConsent, CONSENT_TEXTS, hasCurrentPrivacyConsent, type ConsentRecord, type UserConsentType } from '../../lib/consents';
import { ConsentTextDetails } from '../consents/ConsentTextDetails';

/** Accueil des nouveaux : consentements distincts (aucun pré-coché), puis le nom affiché à la famille. */
export function WelcomePage() {
    const profile = useProfile();
    const consents = useMyConsents();
    if (profile.isPending || consents.isPending) return <Loading />;
    if (profile.isError || consents.isError) return <Notice tone="error">{fr.app.genericError}</Notice>;
    if (!hasCurrentPrivacyConsent(consents.data)) return <ConsentsStep records={consents.data} />;
    if (!profile.data.display_name) return <NameStep />;
    return <Navigate to="/accueil" replace />;
}

function ConsentsStep({ records }: { records: ConsentRecord[] }) {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const renewal = activeConsent(records, 'privacy_policy') !== undefined;
    // Seuls les textes pas encore acceptés dans leur version en vigueur sont proposés.
    const pending = CONSENT_TEXTS.filter((text) => activeConsent(records, text.type)?.text_version !== text.version);
    const [checked, setChecked] = useState<Partial<Record<UserConsentType, boolean>>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!checked.privacy_policy) {
            setError(fr.welcome.privacyRequired);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            for (const text of pending) {
                if (checked[text.type]) await grantConsent(text.type, text.version);
            }
            await queryClient.invalidateQueries({ queryKey: queryKeys.consents(session?.user.id) });
        } catch {
            setError(fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.welcome.title}</PageTitle>
            {renewal ? (
                <Notice tone="info">{fr.welcome.renewal}</Notice>
            ) : (
                <>
                    <p>{fr.welcome.intro}</p>
                    <ul className="list-disc pl-6">
                        {fr.welcome.keyPoints.map((point) => (
                            <li key={point}>{point}</li>
                        ))}
                    </ul>
                </>
            )}
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <fieldset className="flex flex-col gap-4">
                    <legend className="mb-2 text-2xl font-bold">{fr.welcome.consentsLegend}</legend>
                    {pending.map((text) => (
                        <Card key={text.type} className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h2 className="text-xl font-bold">{text.title}</h2>
                                <span
                                    className={`rounded-full px-3 text-sm font-bold ${text.required ? 'bg-brand text-white' : 'bg-brand-soft text-brand-strong'}`}
                                >
                                    {text.required ? fr.consents.required : fr.consents.optional}
                                </span>
                            </div>
                            <p>{text.summary}</p>
                            <ConsentTextDetails text={text} />
                            <label className="flex min-h-12 cursor-pointer items-center gap-3 font-bold">
                                <input
                                    type="checkbox"
                                    className="size-6 accent-brand"
                                    name={text.type}
                                    checked={checked[text.type] ?? false}
                                    onChange={(e) => setChecked((c) => ({ ...c, [text.type]: e.target.checked }))}
                                />
                                {fr.consents.acceptNamed(text.title)}
                            </label>
                        </Card>
                    ))}
                </fieldset>
                {error && <Notice tone="error">{error}</Notice>}
                <Button type="submit" disabled={busy}>
                    {busy ? fr.welcome.saving : fr.welcome.submit}
                </Button>
            </form>
        </div>
    );
}

function NameStep() {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (trimmed.length === 0 || trimmed.length > 80 || !session) {
            setError(fr.welcome.nameError);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await updateDisplayName(session.user.id, trimmed);
            await queryClient.invalidateQueries({ queryKey: queryKeys.profile(session.user.id) });
            navigate('/accueil', { replace: true });
        } catch {
            setError(fr.app.genericError);
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
            <PageTitle>{fr.welcome.nameTitle}</PageTitle>
            <TextField
                label={fr.welcome.nameLabel}
                hint={fr.welcome.nameHint}
                error={error}
                name="display_name"
                autoComplete="given-name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
            />
            <Button type="submit" disabled={busy}>
                {fr.welcome.nameSubmit}
            </Button>
        </form>
    );
}
