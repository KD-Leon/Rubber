/**
 * FIX-COMPACT-08: per-tool result summary for the condense ledger.
 *
 * The previous slice(0,200) cap meant a `read_file` ledger entry looked
 * like the first 200 chars of code -- noise for the summarizer prompt
 * and no clue that the FILE was already read. A tool-aware summary
 * surfaces the structural fact ("read L1-L420 of src/foo.ts") so the
 * post-condense agent has a precise signal of what was already covered.
 *
 * Unknown tools fall back to the existing 200-char prefix.
 */

import type { ToolResultContentBlock } from '../../api/types';

const MAX_FALLBACK = 200;

function asText(content: string | ToolResultContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
        .filter((b): b is ToolResultContentBlock & { type: 'text' } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
}

/**
 * FIX-29-05 audit L-2: the `<error>` alternative used to be unanchored, so ANY
 * content carrying the literal string `<error>` -- a vault note, a fetched
 * page, a JUnit report the user asked to read -- classified a successful tool
 * result as failed. The host emits its own wrapper at the very start of the
 * text (BaseTool.formatError), so anchoring costs nothing and removes the
 * attacker's influence over classification.
 */
function isErrorContent(text: string): boolean {
    return /^<error>|^error[: ]/i.test(text.trim());
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
    for (const k of ['path', 'file_path', 'filepath', 'notePath']) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
}

function queryFromInput(input: Record<string, unknown>): string | undefined {
    for (const k of ['query', 'pattern', 'search', 'q']) {
        const v = input[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
}

/**
 * Tool-aware result summary for the ledger.
 *
 * @param toolName  The tool that produced this result.
 * @param input     The tool's input arguments.
 * @param content   The result content (string or multimodal array).
 */
export function summarizeForLedger(
    toolName: string,
    input: Record<string, unknown>,
    content: string | ToolResultContentBlock[],
): string {
    const text = asText(content);

    // Errors: keep the raw short message so the summarizer can see what failed.
    if (isErrorContent(text)) {
        const path = pathFromInput(input);
        const head = text.slice(0, MAX_FALLBACK);
        return path ? `${path}: ${head}` : head;
    }

    switch (toolName) {
        case 'read_file':
        case 'read_notes':
        case 'read_note': {
            const path = pathFromInput(input) ?? '<unknown>';
            const lines = text === '' ? 0 : text.split('\n').length;
            return `L1-L${lines} of ${path}`;
        }
        case 'search_files':
        case 'search_vault':
        case 'search_by_tag':
        case 'semantic_search': {
            const query = queryFromInput(input) ?? '<unknown>';
            // Heuristic: count distinct lines / hit markers
            const hitLines = text.split('\n').filter((l) => l.trim().length > 0);
            const nHits = hitLines.length;
            const firstHits = hitLines.slice(0, 3).map((l) => l.split(':')[0]).filter(Boolean);
            const sample = firstHits.length > 0 ? ` [${firstHits.join(', ')}]` : '';
            return `query="${query}" -> ${nHits} hit(s)${sample}`;
        }
        case 'write_vault':
        case 'write_file':
        case 'append_to_file': {
            const path = pathFromInput(input) ?? '<unknown>';
            const bytes = text.length; // rough proxy when the tool output doesn't expose size
            return `wrote ${path} (~${bytes} bytes)`;
        }
        case 'list_files':
        case 'list_directory':
        case 'list_dir': {
            const path = pathFromInput(input) ?? '<unknown>';
            const n = text.split('\n').filter((l) => l.trim().length > 0).length;
            return `listed ${path} -> ${n} entries`;
        }
        case 'attempt_completion':
            return 'attempt_completion called';
        case 'execute_command': {
            const cmd = typeof input.command === 'string' ? input.command.slice(0, 60) : '';
            return `command="${cmd}" -> ${text.length} bytes output`;
        }
        default:
            return text.slice(0, MAX_FALLBACK);
    }
}
