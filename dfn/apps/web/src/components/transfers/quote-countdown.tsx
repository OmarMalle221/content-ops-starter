'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@dfn/ui';
import { useI18n } from '@/lib/i18n-client';

/**
 * Remaining validity of a quote. The clock only runs inside useEffect so the server render and
 * the first client render are identical (no Date.now() during render).
 */
export function QuoteCountdown({ expiresAt, onExpire }: { expiresAt: string; onExpire?: () => void }) {
  const { t } = useI18n();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const firedRef = useRef(false);
  useEffect(() => {
    firedRef.current = false;
    const target = new Date(expiresAt).getTime();
    const tick = () => {
      const ms = target - Date.now();
      setRemainingMs(ms);
      if (ms <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, onExpire]);

  if (remainingMs === null) {
    return <Badge variant="outline">{t('xfer.expiresIn')} …</Badge>;
  }
  if (remainingMs <= 0) {
    return <Badge variant="destructive">{t('status.EXPIRED')}</Badge>;
  }
  const total = Math.floor(remainingMs / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return (
    <Badge variant={remainingMs < 60_000 ? 'warning' : 'outline'} className="tabular-nums">
      {t('xfer.expiresIn')} {mm}:{ss}
    </Badge>
  );
}
