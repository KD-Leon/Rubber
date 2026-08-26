/**
 * commandAllowlist -- which Obsidian commands the agent may run.
 *
 * AUDIT 2026-07-26 M-8 (CWE-250). `execute_command` ran ANY registered command
 * with no allowlist at all, under the weak `skill` effect class. Obsidian
 * commands are contributed by every installed plugin, so the reachable set is
 * whatever the user happens to have installed -- and on a vault with a
 * Shell-Commands-style plugin, "run any command" is "run any shell command".
 *
 * WHY AN ALLOWLIST AND NOT AN EFFECT CLASS
 *
 * Re-pinning `execute_command` to `sandbox` was considered and rejected. The
 * effect class answers "should the user be asked?"; it cannot answer "is this
 * third-party command safe?", because nothing about the class knows what the
 * command does. Those are different questions, so this gate lives in the TOOL,
 * before the sink, and TOOL_EFFECTS is untouched. A command that is not on the
 * list does not run no matter what the approval path answers -- preset,
 * category toggle, run or session grant, headless policy, or a person clicking
 * Allow on a card.
 *
 * WHY A DENYLIST WOULD NOT DO
 *
 * The command space is unbounded and third-party. You cannot enumerate what is
 * dangerous in a set you do not control.
 *
 * WHY ENROLMENT HAPPENS IN SETTINGS, NOT FROM A CARD
 *
 * This deliberately differs from the per-host consent that M-5 added for
 * web_fetch, and the difference is the point. A host grant only changes WHEN
 * web_fetch skips a card; it could always reach any host. Here the list IS the
 * capability boundary, so letting one card click -- on a command id the agent
 * itself chose -- add an arbitrary third-party command forever would reduce the
 * allowlist to a one-time prompt and let the agent drive its own capability
 * expansion. That is the shape ADR-153 closed for `apply_preset permissive`.
 *
 * Pure and free of Obsidian imports so the tool, the approval gate, the
 * settings surface and the tests all resolve the same answer.
 */

export interface AllowedCommand {
    id: string;
    /** Why this is safe enough to ship enabled. Read by the next reviewer. */
    reason: string;
}

export type CommandAllowance = 'builtin' | 'user' | 'denied';

/**
 * Tier 1: commands the plugin's own tools and prompts steer the agent towards.
 * Adding an entry is a deliberate, reviewed decision, the same discipline
 * ALLOWED_BINARIES applies to spawnable binaries.
 */
export const BUILT_IN_COMMAND_ALLOWLIST: readonly AllowedCommand[] = Object.freeze([
    {
        id: 'workspace:export-pdf',
        reason: 'Export the active note to PDF. Core Obsidian, and the tool metadata steers the agent here by name.',
    },
    {
        id: 'daily-notes:open',
        reason: 'Open or create today\'s daily note. Core Obsidian and the documented example in the tool schema. '
            + 'Noted for the next reviewer: creation runs the configured daily-note template, so on a vault where '
            + 'Templater is wired to the new-file trigger this reaches user-authored template code. Kept because '
            + 'the template is the user\'s own file and the flow is documented; revisit if that stops being true.',
    },
    {
        id: 'obsidian-excalidraw-plugin:excalidraw-autocreate-newtab',
        reason: 'Create a new Excalidraw drawing. CreateExcalidrawTool redirects here by exact id.',
    },
    {
        id: 'dbfolder:create-new-database-folder',
        reason: 'Create a DB Folder database. CreateBaseTool redirects here by exact id.',
    },
]);

/**
 * Deliberately NOT in tier 1: `templater-obsidian:insert-template`. Templater
 * templates execute user JavaScript, which is precisely the class this finding
 * is about. A user who wants it enrols it themselves.
 */

const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_COMMAND_ALLOWLIST.map((c) => c.id));

/**
 * A command the user enrolled, with enough context to notice tampering.
 *
 * The name is recorded because a command ID is not a capability: ids like
 * `obsidian-shellcommands:shell-command-0` are an index into a per-vault list,
 * and whatever the user puts in slot 0 later inherits the enrolment. Comparing
 * the display name at call time is cheap tamper-evidence for exactly that.
 */
export interface EnrolledCommand {
    id: string;
    /** The command's display name when it was enrolled. */
    name: string;
    /** Epoch ms, for the permissions surface. */
    at?: number;
}

/**
 * Decide whether `commandId` may run.
 *
 * `stored` comes from settings, i.e. from JSON that has been through a deep
 * merge with no runtime validation. It is treated as untrusted shape: anything
 * that is not an array of well-formed entries denies EVERYTHING rather than
 * being skipped. A malformed store must not read as "no restrictions".
 */
export function resolveCommandAllowance(
    commandId: string,
    stored: unknown,
    currentName?: string,
    disabledBuiltIns?: unknown,
): CommandAllowance {
    if (typeof commandId !== 'string' || commandId.length === 0) return 'denied';
    if (BUILT_IN_IDS.has(commandId)) {
        // USER 2026-07-26: the built-in tier is a default, not a decree. A user
        // who switches one off means it. Non-array input is ignored rather than
        // denying, because this store only ever REMOVES capability -- treating
        // junk as "everything off" would break the shipped flows for a typo.
        if (Array.isArray(disabledBuiltIns) && disabledBuiltIns.includes(commandId)) return 'denied';
        return 'builtin';
    }
    if (stored === undefined || stored === null) return 'denied';
    if (!Array.isArray(stored)) return 'denied';

    for (const raw of stored) {
        if (raw === null || typeof raw !== 'object') continue;
        const entry = raw as Partial<EnrolledCommand>;
        if (entry.id !== commandId) continue;
        // Tamper-evidence: an id whose command now carries a different name is
        // not the command that was enrolled. Missing/unknown name on either
        // side is not treated as a mismatch, so an older entry keeps working.
        if (
            typeof entry.name === 'string' && entry.name.length > 0
            && typeof currentName === 'string' && currentName.length > 0
            && entry.name !== currentName
        ) {
            return 'denied';
        }
        return 'user';
    }
    return 'denied';
}

/** Enrolled commands, normalised. Malformed entries are dropped. */
export function listEnrolledCommands(stored: unknown): EnrolledCommand[] {
    if (!Array.isArray(stored)) return [];
    const out: EnrolledCommand[] = [];
    for (const raw of stored) {
        if (raw === null || typeof raw !== 'object') continue;
        const e = raw as Partial<EnrolledCommand>;
        if (typeof e.id !== 'string' || e.id.length === 0) continue;
        out.push({ id: e.id, name: typeof e.name === 'string' ? e.name : '', at: e.at });
    }
    return out;
}

/** The reason a built-in entry is allowed, for the settings surface. */
export function builtInReason(commandId: string): string | undefined {
    return BUILT_IN_COMMAND_ALLOWLIST.find((c) => c.id === commandId)?.reason;
}
