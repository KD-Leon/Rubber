/**
 * FreshnessOrchestrator -- per-cluster note-level verifier pipeline
 * (IMP-20-06-01 W2-T5).
 *
 * Flow per cluster:
 *   1. NoteSelector picks N candidate notes (volatile-first).
 *   2. For each candidate: read body via vault adapter, build query,
 *      run FreshnessWebSearch.
 *   3. FreshnessVerifier produces a NoteVerdict (mid + optional
 *      frontier).
 *   4. Verdict goes into note_freshness_history (retained), and the
 *      latest values mirror into note_freshness columns.
 *   5. Aggregated NoteVerdict[] feeds back to the caller, which
 *      attaches them to the cluster's UpdateFinding.
 *
 * The orchestrator is provider- and vault-agnostic for testability.
 * main.ts wires the real callbacks.
 *
 * Wayfinder entry: see `src/ARCHITECTURE.map`, row `freshness-orchestrator`.
 */

import type { TFile } from 'obsidian';
import type { FreshnessQueryBuilder } from './FreshnessQueryBuilder';
import type { FreshnessVerifier } from './FreshnessVerifier';
import type { FreshnessWebSearch } from './FreshnessWebSearch';
import type { NoteFreshnessHistoryStore } from './NoteFreshnessHistoryStore';
import type { NoteSelector } from './NoteSelector';
import type { FreshnessFrontmatterPatcher } from './FreshnessFrontmatterPatcher';
import type { NoteVerdict } from './types';

interface SqlDb {
    run(sql: string, params?: unknown[]): unknown;
}

export type ReadNoteBodyFn = (path: string) => Promise<string | null>;
export type GetTopEntitiesFn = (path: string) => string[];
export type IsEnabledFn = () => boolean;
export type IsWriteFrontmatterEnabledFn = () => boolean;
export type GetFileByPathFn = (path: string) => TFile | null;

export interface FreshnessOrchestratorDeps {
    selector: NoteSelector;
    queryBuilder: FreshnessQueryBuilder;
    webSearch: FreshnessWebSearch;
    verifier: FreshnessVerifier;
    history: NoteFreshnessHistoryStore;
    db: SqlDb;
    readNoteBody: ReadNoteBodyFn;
    getTopEntities?: GetTopEntitiesFn;
    /**
     * Audit M-3 mitigation (AUDIT-IMP-20-06-01-2026-06-19):
     * outer authorization gate. The orchestrator MUST NOT touch
     * note_freshness or note_freshness_history when no freshness
     * sub-flag is enabled. main.ts wires this to the user setting
     * so a fresh install does not write verifier rows the user
     * never opted into.
     */
    enabled?: IsEnabledFn;
    now?: () => Date;
    /**
     * FIX-19-99-03 (FreshnessFrontmatterPatcher wiring): if both the
     * patcher and the writeFrontmatter gate are provided AND the gate
     * returns true, every persistVerdict run mirrors the verdict label
     * into the note's `freshness:` frontmatter key via the allowlisted
     * patcher. The patcher's allowlist (FRESHNESS_ALLOWLIST = ['freshness'])
     * makes this safe -- no other YAML key can leak.
     *
     * Both fields stay optional so the orchestrator continues to work in
     * test setups (which do not need a real Vault). main.ts wires the
     * real callbacks.
     */
    frontmatterPatcher?: FreshnessFrontmatterPatcher;
    writeFrontmatterEnabled?: IsWriteFrontmatterEnabledFn;
    getFileByPath?: GetFileByPathFn;
}

export interface RunForClusterResult {
    verdicts: NoteVerdict[];
    tokensUsed: number;
}

export class FreshnessOrchestrator {
    constructor(private readonly deps: FreshnessOrchestratorDeps) {}

