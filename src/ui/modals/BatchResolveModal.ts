/**
 * BatchResolveModal -- bulk-apply for the Knowledge-review tab
 * (IMP-20-06-01 W3-T3).
 *
 * FIX-19-05-06: der Batch-Dialog macht nur noch EINES -- die gefilterten
 * Zeilen AUSBLENDEN (bis der naechste Scan eine Aenderung findet). Das
 * fruehere mark-verified/delete-Auswahlmenue war verwirrend ("was passiert
 * beim Run?") und delete war eine gefaehrliche Massen-Aktion, die niemand aus
 * einem Freshness-Review heraus will. Der echte Fix laeuft pro Notiz ueber den
 * Agenten ("Fix with agent"), nicht als Stapel.
 *
 * Wayfinder entry: see `src/ARCHITECTURE.map`, row `batch-resolve-modal`.
 */

import { Modal, Notice } from 'obsidian';
import { t } from '../../i18n';
import type ObsidianAgentPlugin from '../../main';
import type {
    ReviewRow,
    ReviewSeverity,
} from '../../core/health/KnowledgeReviewReader';

const ALL_SEVERITIES: ReviewSeverity[] = ['critical', 'moderate', 'info'];

export interface BatchResolveModalOptions {
    onChange: () => void;
}

export class BatchResolveModal extends Modal {
    private readonly plugin: ObsidianAgentPlugin;
    private readonly rows: ReviewRow[];
    private readonly opts: BatchResolveModalOptions;

    private selectedSeverities: Set<ReviewSeverity> = new Set(['critical', 'moderate']);
    private minConfidence = 0;
    private aborted = false;

    constructor(plugin: ObsidianAgentPlugin, rows: ReviewRow[], opts: BatchResolveModalOptions) {
        super(plugin.app);
        this.plugin = plugin;
        this.rows = rows;
        this.opts = opts;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('batch-resolve-modal');

        contentEl.createEl('h3', { text: t('modal.batchResolve.title') });
        contentEl.createEl('p', { text: t('modal.batchResolve.rowsInView', { count: this.rows.length }) });
        // FIX-19-05-06: klarer Erklaertext, was "Run" tut.
        contentEl.createEl('p', { cls: 'batch-resolve-explainer', text: t('modal.batchResolve.hideExplainer') });

        this.renderFilters(contentEl);
        const previewEl = contentEl.createDiv('batch-resolve-preview');
        const counterEl = contentEl.createDiv('batch-resolve-counter');

        const update = () => {
            const matched = this.filteredRows();
            previewEl.empty();
            previewEl.createEl('strong', { text: t('modal.batchResolve.willAffect', { count: matched.length }) });
            counterEl.empty();
        };

        // Wire all filter changes to update the preview.
        contentEl.querySelectorAll('input').forEach((el) => {
            el.addEventListener('change', update);
        });
        contentEl.querySelectorAll('select').forEach((el) => {
            el.addEventListener('change', update);
        });
        update();

        const buttonRow = contentEl.createDiv('batch-resolve-actions');
        const runBtn = buttonRow.createEl('button', { text: t('modal.batchResolve.runBtn') });
        const abortBtn = buttonRow.createEl('button', { text: t('modal.batchResolve.abortBtn'), cls: 'mod-warning' });
        abortBtn.disabled = true;

        runBtn.addEventListener('click', () => {
            void (async () => {
                // FIX-19-05-06: nur noch Ausblenden -- keine destruktive
                // Massen-Loeschung mehr, also kein Confirm noetig.
                const targets = this.filteredRows();
                runBtn.disabled = true;
                abortBtn.disabled = false;
                await this.runBatch(targets, counterEl).finally(() => {
                    runBtn.disabled = false;
                    abortBtn.disabled = true;
                    update();
                });
            })();
        });
        abortBtn.addEventListener('click', () => {
            this.aborted = true;
        });
    }

    onClose(): void {
        this.aborted = true;
        this.contentEl.empty();
    }

    private renderFilters(parent: HTMLElement): void {
        const sevRow = parent.createDiv('batch-resolve-filter-row');
        sevRow.createEl('strong', { text: t('modal.batchResolve.severities') });
        for (const sev of ALL_SEVERITIES) {
            const label = sevRow.createEl('label', { cls: 'batch-resolve-filter-label' });
            const input = label.createEl('input', { type: 'checkbox' });
            input.checked = this.selectedSeverities.has(sev);
            input.addEventListener('change', () => {
                if (input.checked) this.selectedSeverities.add(sev);
                else this.selectedSeverities.delete(sev);
            });
            label.appendText(' ' + sev);
        }

        const confRow = parent.createDiv('batch-resolve-filter-row');
        confRow.createEl('strong', { text: t('modal.batchResolve.minConfidence') });
        const confInput = confRow.createEl('input', { type: 'number' });
        confInput.value = '0';
        confInput.min = '0';
        confInput.max = '1';
        confInput.step = '0.05';
        confInput.addEventListener('change', () => {
            const parsed = parseFloat(confInput.value);
            this.minConfidence = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
        });
        // FIX-19-05-06: kein Aktions-Auswahlmenue mehr -- der Dialog blendet
        // nur aus. Loeschen/Fixen laeuft nicht ueber den Stapel.
    }

    private filteredRows(): ReviewRow[] {
        return this.rows.filter((r) => {
            if (!this.selectedSeverities.has(r.severity)) return false;
            if (r.confidence < this.minConfidence) return false;
            return true;
        });
    }

    private async runBatch(rows: ReviewRow[], counterEl: HTMLElement): Promise<void> {
        this.aborted = false;
        let done = 0;
        let failed = 0;
        for (const row of rows) {
            if (this.aborted) break;
            try {
                this.hideRow(row);
                done++;
            } catch (e) {
                console.debug('[BatchResolveModal] row failed', row.path, e);
                failed++;
            }
            counterEl.empty();
            counterEl.appendText(t('modal.batchResolve.progress', { done, total: rows.length, failed }));
            // FIX-19-05-06: dem UI-Thread Luft geben, damit der Zaehler + der
            // Abort-Knopf bei vielen Zeilen reagieren (hideRow ist synchron).
            await new Promise<void>((r) => window.setTimeout(r, 0));
        }
        new Notice(this.aborted
            ? t('notice.knowledgeReview.batchCompleteAborted', { done, failed })
            : t('notice.knowledgeReview.batchComplete', { done, failed }));
        this.opts.onChange();
    }

    /** FIX-19-05-06: blendet die Zeile aus (Dismiss bis zur naechsten Aenderung). */
    private hideRow(row: ReviewRow): void {
        const db = this.plugin.knowledgeDB?.getDB();
        if (!db) return;
        db.run(
            `INSERT OR REPLACE INTO dismissed_freshness (note_path, hint_type, dismissed_at)
             VALUES (?, 'verdict', ?)`,
            [row.path, new Date().toISOString()],
        );
        this.plugin.knowledgeDB?.markDirty();
    }
}
