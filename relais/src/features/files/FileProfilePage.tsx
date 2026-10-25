import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, buttonClass, Card, Checkbox, Loading, Notice, PageTitle, RadioGroup, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf, LIVING_SETTING_LABELS, SERVICE_LABELS } from '../../i18n/files.fr';
import {
    LIVING_SETTINGS,
    saveCareNeeds,
    saveCareRecipient,
    SERVICES,
    type CareNeeds,
    type CareRecipient,
    type CareRecipientInput
} from '../../lib/careFiles';
import { formatDate } from '../../lib/format';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from './FileLayout';
import { fileKeys, useCareNeeds, useCareRecipient } from './useFile';

type Status = { tone: 'success' | 'error'; text: string } | null;

export function FileProfilePage() {
    const { file, access } = useFileContext();
    const recipient = useCareRecipient(file.id);
    const needs = useCareNeeds(file.id, access.canRead('health'));
    if (recipient.isPending) return <Loading />;

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.profileTitle}</PageTitle>
            {access.canWrite('profile') ? (
                <ProfileForm fileId={file.id} current={recipient.data ?? null} />
            ) : (
                <ProfileView recipient={recipient.data ?? null} />
            )}
            {access.canRead('health') && (
                <section aria-labelledby="needs-title" className="flex flex-col gap-3">
                    <h2 id="needs-title" className="text-2xl font-bold">
                        {tf.needsTitle}
                    </h2>
                    <p className="text-muted">{tf.needsHealthNote}</p>
                    {needs.isPending ? (
                        <Loading />
                    ) : access.canWrite('health') ? (
                        <NeedsForm fileId={file.id} current={needs.data ?? null} />
                    ) : (
                        <>
                            {access.recipientConsent &&
                                !access.myHealthConsent &&
                                access.membership &&
                                ['owner', 'full'].includes(access.membership.access_level) && (
                                    <Notice tone="info">
                                        <p>{tf.needsNoHealthConsent}</p>
                                        <Link to="/mes-consentements" className={buttonClass('quiet', 'px-0')}>
                                            {fr.home.healthLink}
                                        </Link>
                                    </Notice>
                                )}
                            <NeedsView needs={needs.data ?? null} />
                        </>
                    )}
                </section>
            )}
        </div>
    );
}

function ProfileView({ recipient }: { recipient: CareRecipient | null }) {
    if (!recipient) return <p className="text-muted">{tf.profileMissing}</p>;
    return (
        <Card>
            <p className="text-muted">{tf.readOnly}</p>
            <dl className="mt-2 grid gap-2">
                <dt className="font-bold">{tf.firstName}</dt>
                <dd>{[recipient.first_name, recipient.last_name].filter(Boolean).join(' ')}</dd>
                {recipient.birth_year && (
                    <>
                        <dt className="font-bold">{tf.birthYear}</dt>
                        <dd>{recipient.birth_year}</dd>
                    </>
                )}
                <dt className="font-bold">{tf.livingSetting}</dt>
                <dd>
                    {LIVING_SETTING_LABELS[recipient.living_setting]}
                    {recipient.residence_name && ` : ${recipient.residence_name}`}
                    {recipient.living_setting_since && `, ${tf.since(formatDate(recipient.living_setting_since))}`}
                </dd>
                {recipient.chsld_waitlist && (
                    <dd>
                        {recipient.chsld_waitlist_since
                            ? tf.chsldWaitlistSince(formatDate(recipient.chsld_waitlist_since))
                            : tf.chsldWaitlist}
                    </dd>
                )}
            </dl>
        </Card>
    );
}

