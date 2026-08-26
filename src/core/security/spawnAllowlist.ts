/**
 * spawnAllowlist -- centralised child_process wrapper with a hard binary allowlist.
 *
 * Every `child_process.spawn` and `spawnSync` call in the plugin must go through
 * this module. Direct `cp.spawn(...)`, `cp.spawnSync(...)`, and especially
 * `cp.exec(...)`, `cp.execSync(...)` are forbidden outside this file and its tests.
 *
 * Each allowlist entry answers three questions, not one (IMP-28-02-01):
 *
 * 1. WHICH binary -- the `path.basename` of the command must be an own entry.
 * 2. HOW it may be named -- `bare` means a name resolved via PATH and nothing
 *    else; `absolute` additionally accepts a fully resolved path, because that
 *    binary is looked up via `which`/`where` before it is launched. A relative
 *    path is refused for every entry: recipes run with `cwd` = vault root, so
 *    `./node` would resolve inside the directory the agent can write to.
 * 3. WHICH arguments it may carry -- deciding on the binary alone let the argv
 *    through untouched, and for these binaries the argv is where the power is
 *    (`node script.js`, `pandoc --lua-filter`, `soffice macro:///`).
 *
 * `shell: true` is rejected. `cp.exec`/`cp.execSync` are not re-exported -- they
 * accept a shell string and have no place in a sandboxed agent plugin.
 *
 * See REVIEWER_NOTES.md and FEAT-27-02-spawn-allowlist.md for the threat model.
 */

/* eslint-disable @typescript-eslint/no-require-imports, security/detect-child-process -- this is the *one* file that owns the child_process module wrapper; all other call sites go through this wrapper */

import type * as CpModule from 'child_process';
import * as path from 'path';

let cpImpl: typeof CpModule | null = null;
function cp(): typeof CpModule {
    if (!cpImpl) {
        cpImpl = require('child_process') as typeof CpModule;
    }
    return cpImpl;
}

/**
 * How a command may name its binary. `bare` is the stricter rule that
 * `assertStdioCommandAllowed` has always applied to stdio commands; it holds
 * for every binary the plugin launches by name only.
 */
export type CommandForm = 'bare' | 'absolute';

/**
 * Verdict of an argument predicate: `null` when the argv is allowed, otherwise
 * the reason it is refused (goes into the error message, so a caller that hits
 * a new argument shape learns what the rule was).
 */
export type ArgsVerdict = string | null;

export interface BinaryPolicy {
    /** Why the plugin needs this binary at all. */
    reason: string;
    /** Whether a resolved absolute path is accepted, or only a bare name. */
    form: CommandForm;
    /** Which argv this binary may carry. */
    args: (args: readonly string[]) => ArgsVerdict;
}

/** A binary that exists in the list for another gate and is never spawned here. */
const NEVER_SPAWNED = (): ArgsVerdict =>
    'this entry exists for the stdio gate only, it is never spawned through this wrapper';

/** node is launched for exactly one purpose today: asking it for its version. */
const VERSION_PROBE_ONLY = (args: readonly string[]): ArgsVerdict =>
    args.length === 1 && (args[0] === '--version' || args[0] === '-v')
        ? null
        : 'only a version probe (--version) is allowed';

/** which/where take one program name -- the same charset the recipes validate. */
const PROGRAM_NAME_RE = /^[A-Za-z0-9._-]+$/;
const ONE_PROGRAM_NAME = (args: readonly string[]): ArgsVerdict => {
    if (args.length !== 1) return 'expects exactly one argument, the program name';
    if (!PROGRAM_NAME_RE.test(args[0])) return `"${args[0]}" is not a bare program name`;
    return null;
};

/**
 * LibreOffice: a headless conversion, or a version probe. Its argv is where the
 * code execution lives -- `macro:///Standard.Module.Main` and
 * `vnd.sun.star.script:` run Basic, so URI arguments are refused and every
 * option must be one the conversion pipeline actually passes.
 */
const OFFICE_FLAGS: ReadonlySet<string> = new Set([
    '--headless', '--convert-to', '--outdir', '--norestore', '--nolockcheck',
    '--nodefault', '--invisible', '--version',
]);
// Two or more scheme characters, so a Windows drive letter ("C:") is not a URI.
const URI_ARG_RE = /^[a-z][a-z0-9+.-]+:/i;
const OFFICE_ARGS = (args: readonly string[]): ArgsVerdict => {
    if (args.length === 1 && args[0] === '--version') return null;
    if (args[0] !== '--headless') return 'expects --version alone or a --headless conversion';
    for (const arg of args) {
        if (arg.startsWith('-')) {
            if (!OFFICE_FLAGS.has(arg)) return `option "${arg}" is not part of a headless conversion`;
            continue;
        }
        if (URI_ARG_RE.test(arg)) return `URI argument "${arg}" is refused (macro:/// runs code)`;
    }
    return null;
};

