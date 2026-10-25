import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, buttonClass, Card, Loading, Notice, PageTitle, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { CONTACT_KIND_LABELS, files as tf } from '../../i18n/files.fr';
import { CONTACT_KINDS, createContact, deleteContact, updateContact, type Contact, type ContactInput } from '../../lib/careFiles';
import { dialable } from '../../lib/format';
import { FreeTextField } from '../distress/FreeTextField';
import { useFileContext } from './FileLayout';
import { fileKeys, useContacts } from './useFile';

type Status = { tone: 'success' | 'error'; text: string } | null;

export function FileContactsPage() {
    const { file, access } = useFileContext();
    const contacts = useContacts(file.id);
    const canWrite = access.canWrite('coordination');
    const [editing, setEditing] = useState<string | 'new' | null>(null);
    const [status, setStatus] = useState<Status>(null);

    if (contacts.isPending) return <Loading />;
    const list = contacts.data ?? [];

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.contactsTitle}</PageTitle>
            <p>{tf.contactsIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            {list.length === 0 && <p className="text-muted">{tf.noContacts}</p>}
            <ul className="flex list-none flex-col gap-3 p-0">
                {list.map((contact) => (
                    <li key={contact.id}>
                        {editing === contact.id ? (
                            <ContactForm
                                fileId={file.id}
                                current={contact}
                                onDone={(s) => {
                                    setEditing(null);
                                    setStatus(s);
                                }}
                            />
                        ) : (
                            <ContactCard
                                contact={contact}
                                fileId={file.id}
                                canWrite={canWrite}
                                onEdit={() => setEditing(contact.id)}
                                onStatus={setStatus}
                            />
                        )}
                    </li>
                ))}
            </ul>
            {canWrite &&
                (editing === 'new' ? (
                    <ContactForm
                        fileId={file.id}
                        current={null}
                        onDone={(s) => {
                            setEditing(null);
                            setStatus(s);
                        }}
                    />
                ) : (
                    <Button variant="secondary" onClick={() => setEditing('new')}>
                        {tf.addContact}
                    </Button>
                ))}
        </div>
    );
}

function ContactCard({
    contact,
    fileId,
    canWrite,
    onEdit,
    onStatus
}: {
    contact: Contact;
    fileId: string;
    canWrite: boolean;
    onEdit: () => void;
    onStatus: (s: Status) => void;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);

    async function remove() {
        try {
            await deleteContact(contact.id);
            await queryClient.invalidateQueries({ queryKey: fileKeys.contacts(fileId) });
            onStatus({ tone: 'success', text: tf.contactDeleted });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <Card className="flex flex-col gap-1">
            <p className="text-muted">{CONTACT_KIND_LABELS[contact.kind]}</p>
            <h2 className="text-xl font-bold">{contact.name}</h2>
            {contact.organization && <p>{contact.organization}</p>}
            {contact.address && <p>{contact.address}</p>}
            {contact.email && <p className="break-all">{contact.email}</p>}
            {contact.notes && <p className="whitespace-pre-line text-muted">{contact.notes}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
                {contact.phone && (
                    <a href={`tel:${dialable(contact.phone)}`} className={buttonClass('primary')} aria-label={tf.call(contact.name)}>
                        {contact.phone}
                    </a>
                )}
                {canWrite && (
                    <>
                        <Button variant="secondary" onClick={onEdit} aria-label={`${tf.editContact} : ${contact.name}`}>
                            {tf.editContact}
                        </Button>
                        <Button
                            variant="secondary"
                            onClick={() => setConfirming(true)}
                            aria-label={`${tf.deleteContact} : ${contact.name}`}
                        >
                            {tf.deleteContact}
                        </Button>
                    </>
                )}
            </div>
            {confirming && (
                <div
                    role="group"
                    aria-label={tf.confirmDeleteContact(contact.name)}
                    className="mt-2 flex flex-col gap-3 rounded-lg bg-urgent-soft p-4"
                >
                    <p className="font-bold">{tf.confirmDeleteContact(contact.name)}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="danger" onClick={() => void remove()}>
                            {tf.deleteContact}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>
                            {tf.cancel}
                        </Button>
                    </div>
                </div>
            )}
        </Card>
    );
}

function ContactForm({ fileId, current, onDone }: { fileId: string; current: Contact | null; onDone: (s: Status) => void }) {
    const queryClient = useQueryClient();
    const [kind, setKind] = useState<Contact['kind']>(current?.kind ?? 'clsc');
    const [name, setName] = useState(current?.name ?? '');
    const [organization, setOrganization] = useState(current?.organization ?? '');
    const [phone, setPhone] = useState(current?.phone ?? '');
    const [email, setEmail] = useState(current?.email ?? '');
    const [address, setAddress] = useState(current?.address ?? '');
    const [notes, setNotes] = useState(current?.notes ?? '');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (name.trim() === '') {
            setError(tf.contactNameError);
            return;
        }
        const input: ContactInput = {
            kind,
            name: name.trim(),
            organization: organization.trim() || null,
            phone: phone.trim() || null,
            email: email.trim() || null,
            address: address.trim() || null,
            notes: notes.trim() || null
        };
        setBusy(true);
        setError(null);
        try {
            if (current) await updateContact(current.id, input);
            else await createContact(fileId, input);
            await queryClient.invalidateQueries({ queryKey: fileKeys.contacts(fileId) });
            onDone({ tone: 'success', text: tf.contactSaved });
        } catch {
            setError(fr.app.genericError);
            setBusy(false);
        }
    }

    return (
        <Card>
            <form
                onSubmit={submit}
                noValidate
                className="flex flex-col gap-4"
                aria-label={current ? `${tf.editContact} : ${current.name}` : tf.addContact}
            >
                <SelectField
                    label={tf.contactKind}
                    value={kind}
                    onChange={(e) => setKind(e.target.value as Contact['kind'])}
                    options={CONTACT_KINDS.map((k) => ({ value: k, label: CONTACT_KIND_LABELS[k] ?? k }))}
                />
                <TextField
                    label={tf.contactName}
                    maxLength={120}
                    value={name}
                    error={error === tf.contactNameError ? error : null}
                    onChange={(e) => setName(e.target.value)}
                />
                <TextField
                    label={tf.contactOrganization}
                    maxLength={120}
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                />
                <TextField
                    label={tf.contactPhone}
                    type="tel"
                    inputMode="tel"
                    maxLength={40}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                />
                <TextField label={tf.contactEmail} type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
                <TextField label={tf.contactAddress} maxLength={240} value={address} onChange={(e) => setAddress(e.target.value)} />
                <FreeTextField label={tf.contactNotes} maxLength={1000} value={notes} onValueChange={setNotes} />
                {error && error !== tf.contactNameError && <Notice tone="error">{error}</Notice>}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy}>
                        {tf.saveContact}
                    </Button>
                    <Button variant="secondary" onClick={() => onDone(null)}>
                        {tf.cancel}
                    </Button>
                </div>
            </form>
        </Card>
    );
}
