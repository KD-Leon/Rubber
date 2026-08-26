/**
 * FEAT-02-13: ein einziges `/`-Menue fuer Skills, Prompts und Workflows.
 *
 * Vorher hatte jeder Typ ein eigenes Praefix: `/` Skills, `#` Prompts,
 * `§` Workflows. Das Paragraphenzeichen ist auf keiner Tastatur ohne
 * Modifier erreichbar, und die Aufteilung verlangt vom Nutzer eine
 * Typ-Entscheidung, bevor er den Namen tippt -- also genau in dem Moment,
 * in dem er den Namen sucht. Die Zeile traegt ohnehin ein Typ-Label, das
 * die Unterscheidung nach der Auswahl uebernimmt.
 *
 * Kollisionen sind der Preis: `/report` kann jetzt mehrdeutig sein. Die
 * Praezedenz ist fix und wird NICHT still aufgeloest -- der verdeckte
 * Eintrag bleibt in der Liste sichtbar und sagt, dass er verdeckt ist.
 * Ein still verschwindender Prompt waere der schlechtere Handel.
 */

import type { WorkflowMeta } from '../../core/context/WorkflowLoader';
import type { CustomPrompt } from '../../types/settings';

/** Praezedenz bei gleichem Slug. Niedriger Index gewinnt. */
export const SLASH_PRECEDENCE = ['skill', 'prompt', 'workflow'] as const;
export type SlashKind = (typeof SLASH_PRECEDENCE)[number];

export interface SlashEntry {
    kind: SlashKind;
    slug: string;
    /** Anzeigename in der Zeile. */
    label: string;
    /**
     * True, wenn ein Eintrag hoeherer Praezedenz denselben Slug belegt.
     * Der Eintrag bleibt in der Liste, ist per `/slug` aber nicht
     * erreichbar -- die UI sagt das explizit an.
     */
    shadowed: boolean;
}

export interface SlashSources {
    skills: Array<{ name: string; slug: string }>;
    prompts: CustomPrompt[];
    workflows: WorkflowMeta[];
}

/**
 * Baut die vollstaendige, deduplizierte `/`-Liste. Sortierung: erst nach
 * Praezedenz-Rang, dann alphabetisch nach Slug, damit die Reihenfolge
 * unabhaengig von der Lade-Reihenfolge der Quellen stabil ist.
 */
export function buildSlashEntries(sources: SlashSources): SlashEntry[] {
    const raw: Array<Omit<SlashEntry, 'shadowed'>> = [
        ...sources.skills.map((s) => ({ kind: 'skill' as const, slug: s.slug, label: s.name })),
        ...sources.prompts.map((p) => ({ kind: 'prompt' as const, slug: p.slug, label: p.name })),
        ...sources.workflows.map((w) => ({ kind: 'workflow' as const, slug: w.slug, label: w.displayName })),
    ].filter((e) => e.slug.length > 0);

    const rank = (k: SlashKind) => SLASH_PRECEDENCE.indexOf(k);
    raw.sort((a, b) => rank(a.kind) - rank(b.kind) || a.slug.localeCompare(b.slug));

    const claimed = new Set<string>();
    return raw.map((e) => {
        const shadowed = claimed.has(e.slug);
        claimed.add(e.slug);
        return { ...e, shadowed };
    });
}

/**
 * Loest einen getippten Slug auf den Eintrag auf, der ihn tatsaechlich
 * beansprucht. Muss dieselbe Praezedenz benutzen wie die Liste, sonst
 * fuehrt die Auswahl in der Dropdown-Zeile zu einer anderen Expansion
 * als der Slug beim Senden.
 */
export function resolveSlashEntry(sources: SlashSources, slug: string): SlashEntry | null {
    if (!slug) return null;
    const winner = buildSlashEntries(sources).find((e) => e.slug === slug && !e.shadowed);
    return winner ?? null;
}

/**
 * SEC M-1: seit Skills, Prompts und Workflows sich einen Namensraum teilen,
 * kann ein installierter Skill den Slug eines selbst angelegten Prompts
 * uebernehmen. In der Liste ist das markiert, beim direkten Tippen und Senden
 * aber unsichtbar: der Nutzer glaubt, seinen eigenen Prompt auszufuehren.
 *
 * Die Praezedenz umzudrehen waere der schlechtere Handel gewesen, weil dann
 * ein alter Prompt einen frisch installierten Skill stumm verdeckt. Statt die
 * Rangfolge zu aendern, wird die Mehrdeutigkeit gemeldet: der Nutzer erfaehrt,
 * WAS lief und dass es eine zweite Bedeutung gab.
 *
 * Gibt die verdeckten Eintraege zurueck, leer bei eindeutigem Slug.
 */
export function findShadowedFor(sources: SlashSources, slug: string): SlashEntry[] {
    if (!slug) return [];
    return buildSlashEntries(sources).filter((e) => e.slug === slug && e.shadowed);
}

/** Filtert die Liste auf ein Praefix-Query (leeres Query = alles). */
export function filterSlashEntries(entries: SlashEntry[], query: string): SlashEntry[] {
    if (query === '') return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => e.slug.toLowerCase().startsWith(q));
}
