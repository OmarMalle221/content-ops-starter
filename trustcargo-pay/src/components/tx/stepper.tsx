import { Check } from 'lucide-react';
import { HAPPY_PATH } from '@/domain/transaction/state-machine';
import type { TransactionStatus } from '@/domain/model';
import { cn } from '@/lib/cn';

const DISPLAY: TransactionStatus[] = [
    'AWAITING_PARTIES',
    'IDENTITY_VERIFICATION',
    'AWAITING_AGREEMENT',
    'AWAITING_FUNDING',
    'IN_PROGRESS',
    'COMPLETED'
];

/** Progress along the happy path; exceptional states (dispute, refund, cancel) are shown by the status badge. */
export function TransactionStepper({ status, labels }: { status: TransactionStatus; labels: Record<string, string> }) {
    const normalized: TransactionStatus =
        status === 'FUNDING_PENDING'
            ? 'AWAITING_FUNDING'
            : status === 'FUNDS_CONFIRMED' || status === 'MILESTONE_REVIEW' || status === 'DISPUTED'
              ? 'IN_PROGRESS'
              : status;
    const current = HAPPY_PATH.indexOf(normalized);
    return (
        <ol className="flex w-full items-center gap-1 overflow-x-auto pb-1" aria-label="Progression">
            {DISPLAY.map((s, i) => {
                const idx = HAPPY_PATH.indexOf(s);
                const done = current > idx || status === 'COMPLETED';
                const active = normalized === s && status !== 'COMPLETED';
                return (
                    <li key={s} className="flex min-w-0 flex-1 items-center gap-1" aria-current={active ? 'step' : undefined}>
                        <span
                            className={cn(
                                'grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold',
                                done && 'border-success bg-success text-white',
                                active && 'border-primary bg-primary text-primary-foreground',
                                !done && !active && 'bg-card text-muted-foreground'
                            )}
                        >
                            {done ? <Check className="size-3.5" aria-hidden /> : i + 1}
                        </span>
                        <span
                            className={cn(
                                'truncate text-xs',
                                active ? 'font-semibold text-foreground' : 'hidden text-muted-foreground sm:inline'
                            )}
                        >
                            {labels[s]}
                        </span>
                        {i < DISPLAY.length - 1 && (
                            <span
                                className={cn('mx-1 hidden h-px min-w-4 flex-1 sm:block', done ? 'bg-success' : 'bg-border')}
                                aria-hidden
                            />
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
