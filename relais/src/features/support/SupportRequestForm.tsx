import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useProfile } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Notice, RadioGroup, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { support as ts } from '../../i18n/support.fr';
import { createSupportRequest, type SupportOrigin } from '../../lib/support';
import { FreeTextField } from '../distress/FreeTextField';
import { useMyFiles } from '../files/useFile';
import { supportKeys } from './useSupport';

/**
 * Demande de rappel par une intervenante. Version complète (page) ou courte (écran d'urgence : sans
 * message ni dossier, pour ne pas retenir la personne). Aucun délai n'est promis.
 */
export function SupportRequestForm({ origin, compact = false }: { origin: SupportOrigin; compact?: boolean }) {
    const queryClient = useQueryClient();
    const { session } = useSession();
    const profile = useProfile();
    const myFiles = useMyFiles();
    // Prénom du profil proposé tant que la personne n'a rien tapé.
    const [typedName, setName] = useState<string | null>(null);
    const name = typedName ?? profile.data?.display_name ?? '';
    const [contactBy, setContactBy] = useState<'phone' | 'email'>('phone');
    const [phone, setPhone] = useState('');
    const [times, setTimes] = useState('');
    const [message, setMessage] = useState('');
    const [fileId, setFileId] = useState('');
    const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(false);

    if (sent) return <Notice tone="success">{ts.sent}</Notice>;

    async function submit(event: FormEvent) {
        event.preventDefault();
        const next = {
            name: name.trim() ? undefined : ts.contactNameError,
            phone: contactBy === 'phone' && phone.replace(/\D/g, '').length < 7 ? ts.phoneError : undefined
        };
        setErrors(next);
        if (next.name || next.phone) return;
        setBusy(true);
        setError(null);
        try {
            await createSupportRequest({
                origin,
                contact_name: name,
                preferred_contact: contactBy,
                phone: contactBy === 'phone' ? phone : null,
                preferred_times: times || null,
                message: compact ? null : message || null,
                care_file_id: compact ? null : fileId || null
            });
            await queryClient.invalidateQueries({ queryKey: supportKeys.myRequests(session?.user.id) });
            setSent(true);
        } catch {
            setError(fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    const files = myFiles.data ?? [];
    return (
        <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
            <TextField
                label={ts.contactName}
                autoComplete="given-name"
                value={name}
                maxLength={80}
                error={errors.name ?? null}
                onChange={(e) => setName(e.target.value)}
            />
            <RadioGroup
                legend={ts.contactBy}
                name={`contact-by-${compact ? 'short' : 'full'}`}
                value={contactBy}
                options={[
                    { value: 'phone', label: ts.byPhone },
                    { value: 'email', label: ts.byEmail, description: ts.byEmailHint }
                ]}
                onChange={setContactBy}
            />
            {contactBy === 'phone' && (
                <TextField
                    label={ts.phone}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    maxLength={40}
                    error={errors.phone ?? null}
                    onChange={(e) => setPhone(e.target.value)}
                />
            )}
            <TextField label={ts.times} hint={ts.timesHint} value={times} maxLength={240} onChange={(e) => setTimes(e.target.value)} />
            {!compact && (
                <>
                    <FreeTextField label={ts.message} value={message} maxLength={2000} onValueChange={setMessage} />
                    {files.length > 0 && (
                        <SelectField
                            label={ts.file}
                            hint={ts.fileHint}
                            value={fileId}
                            options={[{ value: '', label: ts.noFile }, ...files.map(({ file }) => ({ value: file.id, label: file.title }))]}
                            onChange={(e) => setFileId(e.target.value)}
                        />
                    )}
                </>
            )}
            {origin === 'checkin' && <p className="text-muted">{ts.checkinNotShared}</p>}
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" className="self-start" disabled={busy}>
                {busy ? ts.sending : ts.send}
            </Button>
        </form>
    );
}
