/**
 * FIX-COMPACT-05: replace MicroCompactor skeletons with a one-line
 * placeholder BEFORE sending to the condensing helper API.
 *
 * Microcompaction writes self-describing skeletons into oversized
 * tool_result blocks ("[context-pruned] read_file result (5000 chars)
 * was used in an earlier turn..."). When the full-condense pass later
 * picks up those messages in toSummarize, the helper model paraphrases
 * the skeletons into the summary -- token waste AND a source of
 * phantom findings ("the tool dropped data" sneaks into the summary).
 *
 * The fix swaps the content for a short placeholder. tool_use_id and
 * is_error stay intact so the Anthropic tool_use/tool_result pairing
 * contract still holds and the boundary fixes in condenseHistory keep
 * working.
 *
 * Pure function; no I/O. Lives next to MicroCompactor because it
 * imports the same PRUNED_MARKER and is the inverse-projection of the
 * pruning step.
 */

import type {
    ContentBlock,
    MessageParam,
    ToolResultContentBlock,
} from '../../api/types';
import { PRUNED_MARKER } from './MicroCompactor';

const PLACEHOLDER = '[pruned earlier; ignore for summary]';

function startsWithPrunedMarker(content: string | ToolResultContentBlock[]): boolean {
    if (typeof content === 'string') return content.startsWith(PRUNED_MARKER);
    return content.length === 1
        && content[0].type === 'text'
        && content[0].text.startsWith(PRUNED_MARKER);
}

/**
 * Returns a NEW array where any pruned tool_result block carries the
 * placeholder instead of the verbose skeleton. Untouched messages keep
 * their original reference (cheap-path identity preserved). Error
 * tool_results are left intact -- they're short and the agent needs
 * them readable.
 */
export function stripPrunedForCondense(history: MessageParam[]): MessageParam[] {
    return history.map((msg) => {
        if (!Array.isArray(msg.content)) return msg;
        let changed = false;
        const newContent: ContentBlock[] = msg.content.map((block) => {
            if (block.type !== 'tool_result') return block;
            if (block.is_error) return block;
            if (!startsWithPrunedMarker(block.content)) return block;
            changed = true;
            return {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: PLACEHOLDER,
                is_error: block.is_error,
            };
        });
        return changed ? { ...msg, content: newContent } : msg;
    });
}