function ProfileForm({ fileId, current }: { fileId: string; current: CareRecipient | null }) {
    const queryClient = useQueryClient();
    const [firstName, setFirstName] = useState(current?.first_name ?? '');
    const [lastName, setLastName] = useState(current?.last_name ?? '');
    const [birthYear, setBirthYear] = useState(current?.birth_year ? String(current.birth_year) : '');
    const [living, setLiving] = useState<CareRecipient['living_setting'] | null>(current?.living_setting ?? null);
    const [since, setSince] = useState(current?.living_setting_since ?? '');
    const [residence, setResidence] = useState(current?.residence_name ?? '');
    const [waitlist, setWaitlist] = useState(current?.chsld_waitlist ?? false);
    const [waitlistSince, setWaitlistSince] = useState(current?.chsld_waitlist_since ?? '');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<Status>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const next: Record<string, string> = {};
        const year = birthYear.trim() === '' ? null : Number(birthYear);
        if (firstName.trim() === '' || firstName.trim().length > 60) next.firstName = tf.firstNameError;
        if (year !== null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()))
            next.birthYear = tf.birthYearError;
        if (!living) next.living = fr.app.genericError;
        setErrors(next);
        setStatus(null);
        if (Object.keys(next).length > 0 || !living) return;

        const input: CareRecipientInput = {
            first_name: firstName.trim(),
            last_name: lastName.trim() || null,
            birth_year: year,
            living_setting: living,
            living_setting_since: since || null,
            residence_name: residence.trim() || null,
            chsld_waitlist: waitlist,
            chsld_waitlist_since: waitlist ? waitlistSince || null : null
        };
        setBusy(true);
        try {
            await saveCareRecipient(fileId, input, current !== null);
            await queryClient.invalidateQueries({ queryKey: fileKeys.recipient(fileId) });
            setStatus({ tone: 'success', text: tf.profileSaved });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <TextField
                label={tf.firstName}
                name="first_name"
                autoComplete="off"
                maxLength={60}
                value={firstName}
                error={errors.firstName}
                onChange={(e) => setFirstName(e.target.value)}
            />
            <TextField
                label={tf.lastName}
                name="last_name"
                autoComplete="off"
                maxLength={60}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
            />
            <TextField
                label={tf.birthYear}
                hint={tf.birthYearHint}
                name="birth_year"
                inputMode="numeric"
                maxLength={4}
                value={birthYear}
                error={errors.birthYear}
                onChange={(e) => setBirthYear(e.target.value)}
            />
            <RadioGroup
                legend={tf.livingSetting}
                name="living_setting"
                value={living}
                error={errors.living ? tf.livingSetting : null}
                options={LIVING_SETTINGS.map((value) => ({ value, label: LIVING_SETTING_LABELS[value] ?? value }))}
                onChange={setLiving}
            />
            <TextField
                label={tf.livingSettingSince}
                type="date"
                name="living_setting_since"
                value={since}
                onChange={(e) => setSince(e.target.value)}
            />
            {living && living !== 'home' && (
                <TextField
                    label={tf.residenceName}
                    name="residence_name"
                    maxLength={120}
                    value={residence}
                    onChange={(e) => setResidence(e.target.value)}
                />
            )}
            <Checkbox label={tf.chsldWaitlistLabel} checked={waitlist} onChange={(e) => setWaitlist(e.target.checked)} />
            {waitlist && (
                <TextField
                    label={tf.chsldWaitlistSinceLabel}
                    type="date"
                    name="chsld_waitlist_since"
                    value={waitlistSince}
                    onChange={(e) => setWaitlistSince(e.target.value)}
                />
            )}
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <Button type="submit" disabled={busy}>
                {busy ? tf.saving : tf.saveProfile}
            </Button>
        </form>
    );
}

function NeedsView({ needs }: { needs: CareNeeds | null }) {
    if (!needs) return <p className="text-muted">{tf.nothingYet}</p>;
    return (
        <Card>
            <dl className="grid gap-2">
                <dt className="font-bold">{tf.autonomy}</dt>
                <dd className="whitespace-pre-line">{needs.autonomy_description || tf.nothingYet}</dd>
                <dt className="font-bold">{tf.services}</dt>
                <dd>{needs.services_in_place.map((s) => SERVICE_LABELS[s] ?? s).join(', ') || tf.nothingYet}</dd>
                <dt className="font-bold">{tf.adaptation}</dt>
                <dd className="whitespace-pre-line">{needs.home_adaptation_needs || tf.nothingYet}</dd>
            </dl>
        </Card>
    );
}

function NeedsForm({ fileId, current }: { fileId: string; current: CareNeeds | null }) {
    const queryClient = useQueryClient();
    const [autonomy, setAutonomy] = useState(current?.autonomy_description ?? '');
    const [services, setServices] = useState<string[]>(current?.services_in_place ?? []);
    const [adaptation, setAdaptation] = useState(current?.home_adaptation_needs ?? '');
    const [status, setStatus] = useState<Status>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setStatus(null);
        try {
            await saveCareNeeds(
                fileId,
                {
                    autonomy_description: autonomy.trim() || null,
                    services_in_place: services,
                    home_adaptation_needs: adaptation.trim() || null
                },
                current !== null
            );
            await queryClient.invalidateQueries({ queryKey: fileKeys.needs(fileId) });
            setStatus({ tone: 'success', text: tf.needsSaved });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <FreeTextField label={tf.autonomy} hint={tf.autonomyHint} maxLength={4000} value={autonomy} onValueChange={setAutonomy} />
            <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 font-bold">{tf.services}</legend>
                {SERVICES.map((service) => (
                    <Checkbox
                        key={service}
                        label={SERVICE_LABELS[service]}
                        checked={services.includes(service)}
                        onChange={(e) => setServices((list) => (e.target.checked ? [...list, service] : list.filter((s) => s !== service)))}
                    />
                ))}
            </fieldset>
            <FreeTextField
                label={tf.adaptation}
                hint={tf.adaptationHint}
                maxLength={2000}
                value={adaptation}
                onValueChange={setAdaptation}
            />
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <Button type="submit" disabled={busy}>
                {busy ? tf.saving : tf.saveNeeds}
            </Button>
        </form>
    );
}
