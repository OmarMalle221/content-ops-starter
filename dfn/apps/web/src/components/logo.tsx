import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

export function Logo({ href = '/', compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <ShieldCheck className="size-5" aria-hidden />
      </span>
      {!compact ? (
        <span>
          Diaspora <span className="text-primary">Trust</span>
        </span>
      ) : null}
    </Link>
  );
}
