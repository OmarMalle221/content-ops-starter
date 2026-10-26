// Administration (rôle admin + vérification en deux étapes) : fiches des programmes et ressources d'aide.
// La base applique les mêmes règles : aucun montant dans une fiche, fiche vérifiée = lien + date + auteur,
// contenu modifié sans vérification du jour = « à vérifier ».
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useProfile } from '../../app/queries';
import { Button, buttonClass, Card, Checkbox, Loading, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { benefits as tb } from '../../i18n/benefits.fr';
import { support as ts } from '../../i18n/support.fr';
import { ApiError } from '../../lib/api';
import {
    createProgram,
    updateProgram,
    updateResource,
    type AdminResource,
    type Program,
    type ProgramInput,
    type Verification
} from '../../lib/benefits';
import { formatDate } from '../../lib/format';
import { criteriaLabels, criteriaSchema } from '../../shared/benefits/engine';
import { benefitKeys, useAdminResources, usePrograms } from '../benefits/useBenefits';
import { FreeTextField } from '../distress/FreeTextField';

/** Date du jour au Québec (AAAA-MM-JJ), comme la base. */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

function AdminOnly({ children }: { children: ReactNode }) {
    const profile = useProfile();
    if (profile.isPending) return <Loading />;
    if (profile.data?.app_role !== 'admin') return <Notice tone="info">{tb.adminOnly}</Notice>;
    return <>{children}</>;
}

const verificationLine = (status: string, on: string | null, by: string | null) =>
    tb.status(status === 'verified', on ? formatDate(on) : null, by);

export function AdminHomePage() {
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tb.adminTitle}</PageTitle>
            <AdminOnly>
                <p>{tb.adminIntro}</p>
                <Link to="/admin/programmes" className={buttonClass('primary')}>
                    {tb.adminPrograms}
                </Link>
                <Link to="/admin/ressources" className={buttonClass('secondary')}>
                    {tb.adminResources}
                </Link>
                <Link to="/admin/pilote" className={buttonClass('secondary')}>
                    {ts.pilotTitle}
                </Link>
            </AdminOnly>
        </div>
    );
}

