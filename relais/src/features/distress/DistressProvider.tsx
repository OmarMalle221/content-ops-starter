import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useHelpResources } from '../../app/queries';
import { useSession } from '../../app/session';
import { Button } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { support as ts } from '../../i18n/support.fr';
import type { Resource } from '../../lib/api';
import { logEvent } from '../../lib/log';
import type { DistressResult } from '../../shared/distress/detect';
import { HelpResourceList } from '../help/HelpResourceList';
import { SupportRequestForm } from '../support/SupportRequestForm';

interface DistressContextValue {
    /** Affiche immédiatement l'écran de ressources d'urgence pour ce résultat de détection. */
    report: (result: DistressResult) => void;
}

const DistressContext = createContext<DistressContextValue>({ report: () => undefined });

export function useDistress(): DistressContextValue {
    return useContext(DistressContext);
}

type Category = Resource['category'];

/** Ordre des ressources selon la situation : le 911 d'abord en cas de danger, le 9-8-8 pour les idées suicidaires. */
export function presentation(result: DistressResult): { heading: string; order: Category[] } {
    const onlySuicide = result.categories.every((c) => c === 'suicide' || c === 'caregiver_crisis');
    if (result.categories.includes('suicide') && onlySuicide) {
        return { heading: fr.distress.headingSuicide, order: ['crisis_line', 'emergency', 'psychosocial_line'] };
    }
    if (result.level === 'danger') {
        return { heading: fr.distress.headingDanger, order: ['emergency', 'crisis_line', 'psychosocial_line'] };
    }
    return { heading: fr.distress.headingCrisis, order: ['psychosocial_line', 'crisis_line', 'emergency'] };
}

export function DistressProvider({ children }: { children: ReactNode }) {
    const [result, setResult] = useState<DistressResult | null>(null);
    const report = useCallback((next: DistressResult) => {
        if (next.level === 'none') return;
        logEvent('distress_screen_shown', { level: next.level, count: next.categories.length });
        setResult(next);
    }, []);

    return (
        <DistressContext.Provider value={{ report }}>
            {children}
            {result && <DistressDialog result={result} onClose={() => setResult(null)} />}
        </DistressContext.Provider>
    );
}

/** Navigateurs sans <dialog> modal (anciens iPhone) : l'écran s'affiche quand même, en plein écran fixe. */
function supportsModalDialog(): boolean {
    return typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function';
}

/** Règle no 2 : proposer une intervenante, sans quitter l'écran (la saisie en cours n'est pas perdue). */
function WorkerCallback() {
    const [asking, setAsking] = useState(false);
    return (
        <section aria-labelledby="distress-worker" className="flex flex-col gap-3 rounded-xl border-2 border-line bg-surface p-4">
            <h3 id="distress-worker" className="text-xl font-bold">
                {ts.distressTitle}
            </h3>
            {asking ? (
                <SupportRequestForm origin="distress_screen" compact />
            ) : (
                <Button variant="secondary" className="self-start" onClick={() => setAsking(true)}>
                    {ts.distressAsk}
                </Button>
            )}
        </section>
    );
}

function DistressDialog({ result, onClose }: { result: DistressResult; onClose: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const { session } = useSession();
    const resources = useHelpResources();
    const { heading, order } = presentation(result);
    const [modal] = useState(supportsModalDialog);

    useEffect(() => {
        const dialog = ref.current;
        // Le focus revient au champ d'origine à la fermeture : la saisie n'est jamais perdue.
        const previous = document.activeElement as HTMLElement | null;
        if (dialog && modal && !dialog.open) dialog.showModal();
        // Le titre reçoit le focus : il est lu en premier, avant les numéros à appeler.
        dialog?.querySelector<HTMLElement>('#distress-heading')?.focus();
        return () => previous?.focus?.();
    }, [modal]);

    return (
        <dialog
            ref={ref}
            open={modal ? undefined : true}
            aria-modal={modal ? undefined : true}
            aria-labelledby="distress-heading"
            aria-describedby="distress-body"
            onCancel={(event) => {
                event.preventDefault();
                onClose();
            }}
            className={`m-0 h-full max-h-none w-full max-w-none overflow-y-auto bg-canvas p-0 text-ink backdrop:bg-ink/60 sm:m-auto sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl ${modal ? '' : 'fixed inset-0 z-50'}`}
        >
            <div className="flex flex-col gap-4 p-5">
                <h2 id="distress-heading" tabIndex={-1} className="text-2xl font-bold text-urgent-strong focus:outline-none">
                    {heading}
                </h2>
                <p id="distress-body">{fr.distress.body}</p>
                <HelpResourceList resources={resources} categories={order} headingLevel="h3" />
                {session && <WorkerCallback />}
                <p className="text-muted">{fr.distress.notEmergency}</p>
                <Button variant="secondary" onClick={onClose}>
                    {fr.distress.close}
                </Button>
            </div>
        </dialog>
    );
}
