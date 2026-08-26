/**
 * denyZoneFilter -- keep the deny zone out of enumeration results.
 *
 * AUDIT 2026-07-26 M-7 (CWE-668). `query_base`, `list_files`, `search_by_tag`,
 * `get_vault_stats`, `get_linked_notes` and `generate_canvas` walk the whole
 * vault index and never consulted IgnoreService. A user who put `Private/` in
 * `.obsidian-agentignore` still had those paths, and their frontmatter values,
 * handed to the model.
 *
 * A thin wrapper over `ignoreService.isIgnored`, deliberately inventing no new
 * predicate. Its value is that the three rules below are written down once
 * instead of being rediscovered at each of six call sites.
 *
 * RULE 1 -- filter at COLLECTION time, before any count.
 * "N of M matching notes", "N more not shown", "Notes: N", `count="N"`: every
 * one of those numbers, computed over the unfiltered set, publishes the SIZE of
 * the deny zone even when the names are hidden. Hiding the rows and keeping the
 * count is not a partial fix, it is the leak with extra steps.
 *
 * RULE 2 -- filter before any limit, cap or slice.
 * A denied entry that consumes a result slot turns the limit into an oracle:
 * shrink `limit`, count the missing slots, and you have measured the hidden
 * notes without ever seeing one.
 *
 * RULE 3 -- no permissive fallback.
 * There is no `if (!ignoreService) return items` branch here. `ignoreService` is
 * non-optional on the plugin and IgnoreService is fail-closed by construction
 * (it denies everything until its rules have loaded). If it were ever absent,
 * the TypeError lands in the calling tool's existing catch and the tool reports
 * an error -- which is the correct outcome. A permissive branch would
 * reintroduce exactly the class this closes.
 */

import type ObsidianAgentPlugin from '../../../main';

/** True when the user's deny zone covers this vault-relative path. */
export function isDeniedPath(plugin: ObsidianAgentPlugin, path: string): boolean {
    return plugin.ignoreService.isIgnored(path);
}

/**
 * Drop every denied item. `pathOf` extracts the vault-relative path.
 *
 * Use at the point of collection, never just before rendering -- see rules 1
 * and 2 above.
 */
export function keepVisible<T>(
    plugin: ObsidianAgentPlugin,
    items: readonly T[],
    pathOf: (item: T) => string,
): T[] {
    const ignoreService = plugin.ignoreService;
    return items.filter((item) => !ignoreService.isIgnored(pathOf(item)));
}
