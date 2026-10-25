import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Button, Card, Loading, Notice, PageTitle, RadioGroup, SelectField, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { ACCESS_DESCRIPTIONS, ACCESS_LABELS, files as tf, ROLE_LABELS } from '../../i18n/files.fr';
import { ApiError } from '../../lib/api';
import {
    createInvitation,
    invitationLink,
    removeMember,
    revokeInvitation,
    updateMemberAccess,
    type AccessLevel,
    type MemberRole
} from '../../lib/careFiles';
import { formatDate } from '../../lib/format';
import { useFileContext } from './FileLayout';
import { fileKeys, useInvitations, useMembers } from './useFile';

type Status = { tone: 'success' | 'error'; text: string } | null;
const LEVELS: AccessLevel[] = ['full', 'coordination', 'read_only'];

export function FileMembersPage() {
    const { file, access } = useFileContext();
    const { session } = useSession();
    const members = useMembers(file.id);
    const isOwner = access.membership?.access_level === 'owner';
    const [status, setStatus] = useState<Status>(null);

    if (members.isPending) return <Loading />;

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.membersTitle}</PageTitle>
            <p>{tf.membersIntro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <ul className="flex list-none flex-col gap-3 p-0">
                {(members.data ?? []).map((member) => (
                    <li key={member.user_id}>
                        <MemberCard
                            fileId={file.id}
                            member={member}
                            isSelf={member.user_id === session?.user.id}
                            canManage={isOwner && member.access_level !== 'owner'}
                            onStatus={setStatus}
                        />
                    </li>
                ))}
            </ul>
            {isOwner && <InviteSection fileId={file.id} />}
            {!isOwner && <LeaveSection fileId={file.id} />}
        </div>
    );
}

function MemberCard({
    fileId,
    member,
    isSelf,
    canManage,
    onStatus
}: {
    fileId: string;
    member: { user_id: string; display_name: string | null; role: MemberRole; access_level: AccessLevel };
    isSelf: boolean;
    canManage: boolean;
    onStatus: (s: Status) => void;
}) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const name = member.display_name ?? tf.unnamed;

    async function run(action: () => Promise<void>, success: string) {
        try {
            await action();
            await queryClient.invalidateQueries({ queryKey: fileKeys.members(fileId) });
            onStatus({ tone: 'success', text: success });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <Card className="flex flex-col gap-2">
            <h2 className="text-xl font-bold">
                {name}
                {isSelf && <span className="font-normal text-muted"> ({tf.you})</span>}
            </h2>
            <p>
                {ROLE_LABELS[member.role]} — {ACCESS_LABELS[member.access_level]}
            </p>
            {canManage && member.role !== 'care_recipient' && (
                <SelectField
                    label={tf.changeLevel(name)}
                    value={member.access_level}
                    onChange={(e) =>
                        void run(() => updateMemberAccess(fileId, member.user_id, e.target.value as AccessLevel), tf.levelChanged)
                    }
                    options={LEVELS.map((level) => ({ value: level, label: ACCESS_LABELS[level] ?? level }))}
                />
            )}
            {canManage &&
                (confirming ? (
                    <div role="group" aria-label={tf.confirmRemove(name)} className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
                        <p className="font-bold">{tf.confirmRemove(name)}</p>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="danger" onClick={() => void run(() => removeMember(fileId, member.user_id), tf.removed)}>
                                {tf.removeMember}
                            </Button>
                            <Button variant="secondary" onClick={() => setConfirming(false)}>
                                {tf.cancel}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button variant="secondary" onClick={() => setConfirming(true)} aria-label={`${tf.removeMember} : ${name}`}>
                        {tf.removeMember}
                    </Button>
                ))}
        </Card>
    );
}

