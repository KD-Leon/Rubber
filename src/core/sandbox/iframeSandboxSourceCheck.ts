/**
 * Pure helper used by IframeSandboxExecutor for postMessage authentication.
 *
 * AUDIT-038 ISSUE-005: the temporary `sandbox-ready` handler in
 * IframeSandboxExecutor.initialize() used to accept any message with the
 * right `type`, without verifying that event.source pointed at our own
 * iframe's contentWindow. The steady-state handler did the check; the
 * init handler did not. A spoofed `sandbox-ready` from another renderer
 * context could complete initialization on the wrong frame.
 *
 * Extracted as a pure function so the check can be unit-tested in a
 * node environment (the rest of IframeSandboxExecutor depends on the
 * browser DOM via Obsidian's runtime).
 */

/**
 * Returns true iff the message event came from the iframe we expect.
 *
 * Before the iframe has been created (`expectedSource === null`) the
 * check returns `false` -- nothing should be accepted before there is
 * a frame to authenticate against. This matches the steady-state
 * handler behaviour where `event.source !== this.iframe?.contentWindow`
 * also evaluates to a rejection when the iframe is null.
 */
export function isFromOwnSandboxFrame(
    event: { source: unknown },
    expectedSource: unknown,
): boolean {
    if (expectedSource === null || expectedSource === undefined) return false;
    return event.source === expectedSource;
}
