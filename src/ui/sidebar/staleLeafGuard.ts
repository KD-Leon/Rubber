/**
 * FIX-22-07-02: guard for the FEATURE-2208 stale-leaf rebuild.
 *
 * After a plugin hot-reload (e.g. BRAT update) Obsidian keeps sidebar
 * leaves whose view instance stems from the OLD plugin's class (or is a
 * deferred placeholder) -- those need the empty-cycle rebuild to get a
 * fresh DOM. A view constructed by the CURRENT plugin instance is never
 * stale; cycling it destroys whatever the user is doing in it (live
 * chats included, when the user interacts during a slow boot).
 */
export function shouldRebuildSidebarLeaf(
    view: unknown,
    currentViewClass: abstract new (...args: never[]) => unknown,
): boolean {
    return !(view instanceof currentViewClass);
}
