/**
 * Lightweight string module for Obsidian Agent.
 *
 * The active locale follows the Obsidian app language (getLanguage) with no
 * plugin-side language setting. English is bundled into main.js and is the
 * lookup fallback. Chinese (simplified + traditional) is also bundled.
 * 2026-08-27: the six on-demand language packs (de/ja/ko/es/fr/ru) are
 * paused -- the pack files remain in locales/packs/ but those locales now
 * resolve to 'en' and no pack is ever fetched. To re-enable, re-add the
 * locales to SUPPORTED_LOCALES and LOCALE_LABELS.
 *
 * Lookup chain: active locale table -> en -> raw key.
 */

import { getLanguage } from 'obsidian';
import type { Translations } from './types';
import { en } from './locales/en';
import zh from './locales/packs/zh.json';
import zhTW from './locales/packs/zh-tw.json';

export const SUPPORTED_LOCALES = ['en', 'zh', 'zh-TW'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Map an Obsidian language code to a shipped locale: exact match first
 * ('zh-TW'), then base language ('zh-HK' -> 'zh'), otherwise 'en'.
 */
export function resolveLocale(obsidianLang: string): SupportedLocale {
    if ((SUPPORTED_LOCALES as readonly string[]).includes(obsidianLang)) {
        return obsidianLang as SupportedLocale;
    }
    const base = obsidianLang.split('-')[0];
    if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) {
        return base as SupportedLocale;
    }
    return 'en';
}

/** Filename of the language pack asset for a non-English locale. */
export function localePackFilename(locale: SupportedLocale): string {
    return `locale-${locale.toLowerCase()}.json`;
}

/**
 * Null-prototype snapshots of bundled translation tables (audit I-2, defense in depth).
 */
const EN_TABLE: Translations = Object.assign(Object.create(null) as Translations, en);
const ZH_TABLE: Translations = Object.assign(Object.create(null) as Translations, EN_TABLE, zh);
const ZH_TW_TABLE: Translations = Object.assign(Object.create(null) as Translations, EN_TABLE, zhTW);

let active: Translations = EN_TABLE;
let activeLocale: SupportedLocale = 'en';

/**
 * Resolve the active locale from the Obsidian app language.
 * Bundled languages (en, zh, zh-TW) resolve synchronously to their tables.
 */
export function initI18n(): void {
    let lang = 'en';
    try {
        lang = getLanguage();
    } catch {
        // Test stubs or very early load paths without a full obsidian module.
    }
    activeLocale = resolveLocale(lang);
    if (activeLocale === 'zh') {
        active = ZH_TABLE;
    } else if (activeLocale === 'zh-TW') {
        active = ZH_TW_TABLE;
    } else {
        active = EN_TABLE;
    }
}

/**
 * The resolved UI locale. Lets engine-layer modules (which must not import
 * 'obsidian' directly, ADR-080) branch on the app language.
 */
export function getActiveLocale(): SupportedLocale {
    return activeLocale;
}

/** True when the app runs in a non-bundled locale that needs an external language pack. */
export function needsLocalePack(): boolean {
    return activeLocale !== 'en' && activeLocale !== 'zh' && activeLocale !== 'zh-TW';
}

/**
 * Install a downloaded language pack as the active table. Merged onto active so
 * any key the pack is missing still resolves.
 */
export function applyLocalePack(table: Translations): void {
    active = Object.assign(Object.create(null) as Translations, active, table);
}

/** Test hook: force a specific table (null resets to the en fallback). */
export function __setActiveTranslationsForTest(table: Translations | null): void {
    active = table ?? EN_TABLE;
}

/**
 * Look up a UI string by key. Returns the string, falling back to en and
 * finally to the raw key.
 *
 * Supports simple interpolation: `t('key', { count: 5 })` replaces `{{count}}`.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    // Both active and EN_TABLE are null-prototype, so neither lookup returns
    // an inherited Object.prototype member; a missing key falls to the key.
    let text = active[key] ?? EN_TABLE[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            // Replacer function so '$&'-style patterns in values stay literal.
            text = text.replaceAll(`{{${k}}}`, () => String(v));
        }
    }
    return text;
}
