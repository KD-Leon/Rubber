/**
 * Per-file dossiers for hierarchical condensing (IMP-41-03-06).
 *
 * The keep-first-last condense collapses everything into one flat LLM
 * summary; per-file detail (which range was read, what was found, what was
 * written) gets paraphrased away, so the model re-reads files it already
 * knew right after every condense. The dossier records file touches
 * DETERMINISTICALLY (no LLM, no hallucination risk) and condenseHistory
 * appends its rendering to the summary message.
 *
 * Budgets: 200 chars detail per file, 30 files LRU (touch refreshes),
 * 3000 chars rendered section. The dossier lives on the task (survives
 * condense cycles), fed by the MicroCompactor at prune time — pruning is
 * exactly the moment verbatim content leaves the context.
 */

const MAX_FILES = 30;
const MAX_DETAIL_CHARS = 200;
const MAX_RENDER_CHARS = 3000;

interface DossierEntry {
    detail: string;
    written: boolean;
}

export class FileDossier {
    /** Map iteration order = insertion order; re-insert on touch for LRU. */
    private entries = new Map<string, DossierEntry>();

    record(path: string, info: { detail: string; kind: 'read' | 'write' }): void {
        const previous = this.entries.get(path);
        this.entries.delete(path); // re-insert to refresh LRU position
        const detail = info.detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
        this.entries.set(path, {
            detail: detail || previous?.detail || '',
            written: (previous?.written ?? false) || info.kind === 'write',
        });
        while (this.entries.size > MAX_FILES) {
            // done-narrowing keeps the key typed as string on both older
            // and newer TS iterator typings (same pattern as RunSkillScriptCache).
            const oldest = this.entries.keys().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value);
        }
    }

    /**
     * Deterministic rendering, most recently touched first, hard-capped at
     * MAX_RENDER_CHARS (whole lines only). Empty string when unused.
     */
    render(): string {
        if (this.entries.size === 0) return '';
        const lines: string[] = ['[FILE DOSSIER] Files already visited this task (do not re-read unless the dossier is insufficient):'];
        const paths = [...this.entries.keys()].reverse(); // most recent first
        for (const path of paths) {
            const entry = this.entries.get(path);
            if (!entry) continue;
            const marker = entry.written ? ' (written)' : '';
            lines.push(`- ${path}${marker}: ${entry.detail}`);
        }
        let out = '';
        for (const line of lines) {
            if (out.length + line.length + 1 > MAX_RENDER_CHARS) break;
            out += (out ? '\n' : '') + line;
        }
        return out;
    }
}
