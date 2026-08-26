/**
 * skillToggleGate -- one answer to "is this skill switched on?".
 *
 * AUDIT 2026-07-26 M-17. The Skills tab writes a per-skill switch into
 * `settings.manualSkillToggles`, keyed by
 * `globalPath ?? selfAuthored.filePath ?? name`. Three prompt builders read
 * that map (main.buildSkillDirectoryForMode, AgentSidebarView.buildSkillDirectory,
 * AgentRuntimeContext.buildSkillDirectory) but each of them filtered ONLY the
 * SkillsManager list by `s.path` and then appended
 * `selfLoader.getMetadataSummary()` unfiltered. A self-authored skill was keyed
 * by its filePath, never by `s.path`, so switching it off changed the dot in the
 * settings table and nothing else: the skill stayed in <available_skills>.
 *
 * Worse, the switch was never a gate at all. Even for user skills it only
 * removed the advertisement; `invoke_skill` and `read_skill` resolve by name
 * against the loader, so a model that remembered the name from an earlier turn
 * (or read it out of a note) could still run a skill the user had switched off.
 * A control that looks like a switch has to actually cut the wire.
 *
 * Hence one module, used by the directory builders AND by the two tools that
 * resolve a skill by name. Pure and dependency-free so all five paths can be
 * tested against the same predicate.
 */

/** The candidate keys under which a skill may be switched, in tab precedence. */
export interface SkillToggleIdentity {
    /** Path from the SkillsManager listing, when the skill has one. */
    globalPath?: string;
    /** Path to SKILL.md for a self-authored skill. */
    filePath?: string;
    /** Fallback key when a skill has neither path. */
    name: string;
}

/**
 * True unless the user switched this skill off.
 *
 * Absent key means on: the map only ever holds explicit decisions, so a newly
 * discovered skill is not silently disabled. Mirrors the `!== false` reading in
 * SkillsTab, which is what the dot in the table shows.
 *
 * All three candidate keys are consulted rather than just the one the tab would
 * have written, because which key wins depends on data the caller does not
 * always have (a self-authored skill that also appears in the SkillsManager
 * listing is keyed by globalPath there, by filePath here). Checking every key
 * fails closed: any one of them switched off disables the skill.
 */
export function isSkillEnabled(
    toggles: Record<string, boolean> | undefined,
    identity: SkillToggleIdentity,
): boolean {
    if (!toggles) return true;
    for (const key of [identity.globalPath, identity.filePath, identity.name]) {
        if (key !== undefined && toggles[key] === false) return false;
    }
    return true;
}

/**
 * Names of the self-authored skills that are switched on, for
 * `getMetadataSummary(allowedNames)`.
 *
 * Returns undefined when nothing is switched off, which keeps the existing
 * "no filter" fast path and avoids building a set on every prompt.
 */
export function enabledSelfAuthoredNames(
    toggles: Record<string, boolean> | undefined,
    skills: ReadonlyArray<{ name: string; filePath?: string }>,
): ReadonlySet<string> | undefined {
    if (!toggles || Object.keys(toggles).length === 0) return undefined;
    const allowed = new Set<string>();
    let anyDisabled = false;
    for (const s of skills) {
        if (isSkillEnabled(toggles, { filePath: s.filePath, name: s.name })) allowed.add(s.name);
        else anyDisabled = true;
    }
    return anyDisabled ? allowed : undefined;
}
