/**
 * createSandboxExecutor
 *
 * Returns the sandbox execution backend. Since SBX-1 (Security Audit
 * 2026-07-05) this is the Chromium iframe sandbox on EVERY platform.
 *
 * Rationale: the former desktop backend (ProcessSandboxExecutor -- a Node
 * `vm` context inside a `child_process.fork()`) was NOT a security boundary.
 * A forked Node process runs with the user's full privileges, and `vm` is
 * documented as "not a security mechanism": untrusted skill code reached the
 * host realm via `Object.constructor('return process')()` and achieved host
 * RCE (fs/child_process/network), bypassing the SandboxBridge allowlist and
 * rate limits entirely (PoC confirmed).
 *
 * The iframe backend (opaque origin, `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, CSP `default-src 'none'`, plugin-side `event.source`
 * authentication, bridge as the only channel) is enforced by Chromium
 * identically on Mac / Windows / Linux / mobile. It has functional parity
 * with the old backend: the same `ISandboxExecutor` contract, the same
 * esbuild-compiled JS input, and the same `SandboxBridge` (vault API +
 * requestUrl allowlist + rate limits). So switching the default breaks no
 * legitimate skill (which only ever touches the bridge API) while removing
 * the escape.
 *
 * The `mode` parameter is retained for `settings.sandboxMode` back-compat.
 * The deprecated `'process'` value no longer routes to the vm backend.
 *
 * AUDIT 2026-07-26 M-10: "left in the tree but no longer bundled" was only
 * half true. The class was unreachable, but the worker it forks was still
 * compiled and its full source still shipped inside main.js as a string that
 * ensureRuntimeWorker can write to disk. Both are now deleted, so the
 * escapable path cannot be resurrected by a future caller.
 *
 * See ADR-021 (superseded on the isolation mechanism) and the 2026-07-05
 * security audit (SBX-1).
 */

import type ObsidianAgentPlugin from '../../main';
import type { ISandboxExecutor } from './ISandboxExecutor';
import { IframeSandboxExecutor } from './IframeSandboxExecutor';

export function createSandboxExecutor(
    plugin: ObsidianAgentPlugin,
    mode: 'auto' | 'process' | 'iframe' = 'auto',
): ISandboxExecutor {
    // SBX-1: the Chromium iframe sandbox is the security boundary on every
    // platform. `mode` (incl. the deprecated 'process') is intentionally not
    // used to select a backend anymore -- the vm process path was escapable.
    void mode;
    return new IframeSandboxExecutor(plugin);
}
