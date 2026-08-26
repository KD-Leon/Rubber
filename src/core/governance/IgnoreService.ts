/**
 * IgnoreService - File access governance (Sprint 1.6)
 *
 * Reads `.obsidian-agentignore` (gitignore syntax) and `.obsidian-agentprotected`
 * from the vault root to control which paths the agent can access.
 *
 * - Ignored paths: not accessible at all (like .gitignore)
 * - Protected paths: accessible for reading but NEVER writable (even with approval)
 *
 * Always blocks: .obsidian/ internals (except plugin files), .git/
 */

import type { Vault } from 'obsidian';
import { safeRegex } from '../utils/safeRegex';
import { isProtectedAgentConfigPath, isAgentSecretPath } from './agentFolderGuard';
import { foldPath } from './foldPath';

/**
 * Match a vault path against Obsidian's own "Excluded files" list
 * (`userIgnoreFilters` in app.json). Faithful to Obsidian's semantics so VO can
 * reuse the exclusions the user already maintains in Obsidian's UI:
 *
 * - A `/.../`-wrapped entry is a regex, applied case-insensitively (the `i`
 *   flag, as Obsidian does), over the normalised path. It is compiled through
 *   safeRegex so a hostile user regex degrades to a literal instead of hanging
 *   the renderer (AUDIT 2026-07-31 H-1 lesson: never RegExp untrusted input raw).
 * - Any other entry is a folder / path prefix: the path matches when it equals
 *   the entry or sits under it (`entry/...`). Both sides are case/unicode-folded
 *   like every other IgnoreService rule (APFS/NTFS same-file variants).
 *
 * Exported standalone so the matching semantics are unit-testable without a Vault.
 */
