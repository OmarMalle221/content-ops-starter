import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, dictionaries, isLocale, translate, type Locale } from './i18n';

export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const v = store.get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export async function getT() {
  const locale = await getLocale();
  const dict = dictionaries[locale];
  return { locale, dict, t: (path: string) => translate(dict, path) };
}