export function AdminProgramsPage() {
    const programs = usePrograms();
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tb.adminPrograms}</PageTitle>
            <AdminOnly>
                {programs.isPending ? (
                    <Loading />
                ) : (
                    <>
                        <Link to="/admin/programmes/nouvelle" className={buttonClass('primary', 'self-start')}>
                            {tb.newProgram}
                        </Link>
                        <ul className="flex list-none flex-col gap-3 p-0">
                            {(programs.data ?? []).map((p) => (
                                <li key={p.id}>
                                    <Card className="flex flex-col gap-1">
                                        <Link
                                            to={`/admin/programmes/${p.id}`}
                                            className="text-lg font-bold text-brand underline underline-offset-4"
                                        >
                                            {p.name}
                                        </Link>
                                        <p className="text-muted">
                                            {p.organization} · {tb.version(p.version)}
                                            {p.is_active ? '' : ` · ${tb.inactive}`}
                                        </p>
                                        <p className={p.verification_status === 'verified' ? '' : 'font-bold text-urgent'}>
                                            {verificationLine(p.verification_status, p.verified_on, p.verified_by)}
                                        </p>
                                    </Card>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </AdminOnly>
        </div>
    );
}

export function AdminProgramEditPage() {
    const { programId = '' } = useParams();
    const programs = usePrograms();
    const isNew = programId === 'nouvelle';
    const program = programs.data?.find((p) => p.id === programId);
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{isNew ? tb.newProgram : tb.editProgram}</PageTitle>
            <AdminOnly>
                {programs.isPending ? (
                    <Loading />
                ) : isNew || program ? (
                    <ProgramForm program={program ?? null} />
                ) : (
                    <Notice tone="error">{tb.programNotFound}</Notice>
                )}
            </AdminOnly>
        </div>
    );
}

function VerifyBox({
    checked,
    initials,
    onChecked,
    onInitials,
    error
}: {
    checked: boolean;
    initials: string;
    onChecked: (v: boolean) => void;
    onInitials: (v: string) => void;
    error: string | null;
}) {
    return (
        <fieldset className="flex flex-col gap-3 rounded-lg border-2 border-line p-4">
            <legend className="px-1 font-bold">{tb.verifyTitle}</legend>
            <Checkbox label={tb.verifyCheck} checked={checked} onChange={(e) => onChecked(e.target.checked)} />
            {checked && (
                <TextField label={tb.verifyBy} value={initials} maxLength={20} error={error} onChange={(e) => onInitials(e.target.value)} />
            )}
        </fieldset>
    );
}

function ProgramForm({ program }: { program: Program | null }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [form, setForm] = useState({
        slug: program?.slug ?? '',
        name: program?.name ?? '',
        organization: program?.organization ?? '',
        summary: program?.summary ?? '',
        howToApply: program?.how_to_apply ?? '',
        documents: program?.required_documents.join('\n') ?? '',
        officialUrl: program?.official_url ?? '',
        sourceLabel: program?.source_label ?? '',
        criteria: JSON.stringify(program?.criteria ?? { all: [] }, null, 2),
        sortOrder: String(program?.sort_order ?? 100),
        active: program?.is_active ?? true
    });
    const [verify, setVerify] = useState(false);
    const [initials, setInitials] = useState('');
    const [errors, setErrors] = useState<{ form?: string; criteria?: string; initials?: string }>({});
    const [busy, setBusy] = useState(false);
    const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

    let labels: string[] = [];
    try {
        const parsed = criteriaSchema.safeParse(JSON.parse(form.criteria));
        if (parsed.success) labels = criteriaLabels(parsed.data);
    } catch {
        labels = [];
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        let criteria;
        try {
            criteria = criteriaSchema.parse(JSON.parse(form.criteria));
        } catch {
            return setErrors({ criteria: tb.criteriaInvalid });
        }
        if (verify && initials.trim() === '') return setErrors({ initials: tb.verifyRequired });
        setErrors({});
        const input: ProgramInput = {
            slug: form.slug.trim(),
            name: form.name.trim(),
            organization: form.organization.trim(),
            summary: form.summary.trim(),
            criteria,
            required_documents: form.documents
                .split('\n')
                .map((d) => d.trim())
                .filter(Boolean),
            how_to_apply: form.howToApply.trim() || null,
            official_url: form.officialUrl.trim() || null,
            source_label: form.sourceLabel.trim(),
            sort_order: Number.parseInt(form.sortOrder, 10) || 0,
            is_active: form.active
        };
        const verification: Verification | null = verify ? { verified_by: initials, verified_on: today() } : null;
        setBusy(true);
        try {
            if (program) await updateProgram(program.id, input, verification);
            else await createProgram(input, verification);
            await queryClient.invalidateQueries({ queryKey: benefitKeys.programs });
            navigate('/admin/programmes', { state: { notice: tb.programSaved } });
        } catch (error) {
            setErrors({ form: error instanceof ApiError && error.code === '23514' ? tb.amountRefused : fr.app.genericError });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            {program && (
                <p className="text-muted">{verificationLine(program.verification_status, program.verified_on, program.verified_by)}</p>
            )}
            {!program && (
                <TextField label={tb.fields.slug} value={form.slug} maxLength={60} onChange={(e) => set({ slug: e.target.value })} />
            )}
            <TextField label={tb.fields.name} value={form.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} />
            <TextField
                label={tb.fields.organization}
                value={form.organization}
                maxLength={160}
                onChange={(e) => set({ organization: e.target.value })}
            />
            <FreeTextField
                label={tb.fields.summary}
                hint={tb.fields.summaryHint}
                value={form.summary}
                maxLength={1200}
                onValueChange={(v) => set({ summary: v })}
            />
            <FreeTextField
                label={tb.fields.howToApply}
                value={form.howToApply}
                maxLength={800}
                onValueChange={(v) => set({ howToApply: v })}
            />
            <FreeTextField label={tb.fields.documents} value={form.documents} onValueChange={(v) => set({ documents: v })} />
            <TextField
                label={tb.fields.officialUrl}
                type="url"
                value={form.officialUrl}
                onChange={(e) => set({ officialUrl: e.target.value })}
            />
            <TextField
                label={tb.fields.sourceLabel}
                value={form.sourceLabel}
                maxLength={200}
                onChange={(e) => set({ sourceLabel: e.target.value })}
            />
            <div className="flex flex-col gap-1">
                <label htmlFor="criteria-json" className="font-bold">
                    {tb.fields.criteria}
                </label>
                <p id="criteria-hint" className="text-muted">
                    {tb.fields.criteriaHint}
                </p>
                {errors.criteria && <p className="font-bold text-urgent">{errors.criteria}</p>}
                <textarea
                    id="criteria-json"
                    aria-describedby="criteria-hint"
                    className="min-h-48 rounded-lg border-2 border-muted bg-surface p-3 font-mono text-base"
                    value={form.criteria}
                    spellCheck={false}
                    onChange={(e) => set({ criteria: e.target.value })}
                />
                {labels.length > 0 && (
                    <ul className="list-disc pl-5 text-muted">
                        {labels.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                )}
            </div>
            <TextField
                label={tb.fields.sortOrder}
                inputMode="numeric"
                value={form.sortOrder}
                onChange={(e) => set({ sortOrder: e.target.value })}
            />
            <Checkbox label={tb.fields.active} checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
            <VerifyBox
                checked={verify}
                initials={initials}
                onChecked={setVerify}
                onInitials={setInitials}
                error={errors.initials ?? null}
            />
            {errors.form && <Notice tone="error">{errors.form}</Notice>}
            <Button type="submit" disabled={busy}>
                {tb.saveProgram}
            </Button>
        </form>
    );
}

export function AdminResourcesPage() {
    const resources = useAdminResources();
    const [notice, setNotice] = useState<string | null>(null);
    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tb.adminResources}</PageTitle>
            <AdminOnly>
                {notice && <Notice tone="success">{notice}</Notice>}
                {resources.isPending ? (
                    <Loading />
                ) : (
                    <ul className="flex list-none flex-col gap-3 p-0">
                        {(resources.data ?? []).map((r) => (
                            <li key={r.id}>
                                <ResourceEditor resource={r} onSaved={() => setNotice(tb.resourceSaved)} />
                            </li>
                        ))}
                    </ul>
                )}
            </AdminOnly>
        </div>
    );
}

function ResourceEditor({ resource, onSaved }: { resource: AdminResource; onSaved: () => void }) {
    const queryClient = useQueryClient();
    const [form, setForm] = useState({
        name: resource.name,
        organization: resource.organization ?? '',
        phone: resource.phone ?? '',
        sms: resource.sms ?? '',
        url: resource.url ?? '',
        description: resource.description ?? '',
        hours: resource.hours ?? '',
        sourceUrl: resource.source_url ?? '',
        active: resource.is_active
    });
    const [verify, setVerify] = useState(false);
    const [initials, setInitials] = useState('');
    const [error, setError] = useState<string | null>(null);
    const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
    const orNull = (v: string) => v.trim() || null;

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (verify && initials.trim() === '') return setError(tb.verifyRequired);
        setError(null);
        try {
            await updateResource(
                resource.id,
                {
                    name: form.name.trim(),
                    organization: orNull(form.organization),
                    phone: orNull(form.phone),
                    sms: orNull(form.sms),
                    url: orNull(form.url),
                    description: orNull(form.description),
                    hours: orNull(form.hours),
                    source_url: orNull(form.sourceUrl),
                    is_active: form.active
                },
                verify ? { verified_by: initials, verified_on: today() } : null
            );
            await queryClient.invalidateQueries({ queryKey: benefitKeys.adminResources });
            setVerify(false);
            onSaved();
        } catch {
            setError(fr.app.genericError);
        }
    }

    return (
        <details className="rounded-xl border-2 border-line bg-surface p-4">
            <summary className="flex min-h-12 cursor-pointer flex-col justify-center">
                <span className="text-lg font-bold">{resource.name}</span>
                <span className={resource.verification_status === 'verified' ? 'text-muted' : 'font-bold text-urgent'}>
                    {verificationLine(resource.verification_status, resource.verified_on, resource.verified_by)}
                </span>
            </summary>
            <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
                <TextField label={tb.fields.name} value={form.name} onChange={(e) => set({ name: e.target.value })} />
                <TextField
                    label={tb.fields.organization}
                    value={form.organization}
                    onChange={(e) => set({ organization: e.target.value })}
                />
                <TextField label={tb.fields.phone} inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
                <TextField label={tb.fields.sms} inputMode="tel" value={form.sms} onChange={(e) => set({ sms: e.target.value })} />
                <TextField label={tb.fields.url} type="url" value={form.url} onChange={(e) => set({ url: e.target.value })} />
                <FreeTextField
                    compact
                    label={tb.fields.description}
                    value={form.description}
                    onValueChange={(v) => set({ description: v })}
                />
                <TextField label={tb.fields.hours} value={form.hours} onChange={(e) => set({ hours: e.target.value })} />
                <TextField
                    label={tb.fields.sourceUrl}
                    type="url"
                    value={form.sourceUrl}
                    onChange={(e) => set({ sourceUrl: e.target.value })}
                />
                <Checkbox label={tb.fields.active} checked={form.active} onChange={(e) => set({ active: e.target.checked })} />
                <VerifyBox checked={verify} initials={initials} onChecked={setVerify} onInitials={setInitials} error={error} />
                <Button type="submit" className="self-start">
                    {tb.saveResource}
                </Button>
            </form>
        </details>
    );
}
