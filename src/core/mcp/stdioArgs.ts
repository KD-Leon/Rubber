/**
 * stdioArgs -- parse/format the command arguments of a stdio MCP server
 * (FEAT-04-13). The Arguments field accepts either a JSON array
 * (`["-y", "mcp-remote", "..."]`) or plain shell syntax with quotes
 * (`-y @some/mcp-server arg1 arg2`), matching the common convention other MCP
 * clients use so a config can be pasted verbatim.
 *
 * The previous one-arg-per-line parsing was the bug: a single-line
 * space-separated value became ONE giant argument and the server never started.
 */

/**
 * Parse an arguments string into an argv array. Accepts a JSON string array
 * (when the trimmed input is bracketed) or shell-style tokens with single/
 * double quotes. Whitespace outside quotes separates tokens; empty input -> [].
 */
export function parseShellArgs(input: string): string[] {
    const trimmed = input.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.every((a): a is string => typeof a === 'string')) {
                return parsed;
            }
        } catch {
            // Fall through to shell parsing on malformed JSON.
        }
    }

    const args: string[] = [];
    let current = '';
    let started = false; // distinguishes an empty quoted token "" from no token
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];
        // Inside double quotes a backslash escapes the next character (\" and
        // \\), so joinArgsForDisplay can round-trip a token that itself contains
        // a quote or a backslash. Single-quoted and bare tokens keep the
        // backslash literal (shell convention).
        if (ch === '\\' && inDouble && i + 1 < trimmed.length) {
            current += trimmed[i + 1];
            i++;
            started = true;
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            started = true;
        } else if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            started = true;
        } else if (/\s/.test(ch) && !inDouble && !inSingle) {
            if (started) { args.push(current); current = ''; started = false; }
        } else {
            current += ch;
            started = true;
        }
    }
    if (started) args.push(current);
    return args;
}

/** Format an argv array back into a single editable shell line (quotes tokens
 *  that contain whitespace or a double quote). Round-trips with parseShellArgs. */
export function joinArgsForDisplay(args: string[]): string {
    return args
        .map((arg) => {
            if (!/[\s"\\]/.test(arg)) return arg;
            // Escape backslash FIRST, then the double quote, so the result
            // round-trips through parseShellArgs (CWE-116: a backslash left
            // unescaped would swallow the following char on the next parse).
            const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${escaped}"`;
        })
        .join(' ');
}
