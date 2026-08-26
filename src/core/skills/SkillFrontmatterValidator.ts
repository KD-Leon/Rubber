/**
 * SkillFrontmatterValidator -- FEAT-29-05 Step 2.
 *
 * Hard validation rules for skill frontmatter, applied by the
 * SelfAuthoredSkillLoader at discovery time. Mirrors the Anthropic
 * canonical skill-creator validation so a skill created here is
 * portable across Claude Code, claude.ai, and other Anthropic-compliant
 * runtimes.
 *
 * Hard errors (skill is rejected outright):
 *   - frontmatter is not an object
 *   - `name` missing or not a string
 *   - `name` not kebab-case `[a-z0-9][a-z0-9-]*[a-z0-9]` (or single char `[a-z0-9]`)
 *   - `name` contains leading/trailing hyphen or double hyphens
 *   - `name` longer than 64 characters
 *   - `name` contains reserved words "anthropic" or "claude"
 *   - `description` missing or not a string
 *   - `description` longer than 1024 characters
 *   - `description` contains a prompt-boundary tag (FIX-29-05-05; plain angle
 *     brackets are allowed and only warn)
 *
 * Soft warnings (skill still loads):
 *   - frontmatter has keys outside the allowed/tolerated set
 *   - description still contains the "[TODO" placeholder
 *
 * The validator is pure-functional and side-effect-free so it can run
 * in any context (loader, UI preview, sandbox script). The
 * SelfAuthoredSkillLoader consumes the result and surfaces errors via
 * console.warn plus a Notice.
 */

// Exported so a test can pin a skill-side validator against this one. A skill
// script cannot import them (run_skill_script does not bundle), so every skill
// that validates frontmatter must copy them. A copy nobody checks is a fork.
// FIX-29-05-05: the ONLY import here. BaseTool carries type-only imports, so
// this stays runtime-weightless and the validator stays side-effect-free.
// Reusing the real defang keeps the boundary-tag rule from forking away from
// the control it is backing up -- "a copy nobody checks is a fork" applies to
// this file as much as to the skill-side copies noted below.
import { defangBoundaryTags } from '../tools/BaseTool';

export const NAME_PATTERN_MULTI = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const NAME_PATTERN_SINGLE = /^[a-z0-9]$/;
export const RESERVED = ['anthropic', 'claude'];
export const MAX_NAME_LEN = 64;
export const MAX_DESC_LEN = 1024;

/**
 * Keys the validator accepts in frontmatter without raising a warning.
 * The canonical spec is `name` and `description` only; the rest is
 * tolerated for back-compat with skills that pre-date FEAT-29-05.
 */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
    // Canonical spec (hard-required)
    'name',
    'description',
    // Tolerated extras (read but ignored by the trigger pipeline)
    'source',
    'trigger',
    'license',
    'allowed-tools',
    // FEAT-29-10 follow-up: invoke_skill reads `allowedTools` (camelCase)
    // from the sub-skill frontmatter to narrow the spawn's tool schema.
    // Both spellings are accepted (Anthropic uses kebab-case, internal VO
    // convention is camelCase like requiredTools/codeModules).
    'allowedTools',
    'allowed_tools',
    'metadata',
    'compatibility',
    'model',
    'requiredTools',
    'codeModules',
    'createdAt',
    'successCount',
    'type',
    // FIX-03-20-02: optional deterministic chat-title template (e.g.
    // `chatTitle: "Plaud {date}"`). Read by the send path, `{date}` -> DD-MM-YY.
    'chatTitle',
    // FEAT-29-05 follow-up: common community-skill conventions that the
    // Vault Operator discovery layer doesn't act on but the user may want
    // to keep for portability or documentation. Accepting them silently
    // (no warning) keeps the console clean for skills that travel between
    // claude.ai / Claude Code / Vault Operator.
    'version',
    'author',
    'keywords',
    'aliases',
    'priority',
    'when-to-use',
    'argument-hint',
    'context',
    'tags',
]);