/** The tunnel points at the local MCP bridge, never at somebody else's host. */
const LOOPBACK_URL_RE = /^https?:\/\/127\.0\.0\.1:\d{1,5}\/?$/;
const CLOUDFLARED_ARGS = (args: readonly string[]): ArgsVerdict => {
    if (args[0] !== 'tunnel') return 'only the "tunnel" subcommand is allowed';
    for (let i = 1; i < args.length; i++) {
        if (args[i] !== '--url') return `option "${args[i]}" is not allowed for a tunnel`;
        const url = args[++i];
        if (url === undefined || !LOOPBACK_URL_RE.test(url)) {
            return `--url must point at a loopback port, not "${String(url)}"`;
        }
    }
    return null;
};

/**
 * pandoc runs the recipe templates. Its converting flags are open (a custom
 * recipe may legitimately pass `-t`, `--toc`, `--standalone`), but the flags
 * that make pandoc execute code are not: lua filters, external filters, custom
 * writers and defaults files all name something that then runs. `--pdf-engine`
 * names another binary, so its value is pinned to the known engines.
 */
const PANDOC_CODE_FLAGS: ReadonlySet<string> = new Set([
    '--lua-filter', '--filter', '-F', '--custom-writer', '--defaults', '-d',
]);
const PANDOC_ENGINES: ReadonlySet<string> = new Set([
    'pdflatex', 'xelatex', 'lualatex', 'tectonic', 'latexmk', 'context',
    'wkhtmltopdf', 'weasyprint', 'prince', 'typst', 'pdfroff', 'groff',
]);
const PANDOC_ARGS = (args: readonly string[]): ArgsVerdict => {
    let positionalOnly = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // `--` ends option parsing for pandoc too: everything after it is a path.
        if (positionalOnly) continue;
        if (arg === '--') { positionalOnly = true; continue; }
        const eq = arg.indexOf('=');
        const name = arg.startsWith('--') && eq > -1 ? arg.slice(0, eq) : arg;
        if (PANDOC_CODE_FLAGS.has(name)) return `option "${name}" makes pandoc run code`;
        if (name === '--pdf-engine') {
            const engine = eq > -1 ? arg.slice(eq + 1) : args[++i];
            if (engine === undefined || !PANDOC_ENGINES.has(engine)) {
                return `--pdf-engine must name a known engine, not "${String(engine)}"`;
            }
            continue;
        }
        if (/\.lua$/i.test(arg)) return `"${arg}" is a lua script, pandoc may not load it`;
    }
    return null;
};

/**
 * Binaries the plugin is allowed to spawn. Adding a new entry, widening a
 * `form`, or loosening an argument predicate is a deliberate decision and must
 * be reviewed. Removing one is the same discipline: `git` used to sit here for
 * vault checkpoints, which have always run on isomorphic-git (pure JS), so the
 * entry granted a spawn nothing asked for (IMP-28-02-01).
 */
