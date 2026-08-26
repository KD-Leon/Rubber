/**
 * stdioTrustFingerprint -- bind a per-device stdio spawn trust to WHAT it trusted.
 *
 * AUDIT 2026-07-26 M-16. The per-device "Trust and run" confirmation was stored
 * as a bare server name, so it survived any later change to the command line:
 * confirm "npx @vendor/mcp" once, and a config edited afterwards to
 * "npx @attacker/thing" spawned under the same trust, with no second prompt.
 * The device-local config is not synced, but it is an ordinary file the user (or
 * anything running as the user) can edit, and the whole point of the
 * confirmation is that a human saw the command before it ran.
 *
 * The fingerprint covers exactly what determines the spawned process: the
 * command and its arguments. It deliberately does NOT cover env values -- those
 * hold secrets, are encrypted at rest, and change legitimately (token refresh).
 * Env VARIABLE NAMES are included, since adding a new one changes what the child
 * receives.
 *
 * Pure and dependency-free so it can be unit tested and reused by the settings
 * surface that lists what is trusted.
 */

/** Stable, order-insensitive-for-env fingerprint of a stdio command line. */
export function stdioTrustFingerprint(input: {
    command?: string;
    args?: string[];
    env?: Record<string, unknown>;
}): string {
    const command = (input.command ?? '').trim();
    const args = (input.args ?? []).map((a) => String(a));
    const envKeys = Object.keys(input.env ?? {}).sort();
    // JSON of a fixed shape: unambiguous separators, so ["a b"] and ["a","b"]
    // cannot collide the way a space-joined string would.
    return JSON.stringify({ command, args, envKeys });
}
