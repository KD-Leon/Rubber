/**
 * skillInventoryRenderer -- IMP-29-03-01 / FIX-29-03-03.
 *
 * Ein Skill kann Sidecars mitbringen: `scripts/`, `references/`, `assets/`
 * und Sub-Rollen (EPIC-022 / ADR-075). Wer den Body bekommt, aber nicht die
 * Liste dieser Dateien, weiß nicht, dass es sie gibt, und erfindet den
 * Workflow neu. Bis hierher kannte nur `ReadSkillTool` die Inventarzeile;
 * der Slash-Pfad in der Sidebar, der Inline-Composer und der über
 * `invoke_skill` gestartete Subtask bauten ihre Nachricht selbst zusammen
 * und ließen das Inventar weg.
 *
 * Diese Datei ist die eine Stelle, die diese Zeilen erzeugt. Jedes Feld
 * hier ist autor-kontrolliert (Dateinamen auf der Platte, Sub-Rollen-
 * Frontmatter), also läuft jedes durch `sanitizeDirectoryEntry`: das
 * entschärft Boundary-Tags, macht aus jedem Eintrag genau eine Zeile und
 * deckelt die Länge. Die Caps spiegeln
 * `SelfAuthoredSkillLoader.renderSkillSummary`.
 */

import { sanitizeDirectoryEntry, escapeXmlAttribute } from '../tools/BaseTool';

/**
 * Strukturelle Sicht auf `SkillInventory`. Bewusst schmal und optional: die
 * Aufrufer reichen teils lose getypte Skill-Objekte durch (Composer-Stub,
 * Loader-Ergebnis), und ein Skill ohne Sidecars hat gar kein Inventar.
 */
export interface RenderableSkillInventory {
    /** `SkillScriptFile`; gerendert wird nur der Pfad. */
    scripts?: readonly { path: string; language?: string; sizeBytes?: number }[];
    references?: readonly string[];
    assets?: readonly string[];
    /** `SkillSubRole`; gerendert werden Pfad und Rolle. */
    subRoles?: readonly { role: string; filePath: string; name?: string; description?: string }[];
}

export interface RenderableSkill {
    name: string;
    body: string;
    inventory?: RenderableSkillInventory;
}

/**
 * Die Inventarzeilen eines Skills, eine Zeile pro befüllter Kategorie.
 * Leerer String, wenn der Skill keine Sidecars hat -- dann darf der Aufrufer
 * seine Nachricht unverändert lassen.
 *
 * Wortlaut und Reihenfolge sind die von `ReadSkillTool.renderInventoryHints`,
 * das seine Ausgabe seit FEAT-24-09 so ausliefert. Sie bleiben identisch,
 * damit read_skill durch die Zusammenlegung kein Zeichen anders schreibt.
 */
export function renderSkillInventory(inventory: RenderableSkillInventory | undefined): string {
    if (!inventory) return '';
    const scripts = inventory.scripts ?? [];
    const references = inventory.references ?? [];
    const assets = inventory.assets ?? [];
    const subRoles = inventory.subRoles ?? [];

    const lines: string[] = [];
    if (scripts.length > 0) {
        lines.push(`**Scripts:** ${scripts.map(s => sanitizeDirectoryEntry(s.path, 120)).join(', ')}`);
    }
    if (references.length > 0) {
        lines.push(`**References (read with read_file when needed):** ${references.map(r => sanitizeDirectoryEntry(r, 120)).join(', ')}`);
    }
    if (assets.length > 0) {
        lines.push(`**Assets:** ${assets.map(a => sanitizeDirectoryEntry(a, 120)).join(', ')}`);
    }
    if (subRoles.length > 0) {
        lines.push(`**Sub-roles (read on demand):** ${subRoles.map(r => `${sanitizeDirectoryEntry(r.filePath, 120)} (${sanitizeDirectoryEntry(r.role, 60)})`).join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * IMP-29-03-01: die Nachricht, die `/skill` erzeugt.
 *
 * Sidebar und Inline-Composer bauten diesen Block bis hierher jeweils selbst,
 * zeichengleich und beide ohne Inventar. Eine Funktion für beide, damit die
 * zwei Oberflächen nicht wieder auseinanderlaufen.
 *
 * `trailingUserText` ist der Rest hinter dem Slash-Kommando ("/deck für die
 * Notiz von gestern") und steht außerhalb der Klammer, weil er vom Nutzer
 * kommt und nicht Teil der Skill-Anweisung ist.
 */
export function buildExplicitSkillInstructions(
    skill: RenderableSkill,
    trailingUserText?: string,
): string {
    // Der Name steht in einem Tag-Attribut, also erst flach machen (eine
    // Zeile, Boundary-Tags entschärft), dann attribut-escapen. Sonst
    // schließt ein Anführungszeichen im Skill-Namen das Attribut.
    const safeName = escapeXmlAttribute(sanitizeDirectoryEntry(skill.name, 80));
    const inventory = renderSkillInventory(skill.inventory);
    const parts = [`<explicit_instructions skill="${safeName}">`];
    if (inventory.length > 0) parts.push(inventory, '');
    parts.push(skill.body, '</explicit_instructions>');
    if (trailingUserText !== undefined && trailingUserText.length > 0) {
        parts.push('', trailingUserText);
    }
    return parts.join('\n');
}
