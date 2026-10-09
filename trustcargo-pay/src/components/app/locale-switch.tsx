import { Languages } from 'lucide-react';
import { setLocale } from '@/app/actions/auth';
import { cn } from '@/lib/cn';

export function LocaleSwitch({ locale, label, back, className }: { locale: 'fr' | 'en'; label: string; back: string; className?: string }) {
    return (
        <form action={setLocale}>
            <input type="hidden" name="locale" value={locale === 'fr' ? 'en' : 'fr'} />
            <input type="hidden" name="back" value={back} />
            <button
                type="submit"
                className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-muted', className)}
                lang={locale === 'fr' ? 'en' : 'fr'}
            >
                <Languages className="size-4" aria-hidden />
                {label}
            </button>
        </form>
    );
}
