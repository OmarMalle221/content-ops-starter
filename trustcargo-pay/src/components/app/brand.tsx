import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Brand({ className, inverted = false }: { className?: string; inverted?: boolean }) {
    return (
        <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
            <span
                className={cn(
                    'grid size-7 place-items-center rounded-md',
                    inverted ? 'bg-white/10 text-white' : 'bg-primary text-primary-foreground'
                )}
            >
                <ShieldCheck className="size-4" aria-hidden />
            </span>
            <span>
                TrustCargo<span className={inverted ? 'text-white/60' : 'text-primary'}> Pay</span>
            </span>
        </span>
    );
}
