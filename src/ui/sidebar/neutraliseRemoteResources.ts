/**
 * neutraliseRemoteResources -- stop chat markdown from firing outbound requests.
 *
 * AUDIT 2026-07-26 H-5. Everything rendered into the chat is untrusted by this
 * project's own threat model: tool results carry vault notes, fetched web pages
 * and MCP responses, and "every byte of LLM output is treated as untrusted"
 * (REVIEWER_NOTES). Markdown image syntax and raw resource tags turn that text
 * into AUTO-LOADING resources, so a prepared note only has to be read for the
 * renderer to make a request to an attacker-chosen URL, with vault content in
 * the query string. No click, no approval, no tool call.
 *
 * The fix has to happen on the STRING, before MarkdownRenderer runs. Sweeping
 * the DOM afterwards does not help: an <img> begins fetching the moment its src
 * is assigned, whether or not the node is attached, hidden, or inside a closed
 * <details>. By the time a post-render pass could remove it, the request is out.
 *
 * What this does NOT do: it is not an HTML sanitiser and does not try to be one.
 * It removes the auto-loading property of remote references and leaves the
 * content visible, so nothing is silently swallowed:
 *   - a remote image becomes an ordinary link the user can choose to open
 *   - a resource-loading HTML tag renders as literal text
 * Vault-internal embeds (![[note]]) are untouched: they resolve inside the vault
 * and reach no network.
 *
 * Pure and side-effect free so the behaviour is unit testable.
 *
 * Architecture-map concept: chat-render-egress-guard
 */

/** Schemes that reach the network when a resource is loaded. */
const REMOTE_SCHEME = /^(?:https?:|\/\/)/i;

/**
 * HTML tags that fetch a resource by themselves. Escaped to literal text rather
 * than removed, so the user still sees what the content tried to do.
 */
const RESOURCE_TAG = /<(\/?)(img|iframe|embed|object|video|audio|source|track|link|script|style|picture|svg|use)\b/gi;

/**
 * Inline image with a remote target: `![alt](https://host/x.png "title")`.
 * Captures the alt text and the whole target so the link form can keep both.
 * The target may be wrapped in <>, and may carry a title after whitespace.
 */
const INLINE_IMAGE = /!\[([^\]]*)\]\(\s*(<?)([^)\s]+)(>?)((?:\s+[^)]*)?)\)/g;

/** Reference-style image: `![alt][ref]`. The URL lives in a link definition. */
const REFERENCE_IMAGE = /!\[([^\]]*)\]\[([^\]]*)\]/g;

/**
 * CSS `url(...)` with a remote target.
 *
 * AUDIT-2026-08-14 H-2: the tag list above cannot catch this one. The host of a
 * `style="background-image:url(...)"` is an ordinary <div>, and DOMPurify does
 * not help either -- the tool-steps config forbids the style TAG while `style`
 * sits in DOMPurify's default attribute allowlist and in its URI-safe set, so
 * the declaration survives sanitisation and fires the same zero-click request.
 * Matched on the string like everything else here, because the fetch starts as
 * soon as the style is applied.
 */
const CSS_REMOTE_URL = /url\(\s*(['"]?)((?:https?:|\/\/)[^)'"\s]+)\1\s*\)/gi;

/**
 * Neutralise auto-loading remote references in untrusted markdown.
 *
 * Returns the markdown unchanged when there is nothing to neutralise, so the
 * common case costs one regex scan and no allocation.
 */
export function neutraliseRemoteResources(markdown: string): string {
    if (!markdown) return markdown;

    let out = markdown.replace(INLINE_IMAGE, (match, alt: string, open: string, target: string, close: string, tail: string) => {
        // Vault-relative and data: targets do not reach the network. Leave them
        // alone so ordinary attachments still render.
        if (!REMOTE_SCHEME.test(target)) return match;
        // Drop the leading '!' only: the link stays visible and clickable, the
        // renderer just no longer fetches it on its own.
        return `[${alt}](${open}${target}${close}${tail})`;
    });

    // A reference image cannot be resolved here (the definition may appear
    // later), so treat every reference image as potentially remote.
    out = out.replace(REFERENCE_IMAGE, (_m, alt: string, ref: string) => `[${alt}][${ref}]`);

    // Raw resource tags become literal text.
    out = out.replace(RESOURCE_TAG, (_m, slash: string, tag: string) => `&lt;${slash}${tag}`);

    // A remote CSS url() loses its url() wrapper, so the declaration stops
    // resolving to a request. The address stays readable, matching the rule
    // this module follows everywhere: neutralise the auto-load, hide nothing.
    out = out.replace(CSS_REMOTE_URL, (_m, _q: string, target: string) => `neutralised-url:${target}`);

    return out;
}
