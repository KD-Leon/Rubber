/**
 * FIX-19-08-01: rekursive Skill-Ordner-Loeschung.
 *
 * Der fruehere Delete-Handler in SkillsTab lief einen manuellen 2-Ebenen-Walk
 * (Dateien im Ordner, Dateien in direkten Unterordnern) und rief am Ende
 * `rmdir(dir, false)`. Reale Skill-Ordner sind aber tiefer verschachtelt --
 * insbesondere `.versions/{timestamp}/references|scripts/...` vom
 * SkillSnapshotService. Solche Unterordner blieben liegen, der Skill-Root war
 * damit nicht leer, und das non-recursive `rmdir` warf ENOTEMPTY. Der Wurf
 * brach den ganzen Delete-Handler ab (Cache-/Toggle-/Reload-Cleanup lief nie),
 * und die UI-Liste zeigte den Skill weiter -- er "liess sich nicht loeschen".
 *
 * Diese reine Funktion kapselt die korrekte Loeschung (ein rekursives rmdir)
 * hinter einem Minimal-Adapter-Contract, damit der verschachtelte Fall ohne
 * Obsidian-Harness getestet werden kann.
 */

/** Minimal-Ausschnitt der Obsidian DataAdapter-API, den die Loeschung braucht. */
export interface SkillDeleteAdapter {
    exists(path: string): Promise<boolean>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    remove(path: string): Promise<void>;
    rmdir(path: string, recursive: boolean): Promise<void>;
}

/**
 * Loescht einen Skill-Ordner samt allem Inhalt (nested references, .versions,
 * scripts, code). No-op, wenn der Ordner nicht existiert.
 *
 * Nutzt `rmdir(dir, true)` -- Obsidians DataAdapter.rmdir loescht mit
 * recursive=true den kompletten Teilbaum, unabhaengig von der Tiefe. Kein
 * FileManager.trashFile, weil Skills im versteckten, nicht-indizierten
 * `.vault-operator/`-Ordner liegen (kein TFolder im Vault-Index).
 */
export async function deleteSkillFolder(adapter: SkillDeleteAdapter, skillDir: string): Promise<void> {
    const exists = await adapter.exists(skillDir);
    if (!exists) return;
    await adapter.rmdir(skillDir, true);
}
