import 'server-only';
import { cookies } from 'next/headers';
import type { Locale } from '@/domain/model';
import { DICTIONARIES, INTL_LOCALE, LOCALE_COOKIE, makeTranslator } from '.';

export async function getLocale(): Promise<Locale> {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    return value === 'en' ? 'en' : 'fr';
}

export async function getI18n() {
    const locale = await getLocale();
    const dict = DICTIONARIES[locale];
    return { locale, dict, t: makeTranslator(dict), intl: INTL_LOCALE[locale] };
}
