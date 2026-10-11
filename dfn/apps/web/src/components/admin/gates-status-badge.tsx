import { Badge } from '@dfn/ui';

/** Badge variants of the regulatory gate statuses (kept local: lib/format.ts is shared). */
const STATUS_VARIANT: Record<string, 'muted' | 'default' | 'warning' | 'success' | 'destructive'> = {
  NOT_STARTED: 'muted',
  IN_PROGRESS: 'default',
  PENDING_SECOND_APPROVAL: 'warning',
  SATISFIED: 'success',
  REVOKED: 'destructive',
};

const LEVEL_VARIANT: Record<string, 'secondary' | 'warning' | 'destructive'> = {
  STRONG: 'secondary',
  BLOCKING: 'warning',
  ABSOLUTE: 'destructive',
};

type T = (path: string) => string;

function label(t: T, path: string, fallback: string) {
  const v = t(path);
  return v === path ? fallback : v;
}

export function GateStatusBadge({ status, t }: { status: string; t: T }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'outline'}>
      {label(t, `gatesAdmin.statuses.${status}`, status)}
    </Badge>
  );
}

export function GateLevelBadge({ level, t }: { level: string; t: T }) {
  return (
    <Badge variant={LEVEL_VARIANT[level] ?? 'outline'}>{label(t, `gatesAdmin.levels.${level}`, level)}</Badge>
  );
}
