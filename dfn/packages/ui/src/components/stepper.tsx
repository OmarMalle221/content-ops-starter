import { Check } from 'lucide-react';
import { cn } from '../lib/cn';

export interface Step {
  key: string;
  label: string;
  description?: string;
  state: 'done' | 'current' | 'upcoming' | 'blocked';
}

export function Stepper({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={cn(
            'flex items-start gap-3 rounded-lg border p-3',
            s.state === 'current' && 'border-primary bg-primary/5',
            s.state === 'blocked' && 'border-destructive/50 bg-destructive/5',
          )}
        >
          <span
            className={cn(
              'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              s.state === 'done' && 'border-success bg-success text-success-foreground',
              s.state === 'current' && 'border-primary bg-primary text-primary-foreground',
              s.state === 'upcoming' && 'border-border text-muted-foreground',
              s.state === 'blocked' && 'border-destructive bg-destructive text-destructive-foreground',
            )}
            aria-hidden
          >
            {s.state === 'done' ? <Check className="size-3.5" /> : i + 1}
          </span>
          <div className="min-w-0">
            <p
              className={cn(
                'text-sm font-medium leading-tight',
                s.state === 'upcoming' && 'text-muted-foreground',
              )}
            >
              {s.label}
            </p>
            {s.description ? <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
