import { useSession } from '../../app/session';
import { Loading, PageTitle } from '../../components/ui';
import { ACTION_LABELS, files as tf } from '../../i18n/files.fr';
import { OwnerOnly, useFileContext } from './FileLayout';
import { useAccessLog, useMembers } from './useFile';

const timeFormat = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto' });

/** Journal des accès du dossier, visible par la personne aidante principale. */
export function FileLogPage() {
    return (
        <OwnerOnly>
            <FileLogPageContent />
        </OwnerOnly>
    );
}

function FileLogPageContent() {
    const { file } = useFileContext();
    const { session } = useSession();
    const log = useAccessLog(file.id, true);
    const members = useMembers(file.id);
    if (log.isPending || members.isPending) return <Loading />;

    const names = new Map((members.data ?? []).map((m) => [m.user_id, m.display_name]));
    const who = (actorId: string | null) => (actorId === session?.user.id ? tf.you : (actorId && names.get(actorId)) || tf.formerMember);

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.logTitle}</PageTitle>
            <p>{tf.logIntro}</p>
            {(log.data ?? []).length === 0 ? (
                <p className="text-muted">{tf.logEmpty}</p>
            ) : (
                <ol className="flex list-none flex-col gap-2 p-0">
                    {(log.data ?? []).map((entry) => (
                        <li key={entry.id} className="rounded-lg border border-line bg-surface p-3">
                            <p className="text-muted">
                                <time dateTime={entry.occurred_at}>{timeFormat.format(new Date(entry.occurred_at))}</time>
                            </p>
                            <p>
                                <span className="font-bold">{who(entry.actor_id)}</span> {ACTION_LABELS[entry.action] ?? entry.action}
                            </p>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}
