'use client';
import { createContext, useContext, type ReactNode } from 'react';
import { dictionaries, translate, type Dictionary, type Locale } from './i18n';

const Ctx = createContext<{ locale: Locale; dict: Dictionary }>({ locale: 'fr', dict: dictionaries.fr });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <Ctx.Provider value={{ locale, dict: dictionaries[locale] }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const { locale, dict } = useContext(Ctx);
  return { locale, dict, t: (path: string) => translate(dict, path) };
}