export const ALLOWED_BINARIES: Readonly<Record<string, BinaryPolicy>> = Object.freeze({
    // AUDIT 2026-07-26 M-10: the reason used to name the sandbox worker
    // process, which no longer exists. node stays because the MCP settings tab
    // probes a Node runtime for stdio MCP servers (FEAT-04-13); the candidates
    // it probes are absolute paths from which/PATH defaults.
    node: { reason: 'node runtime probe for stdio MCP servers (FEAT-04-13)', form: 'absolute', args: VERSION_PROBE_ONLY },
    'node.exe': { reason: 'node runtime probe on Windows (FEAT-04-13)', form: 'absolute', args: VERSION_PROBE_ONLY },
    // npx is launched by the MCP SDK's StdioClientTransport, not here. The entry
    // keeps STDIO_ALLOWED_COMMANDS a subset of this list (one source of truth),
    // so the spawn predicate refuses everything.
    npx: { reason: 'stdio MCP servers launched via npx by the MCP SDK (FEAT-04-13)', form: 'bare', args: NEVER_SPAWNED },
    'npx.cmd': { reason: 'npx on Windows (stdio MCP servers, FEAT-04-13)', form: 'bare', args: NEVER_SPAWNED },
    which: { reason: 'Binary discovery on Unix', form: 'absolute', args: ONE_PROGRAM_NAME },
    where: { reason: 'Binary discovery on Windows', form: 'absolute', args: ONE_PROGRAM_NAME },
    'where.exe': { reason: 'Binary discovery on Windows', form: 'absolute', args: ONE_PROGRAM_NAME },
    soffice: { reason: 'LibreOffice headless conversion (pptxRenderer)', form: 'absolute', args: OFFICE_ARGS },
    'soffice.exe': { reason: 'LibreOffice headless conversion on Windows', form: 'absolute', args: OFFICE_ARGS },
    'soffice.bin': { reason: 'LibreOffice headless conversion (Linux variant)', form: 'absolute', args: OFFICE_ARGS },
    libreoffice: { reason: 'LibreOffice headless conversion alias', form: 'absolute', args: OFFICE_ARGS },
    'libreoffice.exe': { reason: 'LibreOffice headless conversion alias on Windows', form: 'absolute', args: OFFICE_ARGS },
    cloudflared: { reason: 'Remote MCP tunnel (McpBridge.startTunnel)', form: 'bare', args: CLOUDFLARED_ARGS },
    'cloudflared.exe': { reason: 'Remote MCP tunnel on Windows', form: 'bare', args: CLOUDFLARED_ARGS },
    pandoc: { reason: 'Pandoc document conversion (ExecuteRecipeTool built-in recipes)', form: 'absolute', args: PANDOC_ARGS },
    'pandoc.exe': { reason: 'Pandoc on Windows', form: 'absolute', args: PANDOC_ARGS },
});

/**
 * Shell metacharacters refused in a command. Exported because REVIEWER_NOTES.md
 * quotes this regex to reviewers and a drift test compares the two
 * (FIX-28-03-01).
 */