export function matchesObsidianExcluded(rawPath: string, filters: readonly string[]): boolean {
    if (!filters || filters.length === 0) return false;
    const normalized = (rawPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    const foldedPath = foldPath(normalized);
    for (const raw of filters) {
        const f = (raw ?? '').trim();
        if (!f) continue;
        if (f.length >= 2 && f.startsWith('/') && f.endsWith('/')) {
            // Regex filter: /pattern/ -> case-insensitive, ReDoS-guarded.
            const re = safeRegex(f.slice(1, -1), 'i');
            if (re.test(normalized)) return true;
            continue;
        }
        // Folder / path-prefix filter (case+unicode folded, leading/trailing slash stripped).
        const ff = foldPath(f.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
        if (!ff) continue;
        if (foldedPath === ff || foldedPath.startsWith(`${ff}/`)) return true;
    }
    return false;
}

export class IgnoreService {
    private vault: Vault;
    private ignorePatterns: string[] = [];
    private protectedPatterns: string[] = [];
    /** Obsidian's own "Excluded files" (app.json userIgnoreFilters), when the user opts to honour them. */
    private obsidianExcludedFilters: string[] = [];
    private respectObsidianExcluded = false;
    private loaded = false;

    /** Paths always blocked regardless of config (built from vault.configDir) */
    private alwaysBlocked: string[];

    /**
     * FIX-44-24: vault-relative agent folder root. When set, the agent's own
     * config zone (settings.json, mcp config, provenance manifest, cache -- i.e.
     * everything under the agent folder except skills/ and skill-data/) is
     * write-protected, so no vault tool can let the agent rewrite its own
     * settings and self-escalate. Empty string disables the check.
     */
    private agentRoot: string;

    /** Paths always write-protected regardless of config */
    private static readonly ALWAYS_PROTECTED: string[] = [
        '.obsidian-agentignore',
        '.obsidian-agentprotected',
    ];

    /** Vault config dir (`.obsidian`), lower-cased once for case-safe matching. */
    private readonly configDirLower: string;

    constructor(vault: Vault, agentRoot = '') {
        this.vault = vault;
        this.agentRoot = agentRoot;
        const configDir = vault.configDir;
        this.configDirLower = IgnoreService.fold(configDir);
        this.alwaysBlocked = [
            '.git/',
        ];
    }

    /**
     * AUDIT 2026-07-26 M-7: monotonic ruleset generation.
     *
     * The rule files are dotfiles and are NOT in Obsidian's file index, so
     * editing them fires no vault event. Any cache built from a filtered
     * enumeration therefore had no way to notice that the deny zone changed,
     * and kept serving a pre-rule view for the rest of the session. Callers key
     * their cache on this number instead of guessing from file events.
     */
    private generation = 0;

    /** Current ruleset generation. Changes whenever the rules are (re)loaded. */
    getGeneration(): number {
        return this.generation;
    }

    /** FIX-44-24: bind (or update) the agent folder root for config protection. */
    setAgentRoot(agentRoot: string): void {
        this.agentRoot = agentRoot;
    }

    /**
     * Load (or reload) ignore and protected patterns from vault root files.
     * Called at plugin start and can be re-called if files change.
     */
    async load(respectObsidianExcluded = false): Promise<void> {
        // AUDIT 2026-07-26 H-4: fail-closed on a read failure. `loaded` stays
        // false, so isIgnored/isProtected keep denying everything instead of
        // running with a silently empty ruleset. Both files are read before
        // either is assigned, so a failure on the second one cannot leave the
        // service half-configured.
        try {
            const ignorePatterns = await this.readPatternFile('.obsidian-agentignore');
            const protectedPatterns = await this.readPatternFile('.obsidian-agentprotected');
            // Obsidian's own "Excluded files" (app.json userIgnoreFilters) are
            // folded into the ignore gate ONLY when the user opted in, so the
            // exclusions maintained in Obsidian's UI apply to VO too without a
            // second list. readObsidianExcludedFilters fails OPEN (returns []),
            // never closed: a malformed app.json must not lock the user out --
            // .obsidian-agentignore stays the authoritative deny source.
            const obsidianExcluded = respectObsidianExcluded
                ? await this.readObsidianExcludedFilters()
                : [];
            this.ignorePatterns = ignorePatterns;
            this.protectedPatterns = protectedPatterns;
            this.obsidianExcludedFilters = obsidianExcluded;
            this.respectObsidianExcluded = respectObsidianExcluded;
            this.loaded = true;
            // Bumped AFTER the rules are in place, so a cache that reads the
            // generation and then rebuilds cannot capture the old ruleset.
            this.generation += 1;
        } catch (e) {
            this.loaded = false;
            console.error(
                '[IgnoreService] Could not read the ignore/protected rules; staying fail-closed '
                + '(every vault path is denied until this succeeds). Cause:',
                e,
            );
        }
    }

    /**
     * Check if a path is completely blocked (agent cannot access it at all).
     * Returns true if the path should be denied.
     */
    isIgnored(path: string): boolean {
        if (!this.loaded) return true; // fail-closed: deny all until rules are loaded
        const normalPath = this.normalize(path);

        // BYP-2 (AUDIT 2026-07-14): normalize() does not collapse `..`, so a
        // path like `Inbox/../.obsidian/...` would slip the deny-zone here while
        // the adapter resolves it into configDir. Reject any `..` segment
        // fail-closed rather than relying on each tool to strip traversal.
        if (normalPath.split('/').some((seg) => seg === '..')) return true;

        // H-1/H-2 (AUDIT 2026-07-14): configDir (.obsidian) is an absolute
        // read+write deny-zone for vault tools and MCP. It holds every plugin's
        // data.json (credentials) and main.js (arbitrary code executed on the
        // next Obsidian reload); no agent tool has a legitimate reason to touch
        // it. Case-insensitive so a `.Obsidian/...` variant cannot slip past on
        // case-insensitive filesystems (H-3). This mirrors the sandbox bridge,
        // which already blocks configDir symmetrically.
        const lower = IgnoreService.fold(normalPath);
        if (lower === this.configDirLower || lower.startsWith(`${this.configDirLower}/`)) {
            return true;
        }

        // H-2: the agent's own secret zone (settings.json, data/ DBs, cache,
        // provenance manifest) is off-limits for reads as well as writes;
        // skills/, skill-data/ and tmp/ stay accessible.
        if (isAgentSecretPath(normalPath, this.agentRoot)) return true;

        // Always-blocked paths.
        // AUDIT 2026-07-26 (P3 follow-up): this compared RAW strings while the
        // configDir zone right above it folded. `.Git/` therefore walked past a
        // deny entry that `.git/` hit, on exactly the filesystems where both
        // name the same directory.
        for (const blocked of this.alwaysBlocked) {
            const b = IgnoreService.fold(blocked);
            if (lower === b || lower.startsWith(b)) return true;
        }

        // User-defined ignore patterns (.obsidian-agentignore)
        if (this.matchesAnyPattern(normalPath, this.ignorePatterns)) return true;

        // Obsidian's own "Excluded files" (opt-in): the user maintains the list
        // in Obsidian's UI and VO honours it as a hard ignore.
        if (this.respectObsidianExcluded
            && matchesObsidianExcluded(normalPath, this.obsidianExcludedFilters)) {
            return true;
        }
        return false;
    }

    /**
     * Check if a path is protected from writing.
     * Protected paths can be read but never written/deleted/moved.
     */
    isProtected(path: string): boolean {
        if (!this.loaded) return true; // fail-closed: protect all until rules are loaded
        const normalPath = this.normalize(path);

        // AUDIT 2026-07-26: the same fail-closed traversal guard isIgnored has.
        // Its absence here meant a `..` path was readable-blocked but not
        // write-blocked, i.e. the weaker check governed the more dangerous op.
        if (normalPath.split('/').some((seg) => seg === '..')) return true;

        // Always-protected governance files.
        // AUDIT 2026-07-26 (P3 follow-up): an exact, unfolded comparison. These
        // two files ARE the user's deny rules, so a case- or NFD-variant spelling
        // let a tool rewrite the rules that govern it -- the worst possible thing
        // to leave case-sensitive.
        const foldedPath = IgnoreService.fold(normalPath);
        for (const p of IgnoreService.ALWAYS_PROTECTED) {
            if (foldedPath === IgnoreService.fold(p)) return true;
        }

        // FIX-44-24: the agent's own config zone is never writable by a tool.
        if (isProtectedAgentConfigPath(normalPath, this.agentRoot)) return true;

        // User-defined protected patterns
        return this.matchesAnyPattern(normalPath, this.protectedPatterns);
    }

    /**
     * Get user-facing description of why a path is blocked.
     *
     * When the blocked path looks like an attempt to reach a skill definition by
     * filesystem path, the message redirects to the by-name skill tools. The
     * skills folder is hidden and per-install configurable (default
     * `.vault-operator/data/skills/`, but overridable and even absolute), so a
     * constructed path is fragile -- an agent that guesses `.obsidian/plugins/
     * .../skills/...` hits this deny-zone. read_skill / write_skill resolve the
     * real path from the skill NAME, so the agent never needs to know it.
     */
    getDenialReason(path: string): string {
        const base = this.isProtected(path)
            ? `"${path}" is protected (.obsidian-agentprotected). Cannot write to protected files.`
            : this.isIgnored(path)
                ? `"${path}" is excluded (.obsidian-agentignore). Add it to the ignore list to allow access.`
                : `"${path}" is blocked by system defaults.`;

        if (looksLikeSkillDefinitionPath(this.normalize(path))) {
            return base
                + ' If you meant to read or revise an installed skill, do not target its files by '
                + 'path -- use read_skill or write_skill with the skill NAME; they resolve the '
                + 'hidden, per-install skills folder for you.';
        }
        return base;
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Read one pattern file.
     *
     * AUDIT 2026-07-26 H-4: this used to probe with getAbstractFileByPath and
     * swallow every error into an empty list. Two problems, both fail-OPEN:
     * dotfiles are not in the TFile index at all (so a present rule file read as
     * "no rules"), and a genuine I/O failure was indistinguishable from "the
     * user has no rules". The result was a silently empty ruleset that load()
     * then marked as successfully loaded, dropping the user's entire deny zone
     * for the session. Existence is now probed through the adapter (the pattern
     * the rest of the codebase uses for hidden paths) and read errors PROPAGATE
     * so load() can stay fail-closed.
     */
    private async readPatternFile(filename: string): Promise<string[]> {
        if (!(await this.vault.adapter.exists(filename))) return [];
        const content = await this.vault.adapter.read(filename);
        return content
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith('#'));
    }

    /**
     * Read Obsidian's "Excluded files" list (`userIgnoreFilters`) from
     * `<configDir>/app.json`. Fails OPEN (returns []) on a missing/malformed
     * file: this is an additive convenience, never a security boundary -- a
     * broken app.json must not deny access the .obsidian-agentignore rules
     * already govern. Uses vault.configDir (never a hardcoded `.obsidian`).
     */
    private async readObsidianExcludedFilters(): Promise<string[]> {
        try {
            const appJsonPath = `${this.vault.configDir}/app.json`;
            if (!(await this.vault.adapter.exists(appJsonPath))) return [];
            const raw = await this.vault.adapter.read(appJsonPath);
            const parsed = JSON.parse(raw) as { userIgnoreFilters?: unknown };
            const filters = parsed.userIgnoreFilters;
            if (!Array.isArray(filters)) return [];
            return filters.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
        } catch {
            return [];
        }
    }

    /**
     * Canonicalise a vault-relative path before any governance decision.
     *
     * AUDIT 2026-07-26 H-2: this used to strip only a leading slash and convert
     * backslashes, so "./" and "//" survived. A single dot-slash therefore
     * defeated the configDir deny zone, the agent secret zone AND every user
     * rule, for every tool without its own path guard -- the deny zone the
     * previous audit declared absolute. Empty and "." segments are now dropped,
     * which collapses "./", "//" and a leading "/" in one pass.
     *
     * ".." segments are deliberately PRESERVED so the fail-closed traversal
     * check in isIgnored/isProtected still sees and rejects them. Collapsing
     * them here would resolve the traversal away and hide the attack.
     */
    private normalize(path: string): string {
        const segments = (path ?? '').replace(/\\/g, '/').split('/');
        const out: string[] = [];
        for (const seg of segments) {
            if (seg === '' || seg === '.') continue;
            out.push(seg);
        }
        return out.join('/');
    }

    /**
     * Case- and unicode-fold for matching.
     *
     * AUDIT 2026-07-26 M-2 + the NFD finding: user patterns matched byte-exact
     * and case-sensitive, so on APFS/NTFS -- where "private/x" and "Private/x"
     * are the SAME file -- a case variant walked past a user rule, and an
     * NFD-decomposed umlaut walked past a rule written in NFC. The built-in
     * configDir zone was already case-insensitive, which shows the threat was
     * understood; the user-facing rules were not.
     *
     * The uppercase round trip is load-bearing: NTFS/exFAT fold via uppercase,
     * so U+0131 (dotless i) and similar only fold correctly this way.
     */
    private static fold(s: string): string {
        return foldPath(s);
    }

    /**
     * Minimal gitignore-style pattern matching:
     * - `*` matches any characters except `/`
     * - `**` matches anything including `/`
     * - Trailing `/` means directory match
     * - Leading `!` means negation (not yet supported — skip)
     */
    private matchesAnyPattern(path: string, patterns: string[]): boolean {
        for (const pattern of patterns) {
            if (pattern.startsWith('!')) continue; // negation not supported yet
            if (this.matchPattern(path, pattern)) return true;
        }
        return false;
    }

    private matchPattern(rawPath: string, pattern: string): boolean {
        // AUDIT 2026-07-26 M-2 + NFD: fold BOTH sides before matching, so a case
        // or normalisation variant of the same file cannot slip a user rule.
        // The pattern keeps its trailing slash (it is syntax, not a character).
        const path = IgnoreService.fold(rawPath);
        const p = IgnoreService.fold(pattern.replace(/\\/g, '/').replace(/^\//, ''));

        // Directory pattern: "folder/" matches "folder/anything"
        if (p.endsWith('/')) {
            return path.startsWith(p) || path === p.slice(0, -1);
        }

        // M-2: Reject pathologically long or complex patterns to prevent ReDoS
        if (p.length > 200) return false;
        if (/(\*\*){3,}/.test(p)) return false;

        // Convert glob to regex (escape backslashes first to prevent double-escaping)
        const regexStr = p
            .replace(/\\/g, '\\\\') // escape backslashes first
            .replace(/\./g, '\\.') // escape dots
            .replace(/\*\*/g, '§DOUBLESTAR§')
            .replace(/\*/g, '[^/]*')
            .replace(/§DOUBLESTAR§/g, '.*');

        try {
            // AUDIT-007 M-1: Use safeRegex() to prevent ReDoS from glob patterns
            // Pattern without slash: match basename or full path
            if (!p.includes('/')) {
                const basenameRegex = safeRegex(`(^|/)${regexStr}($|/)`);
                return basenameRegex.test(path);
            }
            // Pattern with slash: match from root
            const fullRegex = safeRegex(`^${regexStr}($|/)`);
            return fullRegex.test(path);
        } catch {
            // Invalid regex — fall back to exact match
            return path === p || path.startsWith(p + '/');
        }
    }
}

/**
 * Heuristic: does a (normalised, vault-relative) path look like an attempt to
 * reach a skill DEFINITION by filesystem path? Signals: a `SKILL.md` basename,
 * or a `skills/<name>/` segment (the skill workspace, under any parent -- the
 * real `.vault-operator/data/skills/` OR a wrongly-guessed
 * `.obsidian/plugins/.../skills/`). Only advisory: it merely enriches the
 * message of an already-denied path, so a false positive (e.g. a user note
 * folder literally named `skills`) costs nothing.
 */
function looksLikeSkillDefinitionPath(path: string): boolean {
    return /(^|\/)SKILL\.md$/i.test(path) || /(^|\/)skills\/[^/]+(\/|$)/i.test(path);
}
