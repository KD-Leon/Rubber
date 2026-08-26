/**
 * Per-task calibrated token estimator (IMP-41-01-04, ADR-148).
 *
 * All loop-side token math used char/4, which under-estimates code/CJK by
 * 10-20 percent and delayed condensing into the emergency-overflow path.
 * Instead of bundling a tokenizer (>1MB, per-vocabulary), this estimator
 * calibrates a chars-per-token factor from the REAL prompt sizes the
 * provider reports in every usage chunk (input + cacheRead + cacheCreation
 * = full prompt tokens).
 *
 * Calibration policy: the first observation adopts the observed rate fully
 * (within one turn the estimate is inside 5 percent of ground truth, ADR-148
 * SC-1); later observations smooth with EMA alpha 0.5 because the true rate
 * within one conversation barely moves. Clamped to [2.0, 6.0] against
 * degenerate usage reports.
 */

import type { MessageParam } from '../../api/types';

const DEFAULT_CHARS_PER_TOKEN = 4.0;
const MIN_FACTOR = 2.0;
const MAX_FACTOR = 6.0;
const EMA_ALPHA = 0.5;

export class TokenEstimator {
    private charsPerToken = DEFAULT_CHARS_PER_TOKEN;
    private calibrated = false;

    getCharsPerToken(): number {
        return this.charsPerToken;
    }

    tokensForChars(chars: number): number {
        if (chars <= 0) return 0;
        return Math.ceil(chars / this.charsPerToken);
    }

    /**
     * Calibrate from a real observation: `chars` sent, `actualTokens`
     * reported by the provider for the same request. Invalid observations
     * are ignored.
     */
    recordUsage(chars: number, actualTokens: number): void {
        if (chars <= 0 || actualTokens <= 0) return;
        const observed = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, chars / actualTokens));
        this.charsPerToken = this.calibrated
            ? this.charsPerToken + EMA_ALPHA * (observed - this.charsPerToken)
            : observed;
        this.calibrated = true;
    }

    /** Seed from a count_tokens API result (pre-first-request). Same as a first observation. */
    seed(chars: number, actualTokens: number): void {
        this.recordUsage(chars, actualTokens);
    }

    /** Char volume of a message list, mirroring what estimateMessageTokens counts. */
    static sumChars(messages: MessageParam[]): number {
        let chars = 0;
        for (const m of messages) {
            if (typeof m.content === 'string') {
                chars += m.content.length;
                continue;
            }
            for (const block of m.content) {
                if ((block.type === 'text' || block.type === 'thinking') && typeof block.text === 'string') {
                    chars += block.text.length;
                } else if (block.type === 'tool_use') {
                    chars += block.input ? JSON.stringify(block.input).length : 0;
                } else if (block.type === 'tool_result') {
                    if (typeof block.content === 'string') {
                        chars += block.content.length;
                    } else if (Array.isArray(block.content)) {
                        for (const sub of block.content) {
                            if (sub.type === 'text') chars += sub.text.length;
                        }
                    }
                }
            }
        }
        return chars;
    }
}
