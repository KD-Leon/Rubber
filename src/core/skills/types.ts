/**
 * VaultDNA Types — Plugin-as-Skill (PAS-1)
 *
 * Shared types for VaultDNAScanner, SkillRegistry, and CapabilityGapResolver.
 */

export type PluginClassification = 'FULL' | 'PARTIAL' | 'NONE';
export type PluginStatus = 'enabled' | 'disabled';
export type PluginSource = 'core' | 'vault-native';

/** Single entry in vault-dna.json */
export interface VaultDNAEntry {
    id: string;
    name: string;
    type: 'core' | 'community';
    classification: PluginClassification;
    status: PluginStatus;
    version?: string;
    /** Filename in plugin-skills dir (e.g. "obsidian-dataview.skill.md") */
    skillFile?: string;
    source: PluginSource;
    /** Reason for NONE classification */
    reason?: string;
    /** Plugin description from manifest (used for gap-resolution matching) */
    description?: string;
}

/** Persisted vault-dna.json structure */
export interface VaultDNA {
    scannedAt: string;
    agentVersion: string;
    mode: 'local';
    plugins: VaultDNAEntry[];
    archived: VaultDNAEntry[];
}

/** Runtime skill metadata (enriched from VaultDNAEntry + .skill.md) */
export interface PluginSkillMeta {
    id: string;
    name: string;
    source: PluginSource;
    classification: PluginClassification;
    enabled: boolean;
    commands: { id: string; name: string }[];
    description: string;
    /** Whether this plugin has a non-empty settings file (data.json) */
    hasSettings?: boolean;
    /** Whether the plugin appears to need setup/configuration */
    needsSetup?: boolean;
    /** Whether this plugin exposes a JavaScript API (plugin.api or plugin itself) */
    hasApi?: boolean;
    /** Method names discovered via Reflection on the API object */
    apiMethods?: string[];
}

// ---------------------------------------------------------------------------
// Self-Authored Skill Types -- EPIC-022 / ADR-075
// ---------------------------------------------------------------------------

/**
 * Content sidecars a skill folder may ship. Listed in the system prompt so
 * the agent knows what to reach for via `read_file` / `evaluate_expression`.
 * The loader never inlines these files -- they stay on disk.
 */
export interface SkillInventory {
    /** Files in `scripts/`. Language is derived from the file extension. */
    scripts: SkillScriptFile[];
    /** Files in `references/` -- long docs, on-demand only. */
    references: string[];
    /** Files in `assets/` -- templates, images, data blobs. */
    assets: string[];
    /** `*.skill.md` files next to SKILL.md. Populated only for coordinators. */
    subRoles: SkillSubRole[];
}

export interface SkillScriptFile {
    /** Filename relative to the skill folder, e.g. `scripts/helpers.ts`. */
    path: string;
    /** Derived from the extension. Only `ts`/`js` are sandbox-executable. */
    language: SkillScriptLanguage;
    /** Size in bytes, surfaced in the prompt. */
    sizeBytes: number;
}

export type SkillScriptLanguage = 'ts' | 'js' | 'py' | 'sh' | 'md' | 'other';

/**
 * Sub-role metadata extracted from a `*.skill.md` file next to a coordinator's
 * `SKILL.md`. Only the frontmatter is read -- the body stays on disk and is
 * loaded via `read_file` when the coordinator delegates.
 */
export interface SkillSubRole {
    /** Role id from frontmatter, falls back to the filename stem. */
    role: string;
    name: string;
    description: string;
    /** Filename relative to the skill folder, e.g. `writer.skill.md`. */
    filePath: string;
}

/** Result of a one-time skill migration from a legacy path. */
export interface SkillMigrationResult {
    /** Slugs that were copied from the legacy source. */
    migratedSlugs: string[];
    /** Slugs skipped because the destination already had them. */
    skippedSlugs: string[];
    /** Error messages per slug. */
    errors: string[];
    /** Vault-relative (or absolute) source dir that was scanned. */
    sourceDir: string;
    /** Target dir under the configured agent folder. */
    targetDir: string;
}
