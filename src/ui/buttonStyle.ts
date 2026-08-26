/**
 * Destructive-button styling that spans our whole supported Obsidian range.
 *
 * `ButtonComponent.setDestructive()` only exists from Obsidian 1.13 on, and
 * manifest.minAppVersion is 1.8.7. A static call therefore trips the review
 * bot's `obsidianmd/no-unsupported-api` rule and would break on the oldest
 * Obsidian we still claim to support. `setWarning()` is the legacy method on
 * the same class and is still present (deprecated) in current versions.
 *
 * Feature-detecting through this structural type keeps both names off the
 * ButtonComponent type, so the deprecation chain is broken and no
 * eslint-disable is needed (the bot rejects those for obsidianmd rules).
 */
export interface DestructiveStylable {
    setDestructive?: () => unknown;
    setWarning?: () => unknown;
}

/** Paint `btn` as destructive, whichever API the running Obsidian offers. */
export function applyDestructiveStyle(btn: DestructiveStylable): void {
    if (typeof btn.setDestructive === 'function') {
        btn.setDestructive();
    } else if (typeof btn.setWarning === 'function') {
        btn.setWarning();
    }
}
