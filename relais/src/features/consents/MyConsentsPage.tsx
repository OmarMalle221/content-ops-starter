import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { queryKeys, useMyConsents } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button, buttonClass, Card, Loading, Notice, PageTitle } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { grantConsent, revokeConsent } from '../../lib/api';
import { activeConsent, CONSENT_TEXTS, type ConsentRecord, type ConsentText } from '../../lib/consents';
import { formatDate } from '../../lib/format';
import { ConsentTextDetails } from './ConsentTextDetails';

export function MyConsentsPage() {
    const consents = useMyConsents();
    const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

    if (consents.isPending) return <Loading />;
    if (consents.isError) return <Notice tone="error">{fr.app.genericError}</Notice>;

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.consents.title}</PageTitle>
            <p>{fr.consents.intro}</p>
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            {CONSENT_TEXTS.map((text) => (
                <ConsentCard key={text.type} text={text} records={consents.data} onStatus={setStatus} />
            ))}
        </div>
    );
}

function ConsentCard({
    text,
    records,
    onStatus
}: {
    text: ConsentText;
    records: ConsentRecord[];
    onStatus: (status: { tone: 'success' | 'error'; text: string }) => void;
}) {
    const { session } = useSession();
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);

    const active = activeConsent(records, text.type);
    const lastRevoked = records.find((r) => r.consent_type === text.type && r.revoked_at !== null);
    const outdated = active !== undefined && active.text_version !== text.version;
    const headingId = `consent-${text.type}`;

    async function run(action: () => Promise<void>, success: string) {
        setBusy(true);
        try {
            await action();
            await queryClient.invalidateQueries({ queryKey: queryKeys.consents(session?.user.id) });
            onStatus({ tone: 'success', text: success });
        } catch {
            onStatus({ tone: 'error', text: fr.app.genericError });
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    }

    return (
        <Card className="flex flex-col gap-3">
            <h2 id={headingId} className="text-xl font-bold">
                {text.title}
            </h2>
            <p className="font-bold">
                {active
                    ? `${fr.consents.grantedOn(formatDate(active.granted_at))} (${fr.consents.versionOf(formatDate(active.text_version))})`
                    : lastRevoked?.revoked_at
                      ? fr.consents.revokedOn(formatDate(lastRevoked.revoked_at))
                      : fr.consents.notGranted}
            </p>
            <p>{text.summary}</p>
            <ConsentTextDetails text={text} />

            {text.type === 'privacy_policy' ? (
                <>
                    <p className="text-muted">{fr.consents.privacyNotRevocable}</p>
                    {outdated && (
                        <>
                            <Notice tone="info">{fr.consents.newVersion}</Notice>
                            <Link to="/bienvenue" className={buttonClass('primary')}>
                                {fr.consents.readAndAccept}
                            </Link>
                        </>
                    )}
                </>
            ) : active && !outdated ? (
                confirming ? (
                    <div
                        role="group"
                        aria-labelledby={`${headingId}-confirm`}
                        className="flex flex-col gap-3 rounded-lg bg-urgent-soft p-4"
                    >
                        <p id={`${headingId}-confirm`} className="font-bold">
                            {fr.consents.confirmRevoke(text.title)}
                        </p>
                        <p>{fr.consents.revokeEffect[text.type]}</p>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="danger"
                                disabled={busy}
                                onClick={() => void run(() => revokeConsent(active.id, text.type), fr.consents.revoked)}
                            >
                                {fr.consents.confirm}
                            </Button>
                            <Button variant="secondary" onClick={() => setConfirming(false)}>
                                {fr.consents.cancel}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Button variant="secondary" onClick={() => setConfirming(true)} aria-describedby={headingId}>
                        {fr.consents.revoke}
                    </Button>
                )
            ) : (
                <Button
                    disabled={busy}
                    onClick={() => void run(() => grantConsent(text.type, text.version), fr.consents.granted)}
                    aria-describedby={headingId}
                >
                    {outdated ? fr.consents.readAndAccept : fr.consents.grant}
                </Button>
            )}
        </Card>
    );
}
