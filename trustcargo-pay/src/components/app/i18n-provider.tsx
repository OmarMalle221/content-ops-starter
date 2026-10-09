'use client';
import * as React from 'react';
import type { Locale } from '@/domain/model';
import { INTL_LOCALE, makeTranslator, type Translator } from '@/i18n';
import type { Dictionary } from '@/i18n/fr';

interface I18nValue {
    locale: Locale;
    intl: string;
    dict: Dictionary;
    t: Translator;
}

const Ctx = React.createContext<I18nValue | null>(null);

export function I18nProvider({ locale, dict, children }: { locale: Locale; dict: Dictionary; children: React.ReactNode }) {
    const value = React.useMemo(() => ({ locale, intl: INTL_LOCALE[locale], dict, t: makeTranslator(dict) }), [locale, dict]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
    const v = React.useContext(Ctx);
    if (!v) throw new Error('useI18n outside I18nProvider');
    return v;
}
