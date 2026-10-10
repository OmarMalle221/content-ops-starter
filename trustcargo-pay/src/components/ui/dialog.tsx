'use client';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
    className,
    children,
    title,
    description,
    closeLabel = 'Fermer'
}: {
    className?: string;
    children: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    closeLabel?: string;
}) {
    return (
        <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[2px]" />
            <D.Content
                className={cn(
                    'fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card p-6 shadow-xl',
                    className
                )}
            >
                <div className="mb-4 space-y-1 pr-6">
                    <D.Title className="text-base font-semibold">{title}</D.Title>
                    {description ? (
                        <D.Description className="text-sm text-muted-foreground">{description}</D.Description>
                    ) : (
                        <D.Description className="sr-only">{title}</D.Description>
                    )}
                </div>
                {children}
                <D.Close className="absolute top-4 right-4 rounded-sm p-1 text-muted-foreground hover:bg-muted" aria-label={closeLabel}>
                    <X className="size-4" />
                </D.Close>
            </D.Content>
        </D.Portal>
    );
}
