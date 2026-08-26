/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * SelfAuthoredSkillLoader
 *
 * Loads and manages agent-created SKILL.md files with YAML frontmatter.
 * Skills are stored in the plugin data directory under skills/.
 * Hot-reload via Vault events.
 *
 * Skills can optionally contain code modules (TypeScript files in code/)
 * that are compiled and registered as dynamic tools. This unifies the
 * former "Skills" and "Dynamic Tools" concepts into a single abstraction.
 *
 * Part of Self-Development Phase 2+3: Skill Self-Authoring + Code Modules.
 */

import { Notice, TFile, TFolder } from 'obsidian';
import { safeRegex } from '../utils/safeRegex';
import { sanitizeDirectoryEntry } from '../tools/BaseTool';
import { SKILL_DESCRIPTION_PROMPT_CAP, SKILL_SUBROLE_DESCRIPTION_PROMPT_CAP } from './descriptionCaps';
import { getSelfAuthoredSkillsDir } from '../utils/agentFolder';
import { AstValidator } from '../sandbox/AstValidator';
import { validateSkillFrontmatter } from './SkillFrontmatterValidator';
import { dedent, parseSkillFrontmatterBlock, splitSkillFrontmatter } from './skillFrontmatterParser';
import { detectLineEnding } from '../utils/frontmatterSplit';
import { TRUSTED_SKILL_TIERS, type SkillProvenanceStore } from './SkillProvenanceStore';
import type ObsidianAgentPlugin from '../../main';
import type { EsbuildWasmManager } from '../sandbox/EsbuildWasmManager';
import type { ISandboxExecutor } from '../sandbox/ISandboxExecutor';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { DynamicToolFactory } from '../tools/dynamic/DynamicToolFactory';
import type { CodeModuleInfo, DynamicToolDefinition } from '../tools/dynamic/types';
import type { ToolName } from '../tools/types';
import type {
    SkillInventory,
    SkillScriptLanguage,
    SkillSubRole,
} from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A SKILL.md the loader refused. FIX-29-05-01: surfaced in Settings > Skills
 * so a broken skill reads as broken instead of as missing.
 */
export interface RejectedSkill {
    /** Vault-relative path of the SKILL.md that failed validation. */
    filePath: string;
    /** Containing folder name -- the only stable identity a rejected skill has. */
    folder: string;
    /** Joined hard-validation errors, shown verbatim to the user. */
    reason: string;
}

export interface SelfAuthoredSkill {
    name: string;
    description: string;
    trigger: RegExp;
    triggerSource: string;
    /**
     * Origin discriminator (FEAT-29-11 source-frontmatter).
     *   - `user`     -- self-authored or imported by the user
     *   - `learned`  -- created by the recipe-promotion / skill-authoring flow
     *   - `builtin`  -- materialized from the plugin bundle (maintainer-managed)
     *   - `bundled`  -- legacy synonym for `builtin`, kept for back-compat
     *   - any other string is a plugin-id (VaultDNAScanner-managed plugin skill)
     */
    source: string;
    requiredTools: string[];
    /**
     * FEAT-29-10 follow-up: when present, sub-skill invocations via
     * invoke_skill spawn the subtask with this tool allowlist. Drastically
     * reduces the subtask's tool-schema prompt cost. Empty array means
     * "no opinion" -- the subtask sees the parent's full tool set.
     */
    allowedTools: string[];
    /** Code module filenames (without .ts) listed in frontmatter */
    codeModules: string[];
    /** Loaded code module metadata (populated after loading compiled JS) */
    codeModuleInfos: CodeModuleInfo[];
    createdAt: Date;
    successCount: number;
    body: string;
    /**
     * FIX-03-20-02: optional frontmatter title template for the chat this skill
     * starts (e.g. `chatTitle: "Plaud {date}"`). Deterministic and opt-in;
     * skills without it keep the intent-/content-based title. `{date}` expands
     * to DD-MM-YY.
     */
    chatTitle?: string;
    filePath: string;
    /**
     * Content sidecars in the skill folder (`scripts/`, `references/`,
     * `assets/`, sub-role `*.skill.md`). Empty for flat single-file skills.
     * EPIC-022 / ADR-075.
     */
    inventory: SkillInventory;
    /** `type: coordinator` frontmatter flag. Empty inventory.subRoles if false. */
    isCoordinator: boolean;
}

// ---------------------------------------------------------------------------
// SelfAuthoredSkillLoader
// ---------------------------------------------------------------------------

export class SelfAuthoredSkillLoader {
    private skills = new Map<string, SelfAuthoredSkill>();
    /**
     * FIX-29-05-01: SKILL.md files that failed hard validation, keyed by path.
     * A rejected skill has no usable name, so the file path is its identity.
     * Kept so Settings can show the user WHY a skill does not load -- the old
     * console.warn-and-return-null presented to the user as "the chat does not
     * know my skill", which sends them looking in entirely the wrong place.
     */
    private rejected = new Map<string, RejectedSkill>();
    /** Signature of the last reported rejection set, to keep the Notice from repeating on every rescan. */
    private lastReportedRejections = '';
    private readonly skillsDir: string;
    /**
     * User/learned skills dir. Computed on each loadAll() so a change to
     * the agent-folder setting (ADR-072) is picked up without plugin reload.
     * FEATURE-2201 Decision 2026-04-18: moved from hardcoded `.obsilo-sync/skills/`
     * to `getSelfAuthoredSkillsDir(plugin)`.
     */
    private getUserSkillsDir(): string {
        return getSelfAuthoredSkillsDir(this.plugin);
    }
    private esbuildManager: EsbuildWasmManager | null;
    private sandboxExecutor: ISandboxExecutor | null;
    private toolRegistry: ToolRegistry | null;
    /** FIX-44-05: provenance authority for trusted-tier `source:` claims. */
    private provenance: SkillProvenanceStore | null = null;

    /** FIX-44-05: bind the provenance manifest used to verify trusted-tier skills. */
    setProvenanceStore(store: SkillProvenanceStore): void {
        this.provenance = store;
    }
    /** Debounce timers for hot-reload per file path */
    private recompileTimers = new Map<string, number>();
    /** Serialize compilation to prevent concurrent builds for the same module */
    private compileQueue = Promise.resolve();

    constructor(
        private plugin: ObsidianAgentPlugin,
        esbuildManager?: EsbuildWasmManager | null,
        sandboxExecutor?: ISandboxExecutor | null,
        toolRegistry?: ToolRegistry | null,
    ) {
        this.skillsDir = `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/skills`;
        this.esbuildManager = esbuildManager ?? null;
        this.sandboxExecutor = sandboxExecutor ?? null;
        this.toolRegistry = toolRegistry ?? null;
    }

