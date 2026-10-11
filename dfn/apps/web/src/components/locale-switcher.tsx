'use client';
import { useRouter } from 'next/navigation';
import { Globe } from 'lucide-react';
import { Button } from '@dfn/ui';
import { LOCALE_COOKIE } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n-client';

export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale } = useI18n();
  const router = useRouter();
  const next = locale === 'fr' ? 'en' : 'fr';
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      aria-label={next === 'fr' ? 'Passer en français' : 'Switch to English'}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      <Globe /> {next.toUpperCase()}
    </Button>
  );
}
