/**
 * Source-link classification for chat citations.
 *
 * The [sources] block (see prompts/sections/responseFormat.ts) is documented
 * for vault notes as [[Note Name]]. When the agent researches on the web it
 * cites URLs instead. Both flow through parseSources into `source.note`, and
 * the click handlers used to pass every value to `openLinkText`. For a URL,
 * Obsidian tries to resolve it as a note path and throws
 * "File name cannot contain any of the following characters: \ / :".
 *
 * `resolveSourceTarget` is the single, pure decision point: it turns a source
 * string into either a vault link (open via openLinkText) or an external URL
 * (open in the browser). Kept free of Obsidian/Electron imports so it stays
 * unit-testable; the side-effecting opener lives in `openExternalUrl` below.
 */

export type SourceTarget =
    | { kind: 'vault'; linkText: string; display: string }
    | { kind: 'external'; url: string; display: string };

/** [title](target) -- title may be empty, target must be non-empty. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]+)\)/;
/** [[target|alias]] -- alias optional. */
const WIKILINK = /\[\[([^\]]+)\]\]/;
/**
 * External only for a SAFE web scheme (http, https, mailto) or a leading
 * `www.`. Audit M-1 (2026-07-29): the source string is UNTRUSTED LLM output;
 * a citation like `[[file:///…]]`, `[[javascript:…]]`, `[[smb://…]]` or a
 * registered protocol handler must NOT be classified as external, or it would
 * reach `shell.openExternal` and open a local file / launch a handler / (on
 * Windows) leak an NTLM hash. Any other scheme falls through to the vault
 * branch, where `openLinkText` safely rejects it (opens nothing). A bare
 * `example.com` stays a vault link on purpose: note names contain dots
 * (e.g. README.md) and must not misroute to the browser.
 */
const SAFE_EXTERNAL_SCHEME = /^(?:https?|mailto):/i;
const WWW_HOST = /^www\./i;

function isExternalUrl(target: string): boolean {
    return SAFE_EXTERNAL_SCHEME.test(target) || WWW_HOST.test(target);
}

function normaliseUrl(target: string): string {
    return WWW_HOST.test(target) ? `https://${target}` : target;
}

/**
 * Classify a source note string. Recognises, in order: a markdown link
 * `[title](url)`, a wikilink `[[target|alias]]`, a bare URL, and finally a
 * plain vault note name.
 */
export function resolveSourceTarget(note: string): SourceTarget {
    const raw = note.trim();

    const md = MARKDOWN_LINK.exec(raw);
    if (md) {
        const title = md[1].trim();
        const target = md[2].trim();
        if (isExternalUrl(target)) {
            return { kind: 'external', url: normaliseUrl(target), display: title || target };
        }
        return { kind: 'vault', linkText: target, display: title || target };
    }

    const wl = WIKILINK.exec(raw);
    if (wl) {
        const [target, alias] = wl[1].split('|');
        const linkText = target.trim();
        const display = (alias ?? target).trim();
        // Review F1: web citations arrive wrapped in [[...]] because the
        // sources template (responseFormat.ts) only ever shows the vault form
        // [[Note Name]]. A URL must still open in the browser, not via
        // openLinkText (which treats it as a note path and throws). Same URL
        // detection as the markdown-link branch above.
        if (isExternalUrl(linkText)) {
            return { kind: 'external', url: normaliseUrl(linkText), display };
        }
        return { kind: 'vault', linkText, display };
    }

    if (isExternalUrl(raw)) {
        return { kind: 'external', url: normaliseUrl(raw), display: raw };
    }

    return { kind: 'vault', linkText: raw, display: raw };
}

/**
 * Open an external URL in the OS browser. Prefers Electron's shell (desktop),
 * falls back to `window.open` (mobile / no Electron). Mirrors the pattern in
 * AgentSettingsTab.openHelpUrl and ProviderDetailModal.
 */
export function openExternalUrl(url: string): void {
    // Audit M-1 defense in depth: never hand a non-web scheme to the OS
    // opener, even if a future caller bypasses resolveSourceTarget's
    // classification. Only http(s)/mailto reach shell.openExternal.
    if (!SAFE_EXTERNAL_SCHEME.test(url)) return;
    const electron = (window as unknown as {
        require?: (m: string) => { shell?: { openExternal(u: string): unknown } };
    }).require?.('electron');
    if (electron?.shell?.openExternal) {
        void electron.shell.openExternal(url);
        return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}
