import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/cn';

const tones = {
    info: { cls: 'border-info/20 bg-info-soft text-info', Icon: Info },
    success: { cls: 'border-success/20 bg-success-soft text-success', Icon: CheckCircle2 },
    warning: { cls: 'border-warning/25 bg-warning-soft text-warning', Icon: AlertTriangle },
    danger: { cls: 'border-danger/20 bg-danger-soft text-danger', Icon: ShieldAlert }
};

export function Alert({
    tone = 'info',
    title,
    children,
    className,
    role
}: {
    tone?: keyof typeof tones;
    title?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    role?: string;
}) {
    const { cls, Icon } = tones[tone];
    return (
        <div
            className={cn('flex gap-3 rounded-md border px-4 py-3 text-sm', cls, className)}
            role={role ?? (tone === 'danger' ? 'alert' : 'status')}
        >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 space-y-1">
                {title && <p className="font-medium">{title}</p>}
                {children && <div className="text-foreground/80">{children}</div>}
            </div>
        </div>
    );
}
