import { en } from './en';
import { zh } from './zh';
import { ru } from './ru';

export type Locale = 'en' | 'zh' | 'ru';

const locales: Record<Locale, Record<string, string>> = { en, zh, ru };

export const SUPPORTED_LOCALES: Locale[] = ['en', 'zh', 'ru'];

export const LOCALE_LABELS: Record<Locale, string> = {
  en: '🇬🇧 English',
  zh: '🇨🇳 中文',
  ru: '🇷🇺 Русский',
};

/**
 * Translate a key to the given locale, with optional variable interpolation.
 * Falls back to English if the key is missing in the target locale.
 * Falls back to the raw key if not found in any locale.
 */
export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let text = locales[locale]?.[key] ?? locales.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return text;
}

/** Check if a locale string is valid */
export function isValidLocale(s: string): s is Locale {
  return SUPPORTED_LOCALES.includes(s as Locale);
}