    /**
     * Late-bind dependencies that are not available at construction time.
     * Called from main.ts after ToolRegistry is created.
     */
    setDependencies(
        esbuildManager: EsbuildWasmManager,
        sandboxExecutor: ISandboxExecutor,
        toolRegistry: ToolRegistry,
    ): void {
        this.esbuildManager = esbuildManager;
        this.sandboxExecutor = sandboxExecutor;
        this.toolRegistry = toolRegistry;
    }

    /**
     * Scan skills directories and load all SKILL.md files.
     *
     * FEAT-29-11 Step B: bundled skills are no longer loaded from the inlined
     * BUNDLED_SKILLS constant here. They are materialized to disk by
     * `BuiltinSkillMaterializer` during plugin onload BEFORE this method
     * runs, so the single disk-scan below picks them up alongside user
     * and plugin-managed skills. Single layout, single loader path.
     */
    async loadAll(): Promise<void> {
        // Atomic reload: scan into a LOCAL map and swap it in only when done.
        // The old code did `this.skills.clear()` first, so for the whole 2-3 min
        // disk scan (iCloud, ~86 skills) getAllSkills() returned [] -- every
        // skill, bundled/pro included, vanished from the UI and the agent until
        // the scan finished. Building locally means a concurrent reader always
        // sees the previous full set until the new one is ready.
        const nextSkills = new Map<string, SelfAuthoredSkill>();
        const nextRejected = new Map<string, RejectedSkill>();

        await this.scanSkillsFrom(this.getUserSkillsDir(), nextSkills, nextRejected);

        // Swap the in-memory state atomically (synchronous, no await between).
        this.skills = nextSkills;
        this.rejected = nextRejected;

        // After all skills are loaded, load cached code modules and register tools.
        for (const skill of this.skills.values()) {
            if (skill.codeModules.length > 0) {
                await this.loadCodeModules(skill);
                this.registerCodeTools(skill);
            }
        }

        console.debug(`[SelfAuthoredSkillLoader] Loaded ${this.skills.size} skill(s)`);
        this.reportRejections();
    }

    /**
     * FIX-29-05-01: tell the user once when skills failed to load. The doc
     * comment on SkillFrontmatterValidator promised "console.warn plus a
     * Notice" but only the console.warn ever shipped, so a broken skill was
     * indistinguishable from a missing one unless the user happened to open
     * the developer console.
     *
     * Fires only when the rejection set CHANGED, so a rescan (hot reload,
     * import, migration) does not re-nag about skills the user already knows
     * about and has chosen not to fix.
     */
    private reportRejections(): void {
        const signature = [...this.rejected.keys()].sort().join('|');
        if (signature === this.lastReportedRejections) return;
        this.lastReportedRejections = signature;
        if (this.rejected.size === 0) return;

        const count = this.rejected.size;
        const names = [...this.rejected.values()]
            .map(r => sanitizeDirectoryEntry(r.folder, 40))
            .slice(0, 3)
            .join(', ');
        const more = count > 3 ? ` and ${count - 3} more` : '';
        new Notice(
            `Vault Operator: ${count} skill${count === 1 ? '' : 's'} could not be loaded (${names}${more}). ` +
            `Open Settings > Skills to see why.`,
            10000,
        );
    }

    /**
     * FIX-29-05-01: keyed by path, so re-parsing the same file (hot reload,
     * rescan) updates the entry instead of stacking duplicates.
     */
    private recordRejection(filePath: string, reason: string, rejected: Map<string, RejectedSkill> = this.rejected): void {
        console.warn(`[SelfAuthoredSkillLoader] Rejected skill at ${filePath}: ${reason}`);
        const withoutSkillMd = filePath.replace(/\/SKILL\.md$/i, '');
        rejected.set(filePath, {
            filePath,
            folder: withoutSkillMd.slice(withoutSkillMd.lastIndexOf('/') + 1),
            reason,
        });
    }

    /**
     * SKILL.md files that failed hard validation in the last scan.
     * Consumed by SkillsTab to explain the rejection instead of hiding it.
     */
    getRejectedSkills(): RejectedSkill[] {
        return [...this.rejected.values()].sort((a, b) => a.folder.localeCompare(b.folder));
    }

    /**
     * Re-run the full scan. Called after a skill import or migration so the
     * new skills become visible without reloading the plugin.
     * FEATURE-2201 / FEATURE-2202.
     */
    async refresh(): Promise<void> {
        await this.loadAll();
    }

    /**
     * Scan a single skills directory for SKILL.md files in subfolders.
     */
    private async scanSkillsFrom(
        dir: string,
        skills: Map<string, SelfAuthoredSkill>,
        rejected: Map<string, RejectedSkill>,
    ): Promise<void> {
        const adapter = this.plugin.app.vault.adapter;
        const dirExists = await adapter.exists(dir);
        if (!dirExists) return;

        try {
            const entries = await adapter.list(dir);
            // Scan each skill folder in PARALLEL. The old sequential for-await
            // ran ~3 adapter I/O calls plus a provenance hash per skill, which
            // on iCloud with ~86 skills took 2-3 minutes. Parsing is
            // independent per folder, so Promise.all cuts wall-clock to the
            // slowest single folder. Results are collected first, then written
            // into the maps in a deterministic order (folder order) so a later
            // duplicate-name folder resolves the same way it did sequentially.
            const parsedList = await Promise.all(
                entries.folders.map(async (subfolderPath) => {
                    const skillPath = `${subfolderPath}/SKILL.md`;
                    try {
                        if (!(await adapter.exists(skillPath))) return null;
                        const content = await adapter.read(skillPath);
                        const parsed = this.parseSkillMd(content, skillPath, rejected);
                        if (!parsed) return null;
                        // FIX-44-05: a trusted-tier `source:` claim is only honoured
                        // when the provenance manifest confirms the plugin materialized
                        // this exact SKILL.md; otherwise it drops to 'user'.
                        parsed.source = await this.resolveSkillSource(parsed.source, subfolderPath, content);
                        // FEATURE-2201: populate inventory from scripts/, references/,
                        // assets/, and sub-role *.skill.md files next to SKILL.md.
                        parsed.inventory = await this.loadSkillInventory(subfolderPath, parsed.isCoordinator);
                        return parsed;
                    } catch (e) {
                        console.warn(`[SelfAuthoredSkillLoader] Failed to scan ${skillPath}:`, e);
                        return null;
                    }
                }),
            );
            for (const parsed of parsedList) {
                if (parsed) skills.set(parsed.name, parsed);
            }
        } catch (e) {
            console.warn(`[SelfAuthoredSkillLoader] Failed to scan ${dir}:`, e);
        }
    }

