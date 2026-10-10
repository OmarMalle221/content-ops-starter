import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const buttonVariants = cva(
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 [&_svg]:size-4 [&_svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90',
                secondary: 'border bg-card text-foreground shadow-xs hover:bg-muted',
                ghost: 'text-foreground hover:bg-muted',
                destructive: 'bg-danger text-white shadow-sm hover:bg-danger/90',
                success: 'bg-success text-white shadow-sm hover:bg-success/90',
                link: 'text-primary underline-offset-4 hover:underline'
            },
            size: {
                default: 'h-9 px-4',
                sm: 'h-8 px-3 text-xs',
                lg: 'h-11 px-6 text-base',
                icon: 'size-9'
            }
        },
        defaultVariants: { variant: 'default', size: 'default' }
    }
);

export function Button({
    className,
    variant,
    size,
    asChild = false,
    ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
