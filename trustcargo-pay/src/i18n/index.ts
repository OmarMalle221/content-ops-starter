import { en } from './en';
import { fr, type Dictionary } from './fr';
import type { Locale } from '@/domain/model';

export const DICTIONARIES: Record<Locale, Dictionary> = { fr, en };
export const LOCALE_COOKIE = 'tc_locale';
export const INTL_LOCALE: Record<Locale, string> = { fr: 'fr-CA', en: 'en-CA' };

type Leaves<T, P extends string = ''> = T extends string
    ? P
    : T extends readonly unknown[]
      ? P
      : { [K in keyof T & string]: Leaves<T[K], P extends '' ? K : `${P}.${K}`> }[keyof T & string];
export type TKey = Leaves<Dictionary>;

export function lookup(dict: Dictionary, key: string): unknown {
    return key
        .split('.')
        .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

export type Translator = (key: TKey | (string & {}), params?: Record<string, string | number>) => string;

export function makeTranslator(dict: Dictionary): Translator {
    return (key, params) => {
        const value = lookup(dict, key);
        return typeof value === 'string' ? interpolate(value, params) : key;
    };
}
