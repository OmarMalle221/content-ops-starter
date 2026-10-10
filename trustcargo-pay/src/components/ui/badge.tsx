import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const badgeVariants = cva(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
    {
        variants: {
            tone: {
                neutral: 'border-border bg-muted text-muted-foreground',
                primary: 'border-transparent bg-primary-soft text-primary',
                success: 'border-transparent bg-success-soft text-success',
                warning: 'border-transparent bg-warning-soft text-warning',
                danger: 'border-transparent bg-danger-soft text-danger',
                info: 'border-transparent bg-info-soft text-info'
            }
        },
        defaultVariants: { tone: 'neutral' }
    }
);

export function Badge({ className, tone, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
    return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
