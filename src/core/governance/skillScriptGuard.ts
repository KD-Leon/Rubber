/**
 * skillScriptGuard -- decide whether the bytes about to run are the bytes the
 * plugin shipped.
 *
 * AUDIT 2026-07-26 M-1 (CWE-94). The agent-folder deny zone deliberately
 * exempts `skills/`, because skill-creator has to be able to author skills
 * there. That exemption also means sandboxed code can overwrite the
 * `scripts/*.js` of ANY installed skill, including the ones the plugin ships,
 * and the overwrite survives restarts. `run_skill_script` then loads those
 * bytes and executes them under `autoApproval.sandbox`. Persistent code
 * injection with no second prompt.
 *
 * The finding is explicit that the fix belongs on the EXECUTION side. Banning
 * writes to `scripts/` would break skill-creator, which legitimately writes
 * scripts as its whole purpose.
 *
 * WHAT COUNTS AS AUTHORITY
 *
 * The first design used SkillProvenanceStore (the SKILL.md manifest) to decide
 * "is this a plugin-managed skill?". Adversarial review killed that: SKILL.md
 * lives in the SAME exempted folder as the script. An attacker who can rewrite
 * the script can append one byte to the manifest, the skill stops counting as
 * managed, and the refusal never fires. An authority the attacker can write is
 * not an authority.
 *
 * So the authority here is BUNDLED_SKILLS -- the shipped bytes, compiled into
 * main.js. Nothing in the vault can change them. The rule is simply:
 *
 *     bytes equal to what we shipped  ->  run as before
 *     folder we ship, bytes differ    ->  refuse outright
 *     anything else                   ->  ask, and say why
 *
 * The middle case does not consult the manifest at all, so the one-extra-write
 * downgrade has nothing to bite on. The manifest is still read, but only to
 * distinguish the SUPPORTED user-override flow (a SKILL.md that declares
 * `source: user`, which the materializer honours) from a silent overwrite -- and
 * that distinction only ever changes which unverified reason is shown, never
 * whether something is allowed.
 *
 * CASE FOLDING
 *
 * macOS/APFS, Windows/NTFS and iOS resolve paths case-insensitively, so
 * `Skill-Creator/scripts/INIT_SKILL.js` opens the same file as the lower-case
 * spelling while an exact record lookup misses. Both the folder and the script
 * tail are resolved through the shared foldPath, so a case variant can neither
 * downgrade a tampered script to "unknown" nor flag an untouched one as
 * missing.
 *
 * Pure and dependency-free apart from that fold, so the tool, the approval gate
 * and the tests all judge by the same rule.
 */

import { foldPath } from './foldPath';

/** The tiers a SKILL.md may claim that mean "the plugin manages this". */
const MANAGED_TIERS: ReadonlySet<string> = new Set(['builtin', 'bundled', 'pro']);

export type SkillScriptVerdict =
    /** Byte-identical to the shipped copy. Runs exactly as before. */
    | { kind: 'plugin-verified' }
    /** We ship this folder and these are not our bytes. Refused outright. */
    | { kind: 'tampered'; detail: 'content-differs' | 'not-shipped' }
    /** Cannot be traced to a shipped copy. Always asks; the detail says why. */
    | {
        kind: 'unverified';
        detail:
        /** Ordinary user- or agent-authored skill. The common, fine case. */
        | 'unmanaged'
        /** A folder we ship, converted to a local copy via `source: user`. */
        | 'user-override'
        /** Managed tier whose folder is not in this build (pro on the public build). */
        | 'left-bundle'
        /** Source could not be read. */
        | 'unreadable'
        /** Identifier failed validation; no path was built from it. */
        | 'bad-name';
    };

/** One skill folder as it appears in BUNDLED_SKILLS: relative path -> content. */
export type BundledSkillFiles = Record<string, string>;
export type BundledSkills = Record<string, BundledSkillFiles>;

/** Case-insensitive lookup of one entry in a record, exact match preferred. */
function foldLookup<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
    if (!rec) return undefined;
    if (Object.prototype.hasOwnProperty.call(rec, key)) return rec[key];
    const folded = foldPath(key);
    for (const k of Object.keys(rec)) {
        if (foldPath(k) === folded) return rec[k];
    }
    return undefined;
}

/** True when the record has an entry for `key`, case-insensitively. */
function foldHas(rec: Record<string, unknown> | undefined, key: string): boolean {
    return foldLookup(rec, key) !== undefined;
}

