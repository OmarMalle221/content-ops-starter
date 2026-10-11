import * as React from 'react';
import { cn } from '../lib/cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed p-10 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-3 text-muted-foreground [&_svg]:size-8">{icon}</div> : null}
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