    /**
     * Source resolver. The result feeds the SkillsTab badge AND the
     * InvokeSkillTool / ToolExecutionPipeline trust gates, so a wrong marker is
     * a privilege bug.
     *
     * FIX-44-05: a frontmatter `source:` is NOT trusted verbatim. A trusted tier
     * (builtin | bundled) is honoured only when the provenance manifest
     * confirms the plugin materialized this exact SKILL.md (name + content hash);
     * otherwise it drops to 'user'. This is what stops a third-party skill from
     * forging `source: pro` to inherit paid-skill trust. Non-trusted declarations
     * (user, agent, learned, a plugin-id) grant no elevation and pass through.
     *
     * AUDIT-034 L-17: when `source:` is absent, structural detection stands in --
     * `init_skill` always scaffolds scripts/, references/, assets/, so that shape
     * means skill-creator output ('agent'); anything else is the conservative
     * 'user' default.
     */
    private async resolveSkillSource(parsedSource: string, skillFolder: string, content: string): Promise<string> {
        const skillName = skillFolder.slice(skillFolder.lastIndexOf('/') + 1);

        // The manifest outranks the frontmatter, always. It is written by the
        // materializer or by a verified installer, both of them plugin code
        // writing into a zone the sandbox cannot reach; the frontmatter is a
        // file anyone may edit. Consulting it FIRST is what lets a registry
        // skill resolve as `registry` even though its package carries no source
        // line -- and it is why an edit that breaks the content hash drops the
        // skill back to the frontmatter's own claim, or to `user`.
        const verified = this.provenance?.getVerifiedSource(skillName, content);
        if (verified) return verified;

        if (parsedSource.length > 0) {
            if (TRUSTED_SKILL_TIERS.has(parsedSource)) {
                // A trusted claim with no matching manifest entry is fail-closed:
                // unverifiable means untrusted, not "believe the file".
                return 'user';
            }
            return parsedSource;
        }
        const adapter = this.plugin.app.vault.adapter;
        const probe = async (sub: string): Promise<boolean> => {
            try {
                return await adapter.exists(`${skillFolder}/${sub}`);
            } catch {
                return false;
            }
        };
        const [hasScripts, hasReferences, hasAssets] = await Promise.all([
            probe('scripts'),
            probe('references'),
            probe('assets'),
        ]);
        if (hasScripts && hasReferences && hasAssets) {
            return 'agent';
        }
        return 'user';
    }

    /**
     * Scan the Anthropic sub-directories under a skill folder and, for
     * coordinator skills, gather sub-role frontmatter. Errors during a
     * subfolder scan are logged and treated as empty -- the skill still
     * loads without its sidecars.
     * FEATURE-2201 / ADR-075.
     */
    private async loadSkillInventory(skillFolder: string, isCoordinator: boolean): Promise<SkillInventory> {
        const adapter = this.plugin.app.vault.adapter;
        const inventory: SkillInventory = {
            scripts: [],
            references: [],
            assets: [],
            subRoles: [],
        };

        const scriptsDir = `${skillFolder}/scripts`;
        if (await adapter.exists(scriptsDir)) {
            try {
                const entries = await adapter.list(scriptsDir);
                for (const filePath of entries.files) {
                    const filename = filePath.slice(skillFolder.length + 1); // include "scripts/"
                    const language = this.detectScriptLanguage(filePath);
                    const stat = await adapter.stat(filePath).catch(() => null);
                    inventory.scripts.push({
                        path: filename,
                        language,
                        sizeBytes: stat?.size ?? 0,
                    });
                }
            } catch (e) {
                console.warn(`[SelfAuthoredSkillLoader] Failed to scan ${scriptsDir}:`, e);
            }
        }

        const referencesDir = `${skillFolder}/references`;
        if (await adapter.exists(referencesDir)) {
            try {
                const entries = await adapter.list(referencesDir);
                for (const filePath of entries.files) {
                    inventory.references.push(filePath.slice(skillFolder.length + 1));
                }
            } catch (e) {
                console.warn(`[SelfAuthoredSkillLoader] Failed to scan ${referencesDir}:`, e);
            }
        }

        const assetsDir = `${skillFolder}/assets`;
        if (await adapter.exists(assetsDir)) {
            try {
                const entries = await adapter.list(assetsDir);
                for (const filePath of entries.files) {
                    inventory.assets.push(filePath.slice(skillFolder.length + 1));
                }
            } catch (e) {
                console.warn(`[SelfAuthoredSkillLoader] Failed to scan ${assetsDir}:`, e);
            }
        }

        if (isCoordinator) {
            try {
                const entries = await adapter.list(skillFolder);
                for (const filePath of entries.files) {
                    const filename = filePath.slice(skillFolder.length + 1);
                    if (!filename.endsWith('.skill.md')) continue;
                    const subRole = await this.parseSubRole(filePath, filename);
                    if (subRole) inventory.subRoles.push(subRole);
                }
            } catch (e) {
                console.warn(`[SelfAuthoredSkillLoader] Failed to scan sub-roles in ${skillFolder}:`, e);
            }
        }

        return inventory;
    }

    private detectScriptLanguage(path: string): SkillScriptLanguage {
        const lower = path.toLowerCase();
        if (lower.endsWith('.ts')) return 'ts';
        if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'js';
        if (lower.endsWith('.py')) return 'py';
        if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'sh';
        if (lower.endsWith('.md')) return 'md';
        return 'other';
    }

    private async parseSubRole(filePath: string, filename: string): Promise<SkillSubRole | null> {
        const adapter = this.plugin.app.vault.adapter;
        try {
            const content = await adapter.read(filePath);
            // FIX-29-05-10 (Issue #71): CRLF- and BOM-tolerant, matching
            // splitSkillFrontmatter. A .skill.md sub-role written on Windows
            // used to fall out of the role list without any rejection record.
            const fmMatch = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
            if (!fmMatch) return null;
            const fm = this.parseFrontmatter(fmMatch[1].replace(/\r\n/g, '\n'));
            const stem = filename.replace(/\.skill\.md$/, '');
            return {
                role: fm.role ?? stem,
                name: fm.name ?? stem,
                description: fm.description ?? '',
                filePath: filename,
            };
        } catch (e) {
            console.warn(`[SelfAuthoredSkillLoader] Failed to parse sub-role ${filePath}:`, e);
            return null;
        }
    }