/**
 * The `source:` value a SKILL.md declares, or null.
 *
 * Same shape as SkillProvenanceStore.extractSource, duplicated here rather than
 * imported so this module stays free of the store (which the attacker can
 * write, and which this module deliberately does not treat as authority).
 */
export function declaredSkillTier(skillMd: string | null): string | null {
    if (skillMd === null) return null;
    // FIX-29-05-10 (Issue #71): the fence must agree with splitSkillFrontmatter
    // on line endings. While this reader was LF-only and the splitter was not,
    // a CRLF manifest could load as a skill whose `source:` claim nobody read --
    // exactly the split-brain the LF-only rule was meant to prevent.
    const match = skillMd.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const line = match[1].split('\n').find((l) => /^\s*source\s*:/.test(l));
    if (!line) return null;
    return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
}

export interface ClassifyArgs {
    /** Skill folder segment, e.g. `skill-creator`. Already trimmed+validated. */
    skillFolder: string;
    /** POSIX path inside the skill folder, e.g. `scripts/init_skill.js`. */
    fileRelPath: string;
    /** The bytes that are about to run. null when unreadable. */
    fileSource: string | null;
    /** Contents of the folder's SKILL.md, or null. Advisory only. */
    skillMd: string | null;
    /** The shipped skills. undefined in a test stub or a build without them. */
    bundle: BundledSkills | undefined;
}

/**
 * Classify the bytes in hand.
 *
 * Takes the source as a parameter rather than reading it: the caller has
 * already read the file, and re-reading would judge different bytes than the
 * ones that run. That gap is small but it is exactly the wrong place to have
 * one.
 */
export function classifySkillScript(args: ClassifyArgs): SkillScriptVerdict {
    const { skillFolder, fileRelPath, fileSource, skillMd, bundle } = args;

    if (fileSource === null) return { kind: 'unverified', detail: 'unreadable' };

    const shippedFiles = foldLookup(bundle, skillFolder);
    if (shippedFiles === undefined) {
        // Not a folder this build ships. A manifest tier still tells us whether
        // this is a pro skill stripped from the public bundle (ADR-152
        // grandfathering) or an ordinary local skill.
        const tier = declaredSkillTier(skillMd);
        return {
            kind: 'unverified',
            detail: tier !== null && MANAGED_TIERS.has(tier) ? 'left-bundle' : 'unmanaged',
        };
    }

    const shipped = foldLookup(shippedFiles, fileRelPath);
    if (shipped !== undefined && shipped === fileSource) {
        // These ARE our bytes. Nothing else matters -- not the manifest, not
        // what the frontmatter claims. This is the fast path that keeps every
        // bundled script running without a card.
        return { kind: 'plugin-verified' };
    }

    // We ship this folder and the bytes are not ours. The only benign reading is
    // the documented override: a SKILL.md that declares a non-managed tier, which
    // makes BuiltinSkillMaterializer skip the folder from then on. That is a real
    // user decision, so it asks rather than refuses -- but it is named as what it
    // is, because "a folder the plugin ships, now carrying local code" deserves a
    // different sentence than "an ordinary user skill".
    const tier = declaredSkillTier(skillMd);
    if (tier !== null && !MANAGED_TIERS.has(tier)) {
        return { kind: 'unverified', detail: 'user-override' };
    }

    // Still claims a managed tier (or claims nothing) while carrying bytes we
    // did not ship. Refuse. Co-tampering the manifest to keep the claim does
    // not help; dropping the claim entirely does not help either.
    return {
        kind: 'tampered',
        detail: foldHas(shippedFiles, fileRelPath) ? 'content-differs' : 'not-shipped',
    };
}

/** A short, user-facing reason for an unverified or tampered verdict. */
export function verdictReason(v: SkillScriptVerdict): string {
    switch (v.kind) {
        case 'plugin-verified':
            return 'matches the copy shipped with the plugin';
        case 'tampered':
            return v.detail === 'content-differs'
                ? 'the plugin ships this file and these are not the bytes it ships'
                : 'the plugin ships this skill and this file is not part of it';
        default:
            switch (v.detail) {
                case 'user-override': return 'a skill the plugin ships that was converted to a local copy';
                case 'left-bundle': return 'a managed skill that is not part of this build';
                case 'unreadable': return 'the file could not be read';
                case 'bad-name': return 'the name failed validation';
                default: return 'a local skill, not shipped with the plugin';
            }
    }
}