type InviteKind = 'family' | 'recipient' | 'worker';
const INVITE_ROLE: Record<InviteKind, MemberRole> = { family: 'family_member', recipient: 'care_recipient', worker: 'relais_worker' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function InviteSection({ fileId }: { fileId: string }) {
    const queryClient = useQueryClient();
    const invitations = useInvitations(fileId, true);
    const [email, setEmail] = useState('');
    const [kind, setKind] = useState<InviteKind>('family');
    const [level, setLevel] = useState<AccessLevel>('full');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState<{ url: string; email: string } | null>(null);
    const [copied, setCopied] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const address = email.trim().toLowerCase();
        if (!EMAIL.test(address)) {
            setError(tf.emailError);
            return;
        }
        setBusy(true);
        setError(null);
        setLink(null);
        setCopied(false);
        try {
            const token = await createInvitation(fileId, address, INVITE_ROLE[kind], kind === 'recipient' ? 'read_only' : level);
            setLink({ url: invitationLink(window.location.origin, token), email: address });
            setEmail('');
            await queryClient.invalidateQueries({ queryKey: fileKeys.invitations(fileId) });
        } catch (e) {
            setError(e instanceof ApiError && e.code === '23505' ? tf.alreadyMember : fr.app.genericError);
        } finally {
            setBusy(false);
        }
    }

    async function share() {
        if (!link) return;
        try {
            await navigator.share({ title: 'Relais', text: tf.invitationIntro, url: link.url });
        } catch {
            // Partage annulé ou non pris en charge : le bouton « Copier » reste disponible.
        }
    }

    async function copy() {
        if (!link) return;
        try {
            await navigator.clipboard.writeText(link.url);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    const pending = (invitations.data ?? []).filter((i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date());

    return (
        <section aria-labelledby="invite-title" className="flex flex-col gap-4">
            <h2 id="invite-title" className="text-2xl font-bold">
                {tf.inviteTitle}
            </h2>
            <form onSubmit={submit} noValidate className="flex flex-col gap-4">
                <TextField
                    label={tf.inviteEmail}
                    hint={tf.inviteEmailHint}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    value={email}
                    error={error === tf.emailError ? error : null}
                    onChange={(e) => setEmail(e.target.value)}
                />
                <RadioGroup
                    legend={tf.inviteWho}
                    name="invite-kind"
                    value={kind}
                    onChange={setKind}
                    options={[
                        { value: 'family', label: tf.inviteFamily },
                        { value: 'recipient', label: tf.inviteRecipient },
                        { value: 'worker', label: tf.inviteWorker }
                    ]}
                />
                {kind !== 'recipient' && (
                    <RadioGroup
                        legend={tf.inviteLevel}
                        name="invite-level"
                        value={level}
                        onChange={setLevel}
                        options={LEVELS.map((value) => ({
                            value,
                            label: ACCESS_LABELS[value] ?? value,
                            description: ACCESS_DESCRIPTIONS[value]
                        }))}
                    />
                )}
                {error && error !== tf.emailError && <Notice tone="error">{error}</Notice>}
                <Button type="submit" disabled={busy}>
                    {tf.createInvitation}
                </Button>
            </form>

            {link && (
                <Notice tone="success">
                    <p>{tf.invitationReady(link.email)}</p>
                    <label htmlFor="invitation-link" className="mt-3 block font-bold">
                        {tf.invitationLink}
                    </label>
                    <input
                        id="invitation-link"
                        readOnly
                        value={link.url}
                        onFocus={(e) => e.currentTarget.select()}
                        className="mt-1 min-h-12 w-full rounded-lg border-2 border-muted bg-surface px-3"
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                        {'share' in navigator && <Button onClick={() => void share()}>{tf.share}</Button>}
                        <Button variant="secondary" onClick={() => void copy()}>
                            {tf.copy}
                        </Button>
                    </div>
                    {copied && <p className="mt-2 font-bold">{tf.copied}</p>}
                </Notice>
            )}

            <h3 className="text-xl font-bold">{tf.pending}</h3>
            {pending.length === 0 ? (
                <p className="text-muted">{tf.noPending}</p>
            ) : (
                <ul className="flex list-none flex-col gap-2 p-0">
                    {pending.map((invitation) => (
                        <li key={invitation.id}>
                            <Card className="flex flex-col gap-2">
                                <p className="break-all font-bold">{invitation.email}</p>
                                <p>
                                    {ROLE_LABELS[invitation.role]} — {ACCESS_LABELS[invitation.access_level]} —{' '}
                                    {tf.expiresOn(formatDate(invitation.expires_at))}
                                </p>
                                <Button
                                    variant="secondary"
                                    aria-label={`${tf.revokeInvitation} : ${invitation.email}`}
                                    onClick={() =>
                                        void revokeInvitation(invitation.id).then(() =>
                                            queryClient.invalidateQueries({ queryKey: fileKeys.invitations(fileId) })
                                        )
                                    }
                                >
                                    {tf.revokeInvitation}
                                </Button>
                            </Card>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function LeaveSection({ fileId }: { fileId: string }) {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [confirming, setConfirming] = useState(false);
    const [failed, setFailed] = useState(false);

    async function leave() {
        if (!session) return;
        try {
            await removeMember(fileId, session.user.id);
            await queryClient.invalidateQueries({ queryKey: fileKeys.myFiles(session.user.id) });
            navigate('/accueil', { replace: true });
        } catch {
            setFailed(true);
        }
    }

    return (
        <section className="flex flex-col gap-3">
            {failed && <Notice tone="error">{fr.app.genericError}</Notice>}
            {confirming ? (
                <div role="group" aria-label={tf.confirmLeave} className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4">
                    <p className="font-bold">{tf.confirmLeave}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="danger" onClick={() => void leave()}>
                            {tf.leave}
                        </Button>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>
                            {tf.cancel}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button variant="secondary" onClick={() => setConfirming(true)}>
                    {tf.leave}
                </Button>
            )}
        </section>
    );
}