export const SHELL_METACHARS = /[;&|`$<>(){}\\\n\r]/;

/**
 * AUDIT-034 R2/R3: the commands a stdio MCP server may launch (FEAT-04-13 MVP).
 * A strict subset of ALLOWED_BINARIES: node/npx only. Kept here (not in
 * McpClient) so the restriction is one source of truth and the stdio path and
 * the child_process wrapper cannot drift apart.
 */
export const STDIO_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
    'node', 'node.exe', 'npx', 'npx.cmd',
]);

export class SpawnNotAllowed extends Error {
    constructor(
        public readonly attemptedBinary: string,
        public readonly allowedBinaries: string[],
    ) {
        super(
            `spawnAllowlist: binary "${attemptedBinary}" is not allowed. ` +
            `Allowed: ${allowedBinaries.join(', ')}`,
        );
        this.name = 'SpawnNotAllowed';
    }
}

/**
 * The binary is allowed, the arguments are not. A subclass so every existing
 * caller that catches SpawnNotAllowed keeps catching this too (IMP-28-02-01).
 */
export class SpawnArgsNotAllowed extends SpawnNotAllowed {
    constructor(
        binary: string,
        public readonly rejectionReason: string,
    ) {
        super(binary, Object.keys(ALLOWED_BINARIES));
        this.name = 'SpawnArgsNotAllowed';
        this.message = `spawnAllowlist: binary "${binary}" may not be spawned with these arguments: ${rejectionReason}`;
    }
}

/** Own entries only -- `constructor`, `toString` and friends are not binaries. */
function policyFor(basename: string): BinaryPolicy | null {
    return Object.prototype.hasOwnProperty.call(ALLOWED_BINARIES, basename)
        ? ALLOWED_BINARIES[basename]
        : null;
}

function isAbsoluteCommand(command: string): boolean {
    // Backslashes never reach here (SHELL_METACHARS refuses them), so the
    // Windows forms are the drive-letter ones with a forward slash.
    return command.startsWith('/') || /^[A-Za-z]:\//.test(command);
}

/**
 * The full gate for one spawn: binary, command form, arguments. Exported so the
 * rules can be exercised without launching anything (IMP-28-02-01).
 * Throws SpawnNotAllowed / SpawnArgsNotAllowed on violation, returns the
 * command on success.
 */
export function assertSpawnAllowed(command: string, args: readonly string[] = []): string {
    if (typeof command !== 'string' || command.length === 0) {
        throw new SpawnNotAllowed(String(command), Object.keys(ALLOWED_BINARIES));
    }
    if (SHELL_METACHARS.test(command)) {
        throw new SpawnNotAllowed(command, Object.keys(ALLOWED_BINARIES));
    }
    const policy = policyFor(path.basename(command));
    if (!policy) {
        throw new SpawnNotAllowed(command, Object.keys(ALLOWED_BINARIES));
    }
    if (/\//.test(command)) {
        // A basename match is not enough: a relative command resolves against
        // the cwd (the vault root for recipes), and a binary the plugin only
        // ever launches by name has no business carrying a path at all.
        if (policy.form === 'bare' || !isAbsoluteCommand(command)) {
            throw new SpawnNotAllowed(command, Object.keys(ALLOWED_BINARIES));
        }
    }
    const rejection = policy.args(args);
    if (rejection !== null) {
        throw new SpawnArgsNotAllowed(command, rejection);
    }
    return command;
}

/**
 * AUDIT-034 R2/R3: gate the command of a stdio MCP server. This path spawns via
 * the MCP SDK's StdioClientTransport (cross-spawn, shell:false), NOT through
 * spawnAllowed, so this guard is what enforces the policy the SDK spawn cannot:
 *
 * - the command must be one of STDIO_ALLOWED_COMMANDS (node/npx MVP), a strict
 *   subset of the general allowlist -- an allowlisted-but-unrelated binary
 *   (soffice, pandoc, ...) is NOT a valid stdio command;
 * - the command must be a bare name with NO path separator, so a basename spoof
 *   like `/tmp/evil/node` (R3) cannot pass by matching only the basename;
 * - no shell metacharacters, mirroring assertSpawnAllowed for defence in depth.
 *
 * Args are intentionally NOT metachar-filtered: the SDK spawns with shell:false,
 * so args are literal argv (a URL arg may legitimately contain `&`, `?`, `$`).
 * Throws SpawnNotAllowed on violation; returns void on success.
 */
export function assertStdioCommandAllowed(command: string): void {
    const allowed = [...STDIO_ALLOWED_COMMANDS];
    if (typeof command !== 'string' || command.trim().length === 0) {
        throw new SpawnNotAllowed(String(command), allowed);
    }
    if (SHELL_METACHARS.test(command)) {
        throw new SpawnNotAllowed(command, allowed);
    }
    // Reject any path separator: the command must be a bare binary name resolved
    // via PATH, never a caller-chosen absolute/relative path (R3 basename spoof).
    if (/[\\/]/.test(command)) {
        throw new SpawnNotAllowed(command, allowed);
    }
    if (!STDIO_ALLOWED_COMMANDS.has(command.toLowerCase())) {
        throw new SpawnNotAllowed(command, allowed);
    }
}

function forceNoShell<T extends CpModule.SpawnOptions | CpModule.SpawnSyncOptions>(options: T | undefined): T {
    const opts = { ...(options ?? ({} as T)) } as T & { shell?: boolean | string };
    if (opts.shell) {
        throw new SpawnNotAllowed('<shell:true forbidden>', Object.keys(ALLOWED_BINARIES));
    }
    opts.shell = false;
    return opts;
}

/**
 * Allowed wrapper around `child_process.spawn`. Throws SpawnNotAllowed if the
 * binary is not in the allowlist, the command contains shell metacharacters or
 * a path the binary may not carry, or `shell: true` is requested, and
 * SpawnArgsNotAllowed if the binary may not carry these arguments.
 */
export function spawnAllowed(command: string, args: readonly string[] = [], options?: CpModule.SpawnOptions): CpModule.ChildProcess {
    return cp().spawn(assertSpawnAllowed(command, args), [...args], forceNoShell(options));
}

/**
 * Allowed wrapper around `child_process.spawnSync`. Same restrictions as
 * spawnAllowed.
 */
export function spawnAllowedSync(command: string, args: readonly string[] = [], options?: CpModule.SpawnSyncOptions): CpModule.SpawnSyncReturns<Buffer | string> {
    return cp().spawnSync(assertSpawnAllowed(command, args), [...args], forceNoShell(options));
}

/** Test-only: list current allowlist. */
export function _allowedForTest(): string[] {
    return Object.keys(ALLOWED_BINARIES);
}

/* eslint-enable @typescript-eslint/no-require-imports, security/detect-child-process -- end of spawnAllowlist file scope (review-bot Tier 4: both disabled rules need matching enable) */
