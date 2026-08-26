/**
 * i18n Type Definitions
 */

import type { en } from './locales/en';

/** Flat key-value string map */
export type Translations = Record<string, string>;

/**
 * Union of every key in the en reference table. Locale files declare
 * themselves as Record<TranslationKey, string>, so a missing or extra key
 * is a compile error (key parity at build time).
 */
export type TranslationKey = keyof typeof en;