export interface SkillValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export function validateSkillFrontmatter(
    fm: Record<string, unknown> | null | undefined,
): SkillValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (fm === null || fm === undefined || typeof fm !== 'object' || Array.isArray(fm)) {
        return {
            valid: false,
            errors: ['frontmatter must be a non-null object'],
            warnings: [],
        };
    }

    // name
    const nameRaw = fm.name;
    if (nameRaw === undefined || nameRaw === null) {
        errors.push('frontmatter is missing required field: name');
    } else if (typeof nameRaw !== 'string') {
        errors.push(`name must be a string, got ${typeof nameRaw}`);
    } else {
        const name = nameRaw.trim();
        if (name.length === 0) {
            errors.push('name cannot be empty');
        } else if (name.length > MAX_NAME_LEN) {
            errors.push(`name too long (${name.length} chars, max ${MAX_NAME_LEN})`);
        } else if (!NAME_PATTERN_MULTI.test(name) && !NAME_PATTERN_SINGLE.test(name)) {
            errors.push(
                `name must be kebab-case (lowercase letters/digits/hyphens, no leading/trailing hyphen, no double hyphens). Got: ${JSON.stringify(name)}`,
            );
        } else if (name.includes('--')) {
            errors.push('name cannot contain consecutive hyphens');
        } else {
            const lower = name.toLowerCase();
            for (const word of RESERVED) {
                if (lower.includes(word)) {
                    errors.push(`name cannot contain the reserved word "${word}"`);
                    break;
                }
            }
        }
    }

    // description
    const descRaw = fm.description;
    if (descRaw === undefined || descRaw === null) {
        errors.push('frontmatter is missing required field: description');
    } else if (typeof descRaw !== 'string') {
        errors.push(`description must be a string, got ${typeof descRaw}`);
    } else {
        const desc = descRaw.trim();
        if (desc.length === 0) {
            errors.push('description cannot be empty');
        } else if (desc.length > MAX_DESC_LEN) {
            errors.push(`description too long (${desc.length} chars, max ${MAX_DESC_LEN})`);
        } else if (defangBoundaryTags(desc) !== desc) {
            // FIX-29-05-05: narrow rule. This is DEFENCE IN DEPTH, not the
            // boundary itself -- the actual control is sanitizeDirectoryEntry
            // at every path that assembles skill metadata into a prompt. It is
            // kept because this rule was once silently load-bearing for a sink
            // nobody had enumerated (ReadSkillTool.frameSkill), and new sinks
            // will get added again. A tag-shaped description has no legitimate
            // use, so failing closed here costs nothing.
            //
            // Delegating to defangBoundaryTags rather than re-listing the tags
            // keeps this from drifting out of sync with the real defence, and
            // inherits its reconstruction-safety (a nested payload that would
            // reassemble into a live tag is caught too).
            errors.push('description cannot contain prompt-boundary tags');
        }
        // The old rule rejected EVERY angle bracket, which killed ordinary
        // descriptions such as "web.plaud.ai/file/<id>". Brackets are fine;
        // they just render literally.
        if (desc.includes('<') || desc.includes('>')) {
            warnings.push(
                'description contains angle brackets -- they will be shown literally, not as markup',
            );
        }
        // Newlines survive a `description: |` literal block scalar. Every
        // assembly path collapses them, so this cannot forge a section -- but
        // the author should know the layout will not be preserved.
        if (/[\r\n]/.test(desc)) {
            warnings.push('description contains newlines -- they will be collapsed to single spaces');
        }
        if (desc.startsWith('[TODO')) {
            warnings.push(
                'description still contains [TODO placeholder -- replace before declaring the skill done',
            );
        }
    }

    // Unexpected keys
    for (const key of Object.keys(fm)) {
        if (!ALLOWED_KEYS.has(key)) {
            warnings.push(`unexpected frontmatter key "${key}" -- discovery layer will ignore it`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}
