/**
 * Immediate chat title from the user's first message (FEAT-55-01).
 *
 * User request 2026-07-25: a tab should be named the moment you send, built
 * from the intent of the first message, instead of staying "New conversation"
 * until a task finishes. Naming at task end alone was fragile: a run that is
 * stopped, fails, or is still working leaves the tab unnamed, which is exactly
 * when several open tabs are hardest to tell apart.
 *
 * This is the cheap, local, always-available name. The semantic (LLM) title
 * still replaces it later and is marked titleSource 'auto', so this function
 * only ever fills the gap between sending and that better title arriving.
 *
 * Pure and side-effect free so it can be unit tested without the workspace.
 *
 * Architecture-map concept: parallel-chat-session (in-view tabs)
 */

/** Longest stored title. Matches the semantic titler's own cap. */
const MAX_TITLE_LEN = 60;

/**
 * Build a short title from raw composer text.
 *
 * Handles the shapes a first message actually takes:
 *  - plain prose            -> first line, whitespace collapsed
 *  - a slash invocation     -> the argument if given, else the slug itself
 *                              ("/ingest-deep Notes/x" -> "Notes/x",
 *                               "/daily-briefing" -> "daily briefing")
 *  - text with an injected  -> the context block is dropped, never named after
 *    <context> block           the active file
 *
 * Returns '' when nothing usable remains; callers must not write an empty title.
 */
export function deriveTabTitleFromMessage(text: string, maxLen: number = MAX_TITLE_LEN): string {
    let s = (text ?? '').trim();
    if (!s) return '';

    // An active-file context block is machinery, not intent.
    s = s.replace(/<context>[\s\S]*?<\/context>/g, ' ');

    // Slash invocation: the slug (or its argument) carries the intent. Only the
    // first line matters -- a pasted multi-line body after the command does not
    // describe the task better than the command does.
    if (s.startsWith('/')) {
        const firstLine = s.split('\n')[0] ?? '';
        const sp = firstLine.indexOf(' ');
        const slug = (sp === -1 ? firstLine.slice(1) : firstLine.slice(1, sp)).trim();
        const rest = sp === -1 ? '' : firstLine.slice(sp + 1).trim();
        s = rest || slug.replace(/[-_]+/g, ' ');
    }

    // First non-empty line, whitespace collapsed.
    s = (s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '';

    if (s.length <= maxLen) return s;
    const cut = s.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(' ');
    const base = lastSpace > maxLen / 2 ? cut.slice(0, lastSpace) : cut;
    return base.trimEnd() + '...';
}


/**
 * How many opening messages may still change the tab title.
 *
 * USER 2026-07-26: "bei neuen Chats dann nach den ersten 1-3 messages". A first
 * message is often a throwaway opener ("moin", "kurze frage") and the real
 * intent lands in the next one. After three the chat has an identity and
 * renaming it under the user would be worse than an imperfect name.
 */
export const TITLE_SETTLES_AFTER = 3;

/** A title too thin to identify a chat by: an opener, not an intent. */
function isWeakTitle(title: string): boolean {
    if (!title) return true;
    return title.split(/\s+/).filter(Boolean).length < 3;
}

/**
 * Best tab title from the opening user messages.
 *
 * The first usable candidate wins and then STAYS -- a title that keeps moving
 * while you read it is worse than a mediocre one. The single exception is an
 * opener too thin to identify anything ("moin", "kurze frage"), which steps
 * aside for the first substantial message within the settling window.
 *
 * Pure, so the rule can be argued with in a test rather than in the UI.
 */
export function pickTabTitle(userTexts: readonly string[]): string {
    const candidates = userTexts
        .slice(0, TITLE_SETTLES_AFTER)
        .map((t) => deriveTabTitleFromMessage(t))
        .filter((t) => t.length > 0);
    if (candidates.length === 0) return '';
    const first = candidates[0];
    if (!isWeakTitle(first)) return first;
    return candidates.find((c) => !isWeakTitle(c)) ?? first;
}
