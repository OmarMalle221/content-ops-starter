import * as React from 'react';
import { cn } from '@/lib/cn';

export function Table({ className, label, ...props }: React.ComponentProps<'table'> & { label?: string }) {
    // Focusable scroll container so keyboard users can scroll wide tables (WCAG 2.1.1).
    return (
        <div className="w-full overflow-x-auto" role="region" tabIndex={0} aria-label={label ?? 'Tableau'}>
            <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
        </div>
    );
}
export function THead(props: React.ComponentProps<'thead'>) {
    return (
        <thead className="border-b bg-muted/50 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase" {...props} />
    );
}
export function TBody(props: React.ComponentProps<'tbody'>) {
    return <tbody className="divide-y" {...props} />;
}
export function TR({ className, ...props }: React.ComponentProps<'tr'>) {
    return <tr className={cn('transition-colors hover:bg-muted/40', className)} {...props} />;
}
export function TH({ className, ...props }: React.ComponentProps<'th'>) {
    return <th scope="col" className={cn('px-4 py-2.5 font-medium whitespace-nowrap', className)} {...props} />;
}
export function TD({ className, ...props }: React.ComponentProps<'td'>) {
    return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}
