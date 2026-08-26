/**
 * IMP-29-13-01: the character cap for a description rendered into a prompt.
 *
 * Every place that lists a skill or a plugin for the model cuts the
 * description at some length before it enters the cached prompt prefix. That
 * length used to be a bare `300` repeated at twelve call sites, so raising it
 * meant finding all twelve -- and the twelfth is the one that gets missed.
 *
 * There is more than one cap here on purpose. The number is the same today,
 * which is exactly what made the copies look interchangeable, but the two are
 * answers to different questions and can move apart:
 *
 *  - SKILL_DESCRIPTION_PROMPT_CAP governs a field the user (or a skill author)
 *    writes in skill frontmatter. `SkillFrontmatterValidator.MAX_DESC_LEN`
 *    already accepts up to 1024 there, so this cap is what decides how much of
 *    an accepted description the model actually gets to read. Raising it is a
 *    statement about our own skill format.
 *  - PLUGIN_DESCRIPTION_PROMPT_CAP governs `manifest.json` text from an
 *    arbitrary installed Obsidian plugin, including one that was never
 *    enabled. No validator of ours constrains it, and the budget question is a
 *    vault with sixty plugins in the prompt, not one verbose skill. Lowering
 *    it is a statement about foreign input.
 *
 * The caps are not a security boundary on their own. `sanitizeDirectoryEntry`
 * is: it defangs prompt-boundary tags and collapses newlines so one entry
 * stays one line. Length is the budget half of the same call.
 */

/**
 * Skill frontmatter `description`, as rendered into the skill directory, the
 * read_skill header and the imported-sub-skill approval dialog.
 */
export const SKILL_DESCRIPTION_PROMPT_CAP = 300;

/**
 * Obsidian plugin `manifest.json` description, as rendered into the PLUGIN
 * SKILLS prompt block and into the generated per-plugin skill file.
 */
export const PLUGIN_DESCRIPTION_PROMPT_CAP = 300;

/**
 * Sub-role blurb in a skill's inventory listing. Deliberately shorter than the
 * skill's own description: a skill can carry several sub-roles, and each one
 * shares a line with its file path and role name.
 */
export const SKILL_SUBROLE_DESCRIPTION_PROMPT_CAP = 200;
