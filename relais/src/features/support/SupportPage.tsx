import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useHelpResources } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { support as ts } from '../../i18n/support.fr';
import { formatDate } from '../../lib/format';
import { cancelSupportRequest, type SupportOrigin } from '../../lib/support';
import { HelpResourceList } from '../help/HelpResourceList';
import { SupportRequestForm } from './SupportRequestForm';
import { supportKeys, useMySupportRequests } from './useSupport';

const ORIGIN_PARAM: Record<string, SupportOrigin> = { detresse: 'distress_screen', bilan: 'checkin' };

/** « Parler à une intervenante » : rappel des urgences (table des ressources), demande, mes demandes. */
export function SupportPage() {
    const [params] = useSearchParams();
    const origin = ORIGIN_PARAM[params.get('origine') ?? ''] ?? 'button';
    const resources = useHelpResources();
    const requests = useMySupportRequests();
    const queryClient = useQueryClient();
    const { session } = useSession();
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    async function cancel(id: string) {
        try {
            await cancelSupportRequest(id);
            await queryClient.invalidateQueries({ queryKey: supportKeys.myRequests(session?.user.id) });
            setStatus({ tone: 'success', text: ts.cancelled });
        } catch {
            setStatus({ tone: 'error', text: fr.app.genericError });
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{ts.requestTitle}</PageTitle>
            <p>{ts.requestIntro}</p>
            <p>{ts.requestNoDelay}</p>
            <section aria-labelledby="urgent-title" className="flex flex-col gap-2">
                <h2 id="urgent-title" className="font-bold">
                    {ts.notEmergency}
                </h2>
                <HelpResourceList resources={resources} categories={['emergency', 'crisis_line']} headingLevel="h3" />
            </section>
            <Card>
                <SupportRequestForm origin={origin} />
            </Card>
            <section aria-labelledby="my-requests-title" className="flex flex-col gap-3">
                <h2 id="my-requests-title" className="text-2xl font-bold">
                    {ts.myRequests}
                </h2>
                {status && <Notice tone={status.tone}>{status.text}</Notice>}
                {requests.isPending ? (
                    <Loading />
                ) : (requests.data ?? []).length === 0 ? (
                    <p className="text-muted">{ts.noRequests}</p>
                ) : (
                    <ul className="flex list-none flex-col gap-3 p-0">
                        {(requests.data ?? []).map((r) => (
                            <li key={r.id}>
                                <Card className="flex flex-col gap-2">
                                    <p className="font-bold">{ts.sentOn(formatDate(r.created_at))}</p>
                                    <p>{ts.statusLabels[r.status]}</p>
                                    {r.status !== 'closed' && (
                                        <Button
                                            variant="secondary"
                                            className="self-start"
                                            aria-label={`${ts.cancel} : ${ts.sentOn(formatDate(r.created_at)).toLowerCase()}`}
                                            onClick={() => void cancel(r.id)}
                                        >
                                            {ts.cancel}
                                        </Button>
                                    )}
                                </Card>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
