/**
 * Thinking-segment accumulation for the agent loop (IMP-41-01-05).
 *
 * Anthropic streams extended thinking as blocks, each sealed by a signature
 * at content_block_stop; OpenAI-compatible reasoners stream unsigned text.
 * The loop used to join everything into one capped string, which breaks
 * signed passback twice over: a joined multi-block text does not match any
 * single signature, and a capped text fails signature validation with a 400.
 *
 * Rules encoded here:
 *  - seal(signature) closes the currently accumulating segment as SIGNED
 *  - signed segments are persisted verbatim (never capped, never merged)
 *  - trailing unsigned content becomes one segment under the legacy cap
 */

import type { ContentBlock } from '../../api/types';

export class ThinkingSegmentCollector {
    private sealed: Array<{ text: string; signature: string }> = [];
    private current: string[] = [];

    push(text: string): void {
        this.current.push(text);
    }

    /** Seal the currently accumulating text as a signed segment. */
    seal(signature: string): void {
        const text = this.current.join('');
        this.current = [];
        if (text.length === 0) return;
        this.sealed.push({ text, signature });
    }

    hasContent(): boolean {
        return this.sealed.length > 0 || this.current.some((t) => t.length > 0);
    }

    /**
     * Materialize ContentBlocks: signed segments verbatim, the trailing
     * unsigned remainder capped at `unsignedCap` chars (AUDIT-037 L-1).
     */
    finalize(unsignedCap: number): Array<Extract<ContentBlock, { type: 'thinking' }>> {
        const blocks: Array<Extract<ContentBlock, { type: 'thinking' }>> = [];
        for (const seg of this.sealed) {
            blocks.push({ type: 'thinking', text: seg.text, signature: seg.signature });
        }
        const rest = this.current.join('');
        if (rest.length > 0) {
            const capped = rest.length > unsignedCap
                ? rest.slice(0, unsignedCap)
                    + `\n[thinking truncated: ${rest.length - unsignedCap} chars dropped to keep history bounded]`
                : rest;
            blocks.push({ type: 'thinking', text: capped });
        }
        return blocks;
    }
}
