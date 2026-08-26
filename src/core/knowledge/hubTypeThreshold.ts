/**
 * hubTypeThreshold -- welche Note-Typen strukturelle Hubs sind und ab wie
 * vielen Backlinks sie einen Rueckverweis-Block bekommen (FIX-19-09-01).
 *
 * USER 2026-07-21: person / topic / concept / project / organisation (inkl. der
 * deutschen Synonyme thema / konzept / projekt) sind strukturelle Hubs. Sie
 * bekommen einen Block ab dem ERSTEN Backlink (Threshold 1), hartkodiert und
 * bewusst NICHT ueber Settings aenderbar (still, nur in der Doku vermerkt). Alle
 * anderen Typen bekommen einen Block erst ab dem konfigurierbaren
 * Settings-Threshold.
 *
 * Reine Funktion, kein I/O -- die Typ-Menge ist die einzige Wahrheit, geteilt
 * zwischen der Block-Generierung (main.ts) und, spiegelbildlich, der
 * strukturellen Kategorie im VaultHealthService.
 */

/** Threshold fuer strukturelle Hub-Typen: Block ab dem ersten Backlink. */
export const HUB_TYPE_THRESHOLD = 1;

/**
 * Strukturelle Hub-Typen (lowercase). EN + DE-Synonyme. Deckungsgleich mit den
 * strukturellen Kategorien im VaultHealthService (structuralCategories); beide
 * Mengen muessen synchron bleiben.
 */
export const HUB_TYPES: ReadonlySet<string> = new Set([
    'person',
    'topic', 'thema',
    'concept', 'konzept',
    'project', 'projekt',
    'organisation', 'organization',
]);

/**
 * True, wenn der (bereits zu Text normalisierte) type-Wert einen strukturellen
 * Hub-Typ enthaelt. Listen-tolerant: frontmatterCellText liefert eine YAML-Liste
 * als "a, b" -- jeder Teilwert wird geprueft. Case-insensitiv, getrimmt.
 */
export function isHubType(typeText: string | undefined | null): boolean {
    if (!typeText) return false;
    return typeText
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .some((s) => HUB_TYPES.has(s));
}

/**
 * Der effektive Threshold fuer eine Note: 1 fuer Hub-Typen (hartkodiert), sonst
 * der uebergebene Settings-Threshold.
 */
export function effectiveHubThreshold(typeText: string | undefined | null, settingsThreshold: number): number {
    return isHubType(typeText) ? HUB_TYPE_THRESHOLD : settingsThreshold;
}