    /**
     * @param seedSources FIX-19-16-07: URLs the cluster-level web pass
     * already paid for (Stufe3Hooks). They join every note's own search
     * hits so the verifier sees them instead of them being thrown away
     * (the FEAT-19-03-01 double-search leftover).
     */
    async runForCluster(cluster: string, seedSources: string[] = []): Promise<RunForClusterResult> {
        if (this.deps.enabled && !this.deps.enabled()) {
            return { verdicts: [], tokensUsed: 0 };
        }
        const now = (this.deps.now ?? (() => new Date()))();
        const candidates = this.deps.selector.pickCandidates(cluster, now);
        if (!candidates.length) return { verdicts: [], tokensUsed: 0 };

        const verdicts: NoteVerdict[] = [];
        let tokensUsed = 0;

        for (const candidate of candidates) {
            const body = await this.deps.readNoteBody(candidate.path);
            if (body === null) continue;

            const topEntities = this.deps.getTopEntities?.(candidate.path) ?? [];
            const title = extractTitle(body, candidate.path);
            const query = this.deps.queryBuilder.build({
                notePath: candidate.path,
                title,
                cluster,
                topEntities,
            });

            const webResults = query
                ? await this.deps.webSearch.search(query, 5)
                : [];
            // Per-note hits first (they answer the note's own query), then
            // the cluster seeds; duplicates fold. The provider prompt caps
            // at 8 URLs, so order is relevance.
            const sources = Array.from(new Set([...webResults.map((r) => r.url), ...seedSources]));

            const verdict = await this.deps.verifier.verifyNote(
                { path: candidate.path, body },
                { cluster, sources },
            );

            tokensUsed += verdict.tokensUsed;

            // FIX-19-05-05: einen gescheiterten Verifier-Lauf NICHT persistieren.
            // Sonst blockiert ein leeres FAIL_CLOSED-Verdict die Notiz bis zu 90
            // Tage (Recheck-Cooldown) und erscheint die ganze Zeit als leerer
            // "Befund". Nicht schreiben heisst: der naechste Scan versucht sie neu.
            if (verdict.verifierError) {
                continue;
            }

            this.persistVerdict(verdict, now);
            await this.maybeMirrorToFrontmatter(verdict);
            verdicts.push(verdict);
        }

        return { verdicts, tokensUsed };
    }

    /**
     * FIX-19-99-03: optional frontmatter mirror. Gated behind the
     * writeFrontmatter setting plus the presence of a patcher + file
     * lookup, so test deps stay minimal.
     */
    private async maybeMirrorToFrontmatter(verdict: NoteVerdict): Promise<void> {
        const patcher = this.deps.frontmatterPatcher;
        const gate = this.deps.writeFrontmatterEnabled;
        const getFile = this.deps.getFileByPath;
        if (!patcher || !gate || !getFile) return;
        if (!gate()) return;
        const file = getFile(verdict.path);
        if (!file) return;
        try {
            await patcher.writeHint(file, { label: verdict.verdict, replace: true });
        } catch (err) {
            console.warn('[FreshnessOrchestrator] frontmatter mirror failed:', err);
        }
    }

    private persistVerdict(verdict: NoteVerdict, now: Date): void {
        const runAt = now.toISOString();
        const sourcesJson = JSON.stringify(verdict.sources);

        this.deps.history.recordRun({
            path: verdict.path,
            runAt,
            verdict: verdict.verdict,
            confidence: verdict.confidence,
            verifierTier: verdict.verifierTier,
            modelId: verdict.modelId,
            tokensUsed: verdict.tokensUsed,
            summary: verdict.summary,
            sources: verdict.sources,
            now,
        });

        this.deps.db.run(
            `UPDATE note_freshness
             SET last_verdict = ?, last_confidence = ?, last_summary = ?,
                 last_sources_json = ?, last_checked_at = ?, last_verifier_tier = ?
             WHERE path = ?`,
            [
                verdict.verdict,
                verdict.confidence,
                verdict.summary,
                sourcesJson,
                runAt,
                verdict.verifierTier,
                verdict.path,
            ],
        );
    }
}

function extractTitle(body: string, fallbackPath: string): string {
    const firstHeading = body.split('\n').find((line) => line.startsWith('# '));
    if (firstHeading) return firstHeading.slice(2).trim();
    const filename = fallbackPath.split('/').pop() ?? '';
    return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}
