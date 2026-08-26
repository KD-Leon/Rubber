/**
 * freshnessReport -- the visible trace of a Stufe-3 run (FIX-19-16-08).
 *
 * Before this, a run's results lived in a modal tab (off on mobile), a
 * six-second Notice saying "see console", and console.debug. A run whose
 * pre-filter answered "no" for every cluster was indistinguishable from a
 * run that never happened (the live vault's 2026-08-19 run: 149 clusters,
 * zero traces). This module renders ONE markdown note, overwritten per run,
 * so the vault always answers "when did this last run, and what came out".
 *
 * Report content is English by design: it is generated vault content, like
 * the agent's own notes. The settings toggle (freshness.writeReport) is
 * localized; the file is not.
 */

import type { Stufe3RunResult, UpdateFinding } from './Stufe3PeriodicJob';
import type { NoteVerdict } from './types';

export const FRESHNESS_REPORT_PATH = 'VaultHealth/Freshness-Report.md';

function noteLabel(path: string): string {
    const base = path.split('/').pop() ?? path;
    return base.replace(/\.md$/i, '');
}

function verdictLines(findings: UpdateFinding[]): string[] {
    const lines: string[] = [];
    for (const f of findings) {
        // Fehler-Verdicts (verifierError) sind kein Befund, sondern ein
        // gescheiterter Lauf -- der Orchestrator persistiert sie nicht,
        // und der Bericht zeigt sie nicht (FIX-19-05-05-Vertrag).
        const notes = (f.notes ?? []).filter((n: NoteVerdict) => !n.verifierError);
        for (const n of notes) {
            const src = n.sources.length ? ` ([source](${n.sources[0]}))` : '';
            lines.push(`- [[${n.path}|${noteLabel(n.path)}]] — **${n.verdict}** (${Math.round(n.confidence * 100)}%): ${n.summary}${src}`);
        }
    }
    return lines;
}

export function renderFreshnessReport(result: Stufe3RunResult, runAtIso: string): string {
    const day = runAtIso.slice(0, 10);
    const d = result.decisions;
    const head = [
        '# Freshness report',
        '',
        `Last run: ${day}. Clusters checked: ${result.clustersProcessed} `
        + `(${d.yes} worth a web pass, ${d.unsure} unsure, ${d.no} current). `
        + `Verdicts: ${result.verdictCount}. Week spend: ${result.spentUsd.toFixed(2)} USD`
        + `${result.budgetExceeded ? ', budget reached' : ''}.`,
        '',
    ];
    const verdicts = verdictLines(result.reportFindings);
    if (verdicts.length === 0) {
        head.push(`No findings this run. That is a checked state, not an unchecked one: `
            + `the clusters above were examined on ${day}.`);
        head.push('');
        head.push('Content-level freshness (contradictions, echo-chamber measurement against '
            + 'dated sources) is the daily-briefing skill\'s job; this report covers the '
            + 'built-in web verifier.');
        return head.join('\n');
    }
    head.push('## Notes touched');
    head.push('');
    head.push(...verdicts);
    const clusterSummaries = result.reportFindings.filter((f) => f.strongSignal);
    if (clusterSummaries.length) {
        head.push('');
        head.push('## Cluster signals');
        head.push('');
        for (const f of clusterSummaries) {
            head.push(`- **${f.cluster}**: ${f.summary.slice(0, 200)}${f.sources.length ? ` ([source](${f.sources[0]}))` : ''}`);
        }
    }
    head.push('');
    return head.join('\n');
}