    /**
     * Set up hot-reload watchers for skill file changes.
     * Code file changes are debounced (500ms) and serialized to prevent
     * race conditions during rapid edits.
     */
    setupWatcher(): void {
        this.plugin.registerEvent(
            this.plugin.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.isSkillFile(file)) {
                    void this.loadSkillFile(file);
                } else if (file instanceof TFile && this.isCodeFile(file)) {
                    this.debouncedCodeRecompile(file);
                }
            })
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('create', (file) => {
                if (file instanceof TFile && this.isSkillFile(file)) {
                    void this.loadSkillFile(file);
                }
            })
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('delete', (file) => {
                if (file instanceof TFile && this.isSkillFile(file)) {
                    this.removeSkillByPath(file.path);
                }
            })
        );
    }

    /**
     * Debounce code file recompilation (500ms) to avoid rapid-fire compilation
     * during incremental saves. Each file path gets its own timer.
     */
    private debouncedCodeRecompile(file: TFile): void {
        const existing = this.recompileTimers.get(file.path);
        if (existing) window.clearTimeout(existing);

        const timer = window.setTimeout(() => {
            this.recompileTimers.delete(file.path);
            // Serialize: queue behind any in-flight compilation
            this.compileQueue = this.compileQueue
                .then(() => this.handleCodeFileChange(file))
                .catch(e => console.warn(`[SelfAuthoredSkillLoader] Queued recompile failed for ${file.path}:`, e));
        }, 500);

        this.recompileTimers.set(file.path, timer);
    }

    /**
     * Get metadata summary for the SKILLS directory in the system prompt
     * (Progressive Disclosure / ADR-116: metadata only -- the body is loaded
     * on demand via the `read_skill` tool).
     *
     * For skills that ship a FEATURE-2201 inventory (scripts/references/assets)
     * or a FEATURE-2204 coordinator, this method appends a nested block with
     * the filenames and sub-roles so the agent knows what to `read_file` or
     * execute via the sandbox.
     *
     * `allowedNames` is the optional FEAT-24-09 filter: when set, only skills
     * whose name is in the set are rendered (used by per-mode allow-lists and
     * manual toggles in AgentSidebarView).
     */
    getMetadataSummary(allowedNames?: ReadonlySet<string>): string {
        if (this.skills.size === 0) return '';
        const skills = [...this.skills.values()].filter(
            s => !allowedNames || allowedNames.has(s.name),
        );
        if (skills.length === 0) return '';
        return skills.map(s => this.renderSkillSummary(s)).join('\n');
    }

    private renderSkillSummary(s: SelfAuthoredSkill): string {
        // FEAT-24-09: trigger removed from the head -- in the on-demand model
        // the LLM picks a skill by description, not by regex match.
        // AUDIT 2026-07-14 (Codex review, M-1): code-module names are
        // attacker-controlled frontmatter (see loadCodeModules) and were
        // interpolated raw into the head. Sanitise them like name/description.
        const codeBadge = s.codeModules.length > 0
            ? ` [code: ${s.codeModuleInfos.map(m => sanitizeDirectoryEntry(m.name, 60)).join(', ')}]`
            : '';
        const coordinatorBadge = s.isCoordinator ? ' (coordinator)' : '';
        // AUDIT 2026-07-14 (Codex) M-1: sanitise name/description before they
        // enter the cached <available_skills> block (defang boundary tags).
        const head = `- ${sanitizeDirectoryEntry(s.name, 80)}${coordinatorBadge}: ${sanitizeDirectoryEntry(s.description, SKILL_DESCRIPTION_PROMPT_CAP)}${codeBadge}`;
        const inventoryLines = this.renderInventoryLines(s);
        return inventoryLines.length === 0 ? head : [head, ...inventoryLines].join('\n');
    }

    private renderInventoryLines(s: SelfAuthoredSkill): string[] {
        const { scripts, references, assets, subRoles } = s.inventory;
        const lines: string[] = [];

        // AUDIT 2026-07-14 (Codex review, M-1): these fields (paths, sub-role
        // role/description from free-form frontmatter) render RAW into the same
        // <available_skills> block as the sanitised head. A coordinator sub-role
        // description carrying `</available_skills>` would break the wrapper
        // without any reassembly. Sanitise every interpolated field.
        if (scripts.length > 0) {
            const rendered = scripts.map(sc => {
                const execTag = sc.language === 'ts' || sc.language === 'js'
                    ? 'sandbox-executable'
                    : `${sanitizeDirectoryEntry(sc.language, 20)}, reference-only`;
                return `${sanitizeDirectoryEntry(sc.path, 120)} (${execTag})`;
            }).join(', ');
            lines.push(`  Scripts: ${rendered}`);
        }

        if (references.length > 0) {
            lines.push(`  References (on-demand via read_file): ${references.map(r => sanitizeDirectoryEntry(r, 120)).join(', ')}`);
        }

        if (assets.length > 0) {
            lines.push(`  Assets: ${assets.map(a => sanitizeDirectoryEntry(a, 120)).join(', ')}`);
        }

        if (s.isCoordinator && subRoles.length > 0) {
            const rendered = subRoles.map(r =>
                `${sanitizeDirectoryEntry(r.filePath, 120)} (${sanitizeDirectoryEntry(r.role, 60)}: ${sanitizeDirectoryEntry(r.description, SKILL_SUBROLE_DESCRIPTION_PROMPT_CAP)})`,
            ).join(', ');
            lines.push(`  Sub-roles (read on demand): ${rendered}`);
        }

        return lines;
    }

    /**
     * Get full skill body for activation (Progressive Disclosure: full content).
     */
    getSkillBody(name: string): string | undefined {
        return this.skills.get(name)?.body;
    }

    /**
     * Match a user message against skill triggers. Returns matching skills.
     */
    matchSkills(userMessage: string): SelfAuthoredSkill[] {
        const matches: SelfAuthoredSkill[] = [];
        for (const skill of this.skills.values()) {
            if (skill.trigger.test(userMessage)) {
                matches.push(skill);
            }
        }
        return matches;
    }

    /**
     * Get all loaded skills.
     */
    getAllSkills(): SelfAuthoredSkill[] {
        return [...this.skills.values()];
    }

    /**
     * Get a skill by name.
     */
    getSkill(name: string): SelfAuthoredSkill | undefined {
        return this.skills.get(name);
    }

    /**
     * Increment the success count for a skill.
     */
    async incrementSuccess(name: string): Promise<void> {
        const skill = this.skills.get(name);
        if (!skill) return;
        skill.successCount++;
        // Update the file
        await this.updateFrontmatterField(skill.filePath, 'successCount', String(skill.successCount));
    }

    /**
     * Get the skills directory path for new user/learned skills. Resolves to
     * `<agent-folder>/skills/` per ADR-072 (configurable root). Historical
     * location `.obsilo-sync/skills/` is migrated on plugin start.
     */
    getSkillsDir(): string {
        return this.getUserSkillsDir();
    }

    // -----------------------------------------------------------------------
    // Code Module Management (public, used by ManageSkillTool)
    // -----------------------------------------------------------------------

    /**
     * Compile a TypeScript code module for a skill.
     * Reads source from code/{moduleName}.ts, compiles via esbuild,
     * and caches the result in code-compiled/{moduleName}.js.
     *
     * @returns The CodeModuleInfo with compiledJs populated.
     */
    async compileCodeModule(
        skillName: string,
        moduleName: string,
        dependencies?: string[],
    ): Promise<CodeModuleInfo> {
        if (!this.esbuildManager) {
            throw new Error('EsbuildWasmManager not available. Cannot compile code modules.');
        }

        const skill = this.skills.get(skillName);
        if (!skill) throw new Error(`Skill "${sanitizeDirectoryEntry(skillName, 80)}" not found.`);

        const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');
        const sourceFile = this.plugin.app.vault.getAbstractFileByPath(
            `${skillDir}/code/${moduleName}.ts`
        );
        if (!(sourceFile instanceof TFile)) {
            throw new Error(`Source file not found: ${skillDir}/code/${moduleName}.ts`);
        }

        const sourceCode = await this.plugin.app.vault.read(sourceFile);

        // Compile
        let compiledJs: string;
        if (dependencies && dependencies.length > 0) {
            compiledJs = await this.esbuildManager.build(sourceCode, dependencies);
        } else {
            compiledJs = await this.esbuildManager.transform(sourceCode);
        }

        // Cache compiled JS
        const compiledDir = `${skillDir}/code-compiled`;
        const compiledPath = `${compiledDir}/${moduleName}.js`;

        // Ensure code-compiled directory exists
        const compiledFolder = this.plugin.app.vault.getAbstractFileByPath(compiledDir);
        if (!(compiledFolder instanceof TFolder)) {
            await this.plugin.app.vault.createFolder(compiledDir);
        }

        // Write compiled JS
        const existingCompiled = this.plugin.app.vault.getAbstractFileByPath(compiledPath);
        if (existingCompiled instanceof TFile) {
            await this.plugin.app.vault.modify(existingCompiled, compiledJs);
        } else {
            await this.plugin.app.vault.create(compiledPath, compiledJs);
        }

        // Parse the definition from the source code
        const moduleInfo = this.parseCodeModuleDefinition(sourceCode, moduleName);
        moduleInfo.compiledJs = compiledJs;

        // Update skill's codeModuleInfos
        const existingIdx = skill.codeModuleInfos.findIndex(m => m.file === moduleName);
        if (existingIdx >= 0) {
            skill.codeModuleInfos[existingIdx] = moduleInfo;
        } else {
            skill.codeModuleInfos.push(moduleInfo);
        }

        // Ensure codeModules list includes this module
        if (!skill.codeModules.includes(moduleName)) {
            skill.codeModules.push(moduleName);
        }

        return moduleInfo;
    }

    /**
     * Register all code module tools for a skill with the ToolRegistry.
     */
    registerCodeTools(skill: SelfAuthoredSkill): void {
        if (!this.toolRegistry || !this.sandboxExecutor) return;

        for (const moduleInfo of skill.codeModuleInfos) {
            if (!moduleInfo.compiledJs) continue;

            // SBX-3: a skill-authored code tool must not shadow an existing
            // tool. `moduleInfo.name` comes from the skill's code-module block
            // and is attacker-controlled; without this guard a vault-dropped
            // skill named `read_file`/`write_file`/... would silently overwrite
            // the trusted built-in, so the LLM's calls to a trusted-named tool
            // would run sandboxed skill code. Reload unregisters skill tools
            // first, so this only rejects a genuine collision with a built-in
            // (or another skill's tool of the same name).
            if (this.toolRegistry.hasTool(moduleInfo.name as ToolName)) {
                console.warn(
                    `[SelfAuthoredSkillLoader] Refusing code tool '${moduleInfo.name}': `
                    + 'name collides with an existing tool. Skill code tools must not shadow built-ins.',
                );
                continue;
            }

            const definition: DynamicToolDefinition = {
                name: moduleInfo.name,
                description: moduleInfo.description,
                input_schema: moduleInfo.inputSchema,
                isWriteOperation: moduleInfo.isWriteOperation,
                dependencies: moduleInfo.dependencies,
            };

            const tool = DynamicToolFactory.create(
                definition,
                moduleInfo.compiledJs,
                this.sandboxExecutor,
                this.plugin,
            );
            this.toolRegistry.register(tool);
            console.debug(`[SelfAuthoredSkillLoader] Registered code tool: ${moduleInfo.name}`);
        }
    }

    /**
     * Unregister all code module tools for a skill from the ToolRegistry.
     */
    unregisterCodeTools(skill: SelfAuthoredSkill): void {
        if (!this.toolRegistry) return;

        for (const moduleInfo of skill.codeModuleInfos) {
            this.toolRegistry.unregister(moduleInfo.name as ToolName);
            console.debug(`[SelfAuthoredSkillLoader] Unregistered code tool: ${moduleInfo.name}`);
        }
    }

    /**
     * Write a TypeScript source file into a skill's code/ directory.
     */
    async writeCodeModuleSource(
        skillName: string,
        moduleName: string,
        sourceCode: string,
    ): Promise<void> {
        const skill = this.skills.get(skillName);
        if (!skill) throw new Error(`Skill "${sanitizeDirectoryEntry(skillName, 80)}" not found.`);

        const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');
        const codeDir = `${skillDir}/code`;
        const filePath = `${codeDir}/${moduleName}.ts`;

        // Ensure code directory exists
        const codeFolder = this.plugin.app.vault.getAbstractFileByPath(codeDir);
        if (!(codeFolder instanceof TFolder)) {
            await this.plugin.app.vault.createFolder(codeDir);
        }

        // Write the source file
        const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, sourceCode);
        } else {
            await this.plugin.app.vault.create(filePath, sourceCode);
        }
    }

    /**
     * Delete code module files (source + compiled) for a skill.
     */
    async deleteCodeModules(skill: SelfAuthoredSkill): Promise<void> {
        const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');

        // Delete code-compiled/ files
        for (const moduleName of skill.codeModules) {
            const compiledPath = `${skillDir}/code-compiled/${moduleName}.js`;
            const compiledFile = this.plugin.app.vault.getAbstractFileByPath(compiledPath);
            if (compiledFile instanceof TFile) {
                await this.plugin.app.fileManager.trashFile(compiledFile);
            }

            const sourcePath = `${skillDir}/code/${moduleName}.ts`;
            const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
            if (sourceFile instanceof TFile) {
                await this.plugin.app.fileManager.trashFile(sourceFile);
            }
        }

        // Try to remove empty directories
        const compiledDir = this.plugin.app.vault.getAbstractFileByPath(`${skillDir}/code-compiled`);
        if (compiledDir instanceof TFolder && compiledDir.children.length === 0) {
            await this.plugin.app.fileManager.trashFile(compiledDir);
        }
        const codeDir = this.plugin.app.vault.getAbstractFileByPath(`${skillDir}/code`);
        if (codeDir instanceof TFolder && codeDir.children.length === 0) {
            await this.plugin.app.fileManager.trashFile(codeDir);
        }
    }

    /**
     * Read source code of a code module.
     */
    async readCodeModuleSource(skillName: string, moduleName: string): Promise<string | null> {
        const skill = this.skills.get(skillName);
        if (!skill) return null;

        const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');
        const sourcePath = `${skillDir}/code/${moduleName}.ts`;
        const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
        if (!(sourceFile instanceof TFile)) return null;

        return await this.plugin.app.vault.read(sourceFile);
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private async loadSkillFile(file: TFile): Promise<void> {
        try {
            const content = await this.plugin.app.vault.read(file);
            const parsed = this.parseSkillMd(content, file.path);
            if (parsed) {
                const skillFolder = file.path.replace(/\/SKILL\.md$/, '');
                // AUDIT-034 L-17 / FIX-44-05: keep the hot-reload path aligned
                // with the initial scan -- structural detection for a missing
                // `source:`, and provenance verification for a trusted-tier one.
                parsed.source = await this.resolveSkillSource(parsed.source, skillFolder, content);
                parsed.inventory = await this.loadSkillInventory(skillFolder, parsed.isCoordinator);
                this.skills.set(parsed.name, parsed);
                // RE-AUDIT N-4: the else-branch below unregisters the skill's
                // code tools. Without re-registering here, the break-fix-save
                // cycle left them dead until a full plugin reload -- the
                // teardown was not reversible in-session.
                if (parsed.codeModules.length > 0) {
                    await this.loadCodeModules(parsed);
                    this.registerCodeTools(parsed);
                }
            } else {
                // AUDIT FIX-29-05 I-1: the previously loaded copy would
                // otherwise stay live, so breaking a skill by editing it looked
                // like the edit simply had no effect.
                this.removeSkillByPath(file.path);
            }
            // AUDIT FIX-29-05 I-1: this is the hot-reload path -- edit a skill,
            // break its frontmatter -- which is precisely the moment
            // FIX-29-05-01 exists for, and it fired no Notice. The call is
            // signature-deduped, so it is free when nothing changed.
            this.reportRejections();
        } catch (e) {
            console.warn(`[SelfAuthoredSkillLoader] Failed to load ${file.path}:`, e);
        }
    }


    /**
     * Load cached compiled JS for a skill's code modules.
     * This does NOT trigger compilation — only loads from code-compiled/ cache.
     */
    private async loadCodeModules(skill: SelfAuthoredSkill): Promise<void> {
        const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');

        for (const moduleName of skill.codeModules) {
            try {
                // Try to load compiled JS from cache
                const compiledPath = `${skillDir}/code-compiled/${moduleName}.js`;
                const compiledFile = this.plugin.app.vault.getAbstractFileByPath(compiledPath);
                if (!(compiledFile instanceof TFile)) {
                    console.debug(`[SelfAuthoredSkillLoader] No cached compiled JS for ${moduleName} in skill "${skill.name}"`);
                    continue;
                }

                const compiledJs = await this.plugin.app.vault.read(compiledFile);

                // Try to read source to get definition metadata
                const sourcePath = `${skillDir}/code/${moduleName}.ts`;
                const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
                let moduleInfo: CodeModuleInfo;

                if (sourceFile instanceof TFile) {
                    const sourceCode = await this.plugin.app.vault.read(sourceFile);
                    // SBX-4 (defense-in-depth): the compiled cache is loaded
                    // straight from the vault without an integrity check. Validate
                    // the source before trusting the module; the Chromium iframe
                    // sandbox is the boundary that bounds any residual risk. A full
                    // fix (recompile from source or hash-verify the cache) is
                    // tracked as a follow-up.
                    const astCheck = AstValidator.validate(sourceCode);
                    if (!astCheck.valid) {
                        console.warn(
                            `[SelfAuthoredSkillLoader] Skipping code module ${moduleName}: `
                            + `source rejected by validator (${astCheck.errors.join('; ')})`,
                        );
                        continue;
                    }
                    moduleInfo = this.parseCodeModuleDefinition(sourceCode, moduleName);
                } else {
                    // Fallback: minimal info from module name
                    moduleInfo = {
                        name: `custom_${moduleName.replace(/[^a-zA-Z0-9_]/g, '_')}`,
                        file: moduleName,
                        // RE-AUDIT L-1: this becomes a TOOL SCHEMA description sent to
            // the API. `moduleName` is a filename inside an author-controlled
            // skill folder, so it is untrusted input on a prompt path.
            description: `Code module: ${sanitizeDirectoryEntry(moduleName, 60)}`,
                        inputSchema: { type: 'object', properties: {} },
                        isWriteOperation: false,
                        dependencies: [],
                    };
                }

                moduleInfo.compiledJs = compiledJs;
                skill.codeModuleInfos.push(moduleInfo);
            } catch (e) {
                console.warn(`[SelfAuthoredSkillLoader] Failed to load code module ${moduleName}:`, e);
            }
        }
    }

    /**
     * Parse the `export const definition = {...}` from a TypeScript source file.
     * Uses safe field extraction — NO code evaluation (no eval/new Function).
     * Extracts individual fields via regex to avoid executing untrusted code
     * in the plugin context.
     */
    private parseCodeModuleDefinition(sourceCode: string, moduleName: string): CodeModuleInfo {
        const defaults: CodeModuleInfo = {
            name: `custom_${moduleName.replace(/[^a-zA-Z0-9_]/g, '_')}`,
            file: moduleName,
            // RE-AUDIT L-1: this becomes a TOOL SCHEMA description sent to
            // the API. `moduleName` is a filename inside an author-controlled
            // skill folder, so it is untrusted input on a prompt path.
            description: `Code module: ${sanitizeDirectoryEntry(moduleName, 60)}`,
            inputSchema: { type: 'object', properties: {} },
            isWriteOperation: false,
            dependencies: [],
        };

        try {
            // Extract the definition block (between export const definition = { ... };)
            const defMatch = sourceCode.match(
                /export\s+const\s+definition\s*=\s*(\{[\s\S]*?\n\});/
            );
            if (!defMatch) return defaults;
            const block = defMatch[1];

            // Safe field extractors — only parse string/boolean/array literals
            const name = this.extractStringField(block, 'name') ?? defaults.name;
            const description = this.extractStringField(block, 'description') ?? defaults.description;
            const isWriteOperation = this.extractBooleanField(block, 'isWriteOperation') ?? false;
            const dependencies = this.extractStringArrayField(block, 'dependencies') ?? [];

            // Extract input_schema as JSON — it's a nested object, parse carefully
            let inputSchema = defaults.inputSchema;
            const schemaMatch = block.match(/input_schema\s*:\s*(\{[\s\S]*?\n\s{4}\})/);
            if (schemaMatch) {
                try {
                    // Normalize JS object literal to valid JSON:
                    // - single quotes → double quotes (for string values)
                    // - unquoted keys → quoted keys
                    // - trailing commas removed
                    const jsonStr = schemaMatch[1]
                        .replace(/'/g, '"')
                        .replace(/(\w+)\s*:/g, '"$1":')
                        .replace(/,(\s*[}\]])/g, '$1');
                    const raw: unknown = JSON.parse(jsonStr);
                    if (
                        raw !== null && typeof raw === 'object' &&
                        'type' in raw && (raw as Record<string, unknown>).type === 'object'
                    ) {
                        const candidate = raw as Record<string, unknown>;
                        if (!candidate.properties || typeof candidate.properties === 'object') {
                            inputSchema = raw as CodeModuleInfo['inputSchema'];
                        }
                    }
                } catch {
                    // Schema parsing failed — use defaults
                }
            }

            return { name, file: moduleName, description, inputSchema, isWriteOperation, dependencies };
        } catch (e) {
            console.warn(`[SelfAuthoredSkillLoader] Failed to parse definition from ${moduleName}.ts:`, e);
            return defaults;
        }
    }

    /** Escape regex metacharacters in a string (AUDIT-007 M-2). */
    private escapeForRegex(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Extract a string field value from a JS object literal block. */
    private extractStringField(block: string, field: string): string | undefined {
        // Matches: field: 'value' or field: "value"
        // AUDIT-007 M-2: Escape field name to prevent ReDoS
        const match = block.match(new RegExp(`${this.escapeForRegex(field)}\\s*:\\s*['"]([^'"]*?)['"]`));
        return match ? match[1] : undefined;
    }

    /** Extract a boolean field value from a JS object literal block. */
    private extractBooleanField(block: string, field: string): boolean | undefined {
        const match = block.match(new RegExp(`${this.escapeForRegex(field)}\\s*:\\s*(true|false)`));
        return match ? match[1] === 'true' : undefined;
    }

    /** Extract a string array field from a JS object literal block. */
    private extractStringArrayField(block: string, field: string): string[] | undefined {
        const match = block.match(new RegExp(`${this.escapeForRegex(field)}\\s*:\\s*\\[([^\\]]*)\\]`));
        if (!match) return undefined;
        if (!match[1].trim()) return [];
        return match[1].split(',')
            .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
    }

    /**
     * Handle changes to .ts files in code/ directories.
     * Re-compiles and re-registers the affected code module.
     */
    private async handleCodeFileChange(file: TFile): Promise<void> {
        // Find which skill this code file belongs to
        const skill = this.findSkillByCodeFile(file.path);
        if (!skill) return;

        const moduleName = file.basename; // filename without extension

        try {
            // Find dependencies from existing module info
            const existingInfo = skill.codeModuleInfos.find(m => m.file === moduleName);
            const dependencies = existingInfo?.dependencies;

            // Unregister old tool
            if (existingInfo && this.toolRegistry) {
                this.toolRegistry.unregister(existingInfo.name as ToolName);
            }

            // Recompile and register
            await this.compileCodeModule(skill.name, moduleName, dependencies);
            this.registerCodeTools(skill);
            console.debug(`[SelfAuthoredSkillLoader] Hot-reloaded code module: ${moduleName} in skill "${skill.name}"`);
        } catch (e) {
            console.warn(`[SelfAuthoredSkillLoader] Failed to hot-reload ${file.path}:`, e);
        }
    }

    private findSkillByCodeFile(filePath: string): SelfAuthoredSkill | undefined {
        for (const skill of this.skills.values()) {
            const skillDir = skill.filePath.replace(/\/SKILL\.md$/, '');
            if (filePath.startsWith(`${skillDir}/code/`)) {
                return skill;
            }
        }
        return undefined;
    }

    private parseSkillMd(content: string, filePath: string, rejected: Map<string, RejectedSkill> = this.rejected): SelfAuthoredSkill | null {
        // `rejected` defaults to the live map (hot-reload path). loadAll() passes
        // its LOCAL map so an atomic reload records into the set it will swap in,
        // not the one currently serving readers.
        // Accept two metadata shapes:
        //   1) YAML frontmatter at the top (Vault Operator + Anthropic standard).
        //   2) HTML-comment metadata block anywhere in the file (real-world
        //      Anthropic skills sometimes ship this form -- EPIC-022 beta
        //      feedback 2026-04-19).
        let frontmatter: string | null = null;
        let body: string | null = null;

        // RE-AUDIT N-5: shared with SkillsManager and WriteSkillTool so the
        // three readers cannot disagree about where the frontmatter ends.
        const yaml = splitSkillFrontmatter(content);
        if (yaml) {
            frontmatter = yaml.frontmatter;
            body = yaml.body.trim();
        } else {
            const html = content.match(/<!--\s*(?:Metadata|metadata|SKILL|skill)\s*\n([\s\S]*?)\n-->/);
            if (html) {
                // AUDIT FIX-29-05 L-8: keys inside an HTML-comment metadata
                // block are commonly indented for readability. The shared
                // parser only accepts keys at column 0 (deliberate: that is
                // what stops an indented `Trigger:` inside a description from
                // becoming a phantom top-level key). Dedent the capture here
                // rather than relaxing the rule for every SKILL.md shape.
                frontmatter = dedent(html[1]);
                // Body = full content WITHOUT the metadata block so the skill
                // markdown the user wrote still reaches the prompt.
                body = content.replace(html[0], '').trim();
            }
        }

        if (frontmatter === null || body === null) {
            // RE-AUDIT N-4: the most common way a user breaks a skill -- a
            // mistyped or missing `---` fence -- used to return null here
            // WITHOUT recording a rejection. The hot-reload path then tore the
            // skill down while the Notice saw an unchanged signature and stayed
            // silent, and Settings showed nothing. Record it like any other
            // rejection so the user learns what happened.
            this.recordRejection(filePath, 'no YAML frontmatter or <!-- Metadata --> block found', rejected);
            return null;
        }

        // Parse frontmatter key-value pairs
        const fm = this.parseFrontmatter(frontmatter);

        // FEAT-29-05: hard validation gate. Skills whose frontmatter fails
        // the Anthropic-conformant rules (kebab-case name, max-1024 desc,
        // no reserved words, etc.) are rejected with an explicit warning
        // so the user knows why the skill did not load. Soft warnings
        // (unexpected keys, TODO placeholder) surface but the skill still
        // loads.
        const validation = validateSkillFrontmatter(fm);
        if (!validation.valid) {
            this.recordRejection(filePath, validation.errors.join('; '), rejected);
            return null;
        }
        // A file that now parses must not linger in the rejected list.
        rejected.delete(filePath);
        if (validation.warnings.length > 0) {
            console.debug(
                `[SelfAuthoredSkillLoader] Warnings for ${filePath}: ${validation.warnings.join('; ')}`,
            );
        }

        const triggerSource = fm.trigger ?? fm.name.toLowerCase();
        // M-3: Use safeRegex to prevent ReDoS from malicious trigger patterns
        const trigger = safeRegex(triggerSource, 'i');

        return {
            name: fm.name,
            description: fm.description,
            trigger,
            triggerSource,
            // AUDIT-034 L-17: leave a sentinel when the SKILL.md does not
            // carry an explicit `source:` frontmatter so the caller (scan
            // or hot-reload) can run the folder-structure check before
            // falling back to the conservative `user` default. Setting it
            // here unconditionally to `user` would also tag agent-authored
            // skills that predate the FEAT-29-13 stamp, which makes the
            // cross-module trust gate in ToolExecutionPipeline harder to
            // reason about (Agent skills look like manual imports).
            source: fm.source ?? '',
            requiredTools: fm.requiredTools ? this.parseArray(fm.requiredTools) : [],
            // FEAT-29-10 follow-up: support both camelCase and snake_case
            // so authors using Anthropic-style frontmatter (`allowed_tools`)
            // don't trip on the parser.
            allowedTools: fm.allowedTools
                ? this.parseArray(fm.allowedTools)
                : fm.allowed_tools
                    ? this.parseArray(fm.allowed_tools)
                    : [],
            codeModules: fm.codeModules ? this.parseArray(fm.codeModules) : [],
            codeModuleInfos: [],
            createdAt: fm.createdAt ? new Date(fm.createdAt) : new Date(),
            successCount: fm.successCount ? parseInt(fm.successCount, 10) : 0,
            body,
            chatTitle: typeof fm.chatTitle === 'string' ? fm.chatTitle : undefined,
            filePath,
            // FEATURE-2201: inventory gets populated by scanSkillsFrom() after parse.
            inventory: { scripts: [], references: [], assets: [], subRoles: [] },
            isCoordinator: fm.type === 'coordinator',
        };
    }

    /**
     * FIX-29-05-02: delegates to the shared parser so this loader and
     * SkillsManager read the same SKILL.md identically (block scalars
     * included). See skillFrontmatterParser.ts for the supported shape.
     */
    private parseFrontmatter(text: string): Record<string, string> {
        return parseSkillFrontmatterBlock(text);
    }

    private parseArray(value: string): string[] {
        // Support [a, b, c] format
        const match = value.match(/^\[(.*)]$/);
        if (match) {
            return match[1].split(',').map(s => s.trim()).filter(Boolean);
        }
        return value.split(',').map(s => s.trim()).filter(Boolean);
    }

    private isSkillFile(file: TFile): boolean {
        const userDir = this.getUserSkillsDir();
        return (file.path.startsWith(this.skillsDir) || file.path.startsWith(userDir))
            && file.name === 'SKILL.md';
    }

    private isCodeFile(file: TFile): boolean {
        const userDir = this.getUserSkillsDir();
        return (file.path.startsWith(this.skillsDir) || file.path.startsWith(userDir))
            && file.extension === 'ts'
            && file.path.includes('/code/');
    }

    /**
     * Remove a skill from the in-memory map by name.
     * Does NOT delete files -- caller is responsible for file cleanup.
     */
    removeSkill(name: string): void {
        const skill = this.skills.get(name);
        if (skill) {
            this.unregisterCodeTools(skill);
            this.skills.delete(name);
            console.debug(`[SelfAuthoredSkillLoader] Removed skill: ${name}`);
        }
    }

    private removeSkillByPath(path: string): void {
        // RE-AUDIT N-9: without this, deleting a broken skill folder -- the
        // obvious repair -- leaves a ghost in the Settings rejected box and
        // inflates the next Notice count with a folder that no longer exists.
        this.rejected.delete(path);
        for (const [name, skill] of this.skills) {
            if (skill.filePath === path) {
                // Unregister code tools before removing
                this.unregisterCodeTools(skill);
                this.skills.delete(name);
                console.debug(`[SelfAuthoredSkillLoader] Removed skill: ${name}`);
                return;
            }
        }
    }

    private async updateFrontmatterField(filePath: string, key: string, value: string): Promise<void> {
        // Use adapter — vault API doesn't index .obsidian/ paths
        const adapter = this.plugin.app.vault.adapter;
        if (!(await adapter.exists(filePath))) return;
        const content = await adapter.read(filePath);
        // FIX-29-05-10 (Issue #71): CRLF- and BOM-tolerant, matching
        // splitSkillFrontmatter. On a CRLF manifest this used to be a silent
        // no-op, so successCount never advanced for Windows-authored skills.
        const fmMatch = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
        if (!fmMatch) return;

        // Operate on LF, then write the block back in the file's own style so a
        // CRLF manifest does not end up with a mixed-ending frontmatter block.
        const lineEnding = detectLineEnding(content);
        const fm = fmMatch[1].replace(/\r\n/g, '\n');
        // AUDIT-007 M-2: Escape key to prevent ReDoS
        const regex = new RegExp(`^${this.escapeForRegex(key)}:.*$`, 'm');
        const updatedLf = regex.test(fm)
            ? fm.replace(regex, `${key}: ${value}`)
            : fm + `\n${key}: ${value}`;
        const updated = lineEnding === '\n' ? updatedLf : updatedLf.replace(/\n/g, lineEnding);

        const newContent = content.replace(
            fmMatch[0],
            `---${lineEnding}${updated}${lineEnding}---`,
        );
        await adapter.write(filePath, newContent);
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
