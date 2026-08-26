/**
 * CondensationFeedback - Shows token reduction after condensing
 * Adapted from Kilo Code's CondensationResultRow component
 */

import { setIcon } from 'obsidian';
import { t } from '../../i18n';

export interface CondensationResult {
    prevTokens: number;
    newTokens: number;
    cost?: number;
    summary?: string;
}

export class CondensationFeedback {
    show(parent: HTMLElement, result: CondensationResult): HTMLElement {
        const row = parent.createDiv('condensation-feedback');

        const header = row.createDiv('condensation-feedback-header');
        setIcon(header.createSpan('condensation-icon'), 'fold-vertical');
        header.createSpan('condensation-title').setText(t('ui.sidebar.contextCondensed'));

        const tokens = header.createSpan('condensation-tokens');
        tokens.setText(
            t('ui.condensation.tokenChange', { prev: this.formatNumber(result.prevTokens), next: this.formatNumber(result.newTokens) })
        );

        if (result.cost && result.cost > 0) {
            header.createSpan('condensation-cost').setText(`$${result.cost.toFixed(4)}`);
        }

        return row;
    }

    private formatNumber(num: number): string {
        if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
        if (num >= 1_000) return (num / 1_000).toFixed(1) + 'k';
        return num.toString();
    }
}
