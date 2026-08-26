/**
 * WriteSkillTool -- the write counterpart of read_skill.
 *
 * read_skill loads a skill's body by NAME, deliberately without exposing the
 * on-disk path. That left the agent unable to REVISE a skill: it had to guess a
 * filesystem path for write_file, and guessing `.obsidian/plugins/.../skills/`
 * (the plugin install dir, a hard deny-zone) is what made skill-creator-pro
 * believe it had "no rights" to the skill folder. The real skill workspace at
 * `<agentFolder>/data/skills/{name}/` is writable (agentFolderGuard exempts
 * `skills/`); the gap was purely the missing by-name write primitive.
 *
 * This tool resolves the skill by name (never a guessed path), writes through
 * the vault adapter -- the same sink write_file uses for hidden paths, so the
 * SkillWriteInterceptor snapshots the change for undo -- and refreshes the
 * loader so the edit is live immediately.
 *
 * Scope: REVISE only. The skill must already exist; creating a new skill stays
 * with the skill-creator skill (init_skill). A `file` argument (default
 * SKILL.md) allows revising references/, scripts/ and assets/ too.
 *
 * Trust: editing a bundled/pro skill is turned into a local user override --
 * the frontmatter `source:` is flipped to `user` so the BuiltinSkillMaterializer
 * keeps the edit (it wipes trusted-tier folders on a bundle change), and the
 * result warns that the skill loses its trusted-tier privileges. user/agent/
 * learned skills keep their source untouched.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import { TRUSTED_SKILL_TIERS } from '../../skills/SkillProvenanceStore';
import { loadableSkills } from '../../context/SkillsManager';
import { splitSkillFrontmatter } from '../../skills/skillFrontmatterParser';
import { detectLineEnding } from '../../utils/frontmatterSplit';
import { getSelfAuthoredSkillsDir } from '../../utils/agentFolder';
import { assertSafePathSegment } from '../../utils/safePathName';
import type ObsidianAgentPlugin from '../../../main';
import type { SelfAuthoredSkillLoader } from '../../skills/SelfAuthoredSkillLoader';

interface AdapterLike {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
}

export class WriteSkillTool extends BaseTool<'write_skill'> {
    readonly name = 'write_skill' as const;
    readonly isWriteOperation = true;

    private readonly skillLoader: SelfAuthoredSkillLoader | null;

    constructor(plugin: ObsidianAgentPlugin, skillLoader: SelfAuthoredSkillLoader | null) {
        super(plugin);
        this.skillLoader = skillLoader;
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'write_skill',
            description:
                'Revise an EXISTING skill from the SKILLS directory by NAME, without needing its '
                + 'on-disk path. Use it to improve or fix a skill you loaded with read_skill: overwrite '
                + 'the SKILL.md body, or a file under references/, scripts/ or assets/. Creating a NEW '
                + 'skill is best done through the skill-creator skill (init_skill) when it is installed. A snapshot '
                + 'is taken automatically so the change can be reverted. Editing a bundled or pro skill '
                + 'turns it into a local user copy that no longer receives plugin-bundle updates and no '
                + 'longer runs with trusted-tier privileges.',
            input_schema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Exact skill name as it appears in the SKILLS directory.',
                    },
                    content: {
                        type: 'string',
                        description:
                            'New content. For SKILL.md (the default) this is the workflow body; the '
                            + "skill's frontmatter is preserved (use `description` to change the one-line "
                            + 'summary). For a file under references/, scripts/ or assets/, this is the '
                            + 'full file content.',
                    },
                    file: {
                        type: 'string',
                        description:
                            'Optional path, relative to the skill folder, to write. Examples: '
                            + '"references/style.md", "scripts/build.js". Defaults to "SKILL.md". Must '
                            + 'stay inside the skill folder (no ".." or absolute paths).',
                    },
                    description: {
                        type: 'string',
                        description:
                            'Optional. When writing SKILL.md, replace the one-line description in the '
                            + 'frontmatter (also shown in the SKILLS directory).',
                    },
                },
                required: ['name', 'content'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;

        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) {
            callbacks.pushToolResult(this.formatError(new Error('name is required')));
            return;
        }
        if (typeof input.content !== 'string') {
            callbacks.pushToolResult(this.formatError(new Error('content is required (string)')));
            return;
        }
        const content = input.content;

        // Defense in depth: the name becomes a path segment. A real skill name is
        // a single folder segment; reject anything that could escape.
        try {
            assertSafePathSegment(name, 'skill name');
        } catch (e) {
            callbacks.pushToolResult(this.formatError(e));
            return;
        }

        // Resolve the skill by name and read its current trust source.
        const resolved = await this.resolveSkill(name);
        if (!resolved) {
            const available = await this.collectAvailableNames();
            const list = available.length > 0 ? available.join(', ') : '(no skills installed)';
            callbacks.pushToolResult(this.formatError(new Error(
                `Skill "${name}" not found. Available skills: ${list}. `
                + 'write_skill only revises an existing skill; create a new one with the '
                + 'skill-creator skill (init_skill) when it is installed.',
            )));
            return;
        }
        const source = resolved.source;
        const trusted = TRUSTED_SKILL_TIERS.has(source);
        // Use the resolved skill's REAL folder (from its filePath), not a folder
        // rebuilt from `name`. When the on-disk folder name differs from the
        // frontmatter name (imported skills), rebuilding from name would write to
        // a new empty folder and leave the real skill untouched.
        const skillFolder = resolved.folder;
        const skillMdPath = `${skillFolder}/SKILL.md`;

        // Validate the relative target file. Collision checks use NFKC + lower
        // case -- the way a case-insensitive filesystem folds names -- instead of
        // an ASCII allowlist, so legitimate resource names with spaces or umlauts
        // ("references/Key Points.md") are allowed while homographs that FOLD onto
        // a protected name are caught. Rejected: absolute paths, control chars and
        // the ADS colon; any segment that is empty, has leading/trailing
        // whitespace or a trailing dot (a filesystem strips those and could fold
        // onto a protected name), or whose folded form starts with "." (blocks the
        // internal `.versions/` snapshot store and `..` in every casing/width --
        // U+002E has no case mapping and the fold covers U+FF0E).
        const rawFile = typeof input.file === 'string' && input.file.trim().length > 0
            ? input.file.trim()
            : 'SKILL.md';
        const relFile = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
        const segments = relFile.split('/');
        // Fold the way a case-insensitive filesystem does. The UPPERCASE round
        // trip is load-bearing: NTFS/exFAT case-fold via uppercase, so U+0131
        // (dotless i) uppercases to "I" and folds "skıll.md" onto SKILL.md --
        // a plain toLowerCase leaves U+0131 unchanged and would miss it.
        const foldName = (s: string): string => s.normalize('NFKC').toUpperCase().toLowerCase();
        if (
            !relFile
            || relFile.startsWith('/')
            || [...relFile].some((ch) => { const c = ch.codePointAt(0) ?? 0; return c < 0x20 || c === 0x7f || c === 0x3a; })
            || segments.some((seg) =>
                seg === ''
                || seg !== seg.trim()
                || foldName(seg).startsWith('.')
                || foldName(seg).endsWith('.'))
        ) {
            callbacks.pushToolResult(this.formatError(new Error(
                `Invalid file path "${rawFile}": use a relative path inside the skill folder `
                + '(e.g. "references/x.md", "scripts/y.js"). No "..", absolute paths, control '
                + 'characters, or dot-prefixed/hidden segments such as .versions/.',
            )));
            return;
        }

        // Any variant of SKILL.md that a case-insensitive filesystem folds onto
        // the manifest -- ASCII case ("Skill.md") and Unicode homographs (U+017F
        // long-s, U+212A Kelvin, all fold to "skill.md" under NFKC+lowercase) --
        // is routed through the frontmatter-managed path and written to the
        // CANONICAL name, so name-forcing and source enforcement can never be
        // bypassed by casing, width or homograph.
        const isManifest = foldName(relFile) === 'skill.md';
        const targetPath = isManifest ? skillMdPath : `${skillFolder}/${relFile}`;

        // Respect user governance. These writes go through the adapter, bypassing
        // the pipeline's validatePaths, so EVERY path this call will touch -- the
        // target AND the manifest that a trusted sub-file edit flips to a user
        // override -- must be re-checked against .obsidian-agentprotected /
        // .obsidian-agentignore.
        const willFlipManifest = !isManifest && trusted;
        const writeTargets = isManifest
            ? [skillMdPath]
            : (willFlipManifest ? [skillMdPath, targetPath] : [targetPath]);
        const ignore = this.plugin.ignoreService;
        if (ignore) {
            for (const p of writeTargets) {
                if (ignore.isIgnored(p) || ignore.isProtected(p)) {
                    callbacks.pushToolResult(this.formatError(new Error(ignore.getDenialReason(p))));
                    return;
                }
            }
        }

        const adapter = this.adapter();

        // Assemble the manifest content first (and bail on a refusal) BEFORE any
        // write, so a non-YAML skill is rejected without a partial change.
        let manifestContent: string | undefined;
        if (isManifest) {
            const built = await this.buildSkillMd(
                adapter, skillMdPath, name, content, source, trusted,
                typeof input.description === 'string' ? input.description : undefined,
            );
            if ('error' in built) {
                callbacks.pushToolResult(this.formatError(new Error(built.error)));
                return;
            }
            manifestContent = built.content;
        }

        try {
            if (isManifest) {
                await this.ensureParent(adapter, skillMdPath);
                await adapter.write(skillMdPath, manifestContent!);
            } else {
                // Sub-file. For a trusted skill, first convert the whole folder into
                // a user override, or the sub-file edit is wiped on the next bundle
                // re-materialization.
                if (willFlipManifest) {
                    await this.flipSourceToUser(adapter, skillMdPath);
                }
                await this.ensureParent(adapter, targetPath);
                await adapter.write(targetPath, content);
            }
        } catch (e) {
            callbacks.pushToolResult(this.formatError(new Error(
                `Failed to write "${relFile}" to skill "${name}": ${(e as Error).message}`,
            )));
            return;
        }

        // Make the edit visible: hidden-folder writes do not fire Obsidian vault
        // events, so refresh explicitly.
        try {
            await this.skillLoader?.refresh?.();
        } catch {
            /* refresh is best-effort; the write already succeeded */
        }
        this.plugin.skillsManager?.invalidateCache?.();

        const wroteName = isManifest ? 'SKILL.md' : relFile;
        let msg = `Revised skill "${name}": wrote ${wroteName} (${targetPath}). `
            + 'A snapshot was taken; the change is live.';
        if (trusted) {
            msg += ` Note: "${name}" was a ${source} skill managed by the plugin bundle. It is now a `
                + 'local user override (source: user): it will no longer receive bundle updates and no '
                + 'longer runs with trusted-tier privileges (its instructions no longer override tool '
                + 'selection or guidelines).';
        }
        callbacks.pushToolResult(this.formatSuccess(msg));
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private adapter(): AdapterLike {
        return this.plugin.app.vault.adapter;
    }

    private resolveSkillsDir(): string {
        const fromLoader = this.skillLoader?.getSkillsDir?.();
        return fromLoader && fromLoader.length > 0 ? fromLoader : getSelfAuthoredSkillsDir(this.plugin);
    }

    private async resolveSkill(name: string): Promise<{ source: string; folder: string } | null> {
        const loaderSkill = this.skillLoader?.getSkill(name);
        if (loaderSkill) {
            // The real on-disk folder, which may differ from `name` for imported
            // skills whose folder name is not their frontmatter name.
            const folder = loaderSkill.filePath.replace(/\/SKILL\.md$/i, '');
            return { source: loaderSkill.source, folder };
        }

        const skillsManager = this.plugin.skillsManager;
        if (skillsManager) {
            try {
                const all = await skillsManager.discoverSkills();
                const meta = all.find((s) => s.name === name);
                if (meta) {
                    // meta.path is relative to the skills FileAdapter root
                    // (`skills/{folder}/SKILL.md`); make it vault-relative.
                    const folderSeg = meta.path.replace(/\/SKILL\.md$/i, '').replace(/^skills\//, '');
                    return { source: meta.source ?? '', folder: `${this.resolveSkillsDir()}/${folderSeg}` };
                }
            } catch {
                /* fall through to not-found */
            }
        }
        return null;
    }

    /**
     * Assemble the SKILL.md content. `content` is the BODY; the tool owns the
     * metadata header. The ON-DISK header is authoritative for every field it
     * carries (name, description, source, trigger, allowedTools, requiredTools,
     * type, ...) -- read_skill hands the agent only the body, so a caller header
     * is reconstructed from partial knowledge and must never overwrite on-disk
     * fields it never saw.
     *
     * Only a skill whose SKILL.md is YAML frontmatter (`--- ... ---`) can be
     * rewritten field-safely. A skill using HTML-comment metadata (a rarer
     * imported shape whose block the loader recognises ANYWHERE in the file, not
     * just at the top) is REFUSED rather than converted -- editing it in place
     * would silently drop trigger/allowedTools/type. Returns either the assembled
     * content or an error string for the caller to surface.
     */
    private async buildSkillMd(
        adapter: AdapterLike,
        skillMdPath: string,
        name: string,
        content: string,
        source: string,
        trusted: boolean,
        descriptionParam: string | undefined,
    ): Promise<{ content: string } | { error: string }> {
        let existing = '';
        try {
            existing = await adapter.read(skillMdPath);
        } catch {
            existing = '';
        }

        const yaml = splitFrontmatter(existing);
        if (yaml.fm === null) {
            return {
                error:
                    `Cannot revise the SKILL.md of "${name}": its manifest (${skillMdPath}) does not `
                    + 'start with a YAML frontmatter block (--- ... ---). It may use HTML-comment '
                    + 'metadata or be empty. write_skill only rewrites YAML-frontmatter skills to avoid '
                    + 'silently dropping fields; edit this SKILL.md directly, or revise its resource '
                    + 'files (references/, scripts/) instead.',
            };
        }

        // `content` is the body. If the caller echoed THIS skill's own header
        // (a leading `---...---` whose top-level `name:` equals the skill name),
        // drop the duplicate. Otherwise keep content verbatim -- a body that
        // merely opens with a YAML example fence must not be truncated, so we
        // strip only on an exact name match, never on "looks like a header".
        let body = content;
        const supplied = splitFrontmatter(content);
        if (supplied.fm !== null && getFmField(supplied.fm, 'name') === name) {
            body = supplied.body;
        }
        body = body.replace(/^\n+/, '');

        // Source is enforced from the on-disk trust class, never from caller
        // input: a trusted skill becomes a user override, everything else keeps
        // its resolved source. This also blocks trust forgery.
        const newSource = trusted ? 'user' : (source || 'user');
        const descParam = descriptionParam && descriptionParam.trim().length > 0
            ? descriptionParam.trim().replace(/\s*\n\s*/g, ' ')
            : undefined;

        let fm = yaml.fm;
        fm = setFmField(fm, 'source', newSource);
        fm = setFmField(fm, 'name', name); // identity = folder; never rename
        if (descParam) {
            fm = setFmField(fm, 'description', descParam);
        } else if (!getFmField(fm, 'description')) {
            fm = setFmField(fm, 'description', name);
        }
        return { content: renderSkillMd(fm, body, yaml.lineEnding) };
    }

    /** Rewrite an existing SKILL.md so its `source:` is `user` (user override). */
    private async flipSourceToUser(adapter: AdapterLike, skillMdPath: string): Promise<void> {
        let cur = '';
        try {
            cur = await adapter.read(skillMdPath);
        } catch {
            return; // no manifest to flip -- nothing to do
        }
        const { fm, body, lineEnding } = splitFrontmatter(cur);
        if (fm === null) return;
        const patched = setFmField(fm, 'source', 'user');
        await adapter.write(skillMdPath, renderSkillMd(patched, body.replace(/^[\r\n]+/, ''), lineEnding));
    }

    private async ensureParent(adapter: AdapterLike, path: string): Promise<void> {
        const slash = path.lastIndexOf('/');
        if (slash <= 0) return;
        const parent = path.slice(0, slash);
        if (await adapter.exists(parent)) return;
        const parts = parent.split('/');
        let cur = '';
        for (const seg of parts) {
            cur = cur ? `${cur}/${seg}` : seg;
            if (!(await adapter.exists(cur))) {
                await adapter.mkdir(cur);
            }
        }
    }

    private async collectAvailableNames(): Promise<string[]> {
        const names = new Set<string>();
        if (this.skillLoader) {
            for (const s of this.skillLoader.getAllSkills()) names.add(s.name);
        }
        const skillsManager = this.plugin.skillsManager;
        if (skillsManager) {
            try {
                // FIX-29-05-03: only skills that load. A rejected skill stays
                // reachable for repair by exact name via resolveSkillFolder();
                // it just does not get advertised as an available target.
                for (const s of loadableSkills(await skillsManager.discoverSkills())) names.add(s.name);
            } catch {
                /* tolerate listing failures */
            }
        }
        return [...names].sort();
    }
}

// ---------------------------------------------------------------------------
// Frontmatter helpers -- minimal single-line YAML, matching the parser in
// SkillsManager / BuiltinSkillMaterializer (no nested keys, anchors, tags).
// ---------------------------------------------------------------------------

function splitFrontmatter(
    content: string,
): { fm: string | null; body: string; lineEnding: '\n' | '\r\n' } {
    // RE-AUDIT N-5: this used to carry its own regex plus a comment asserting
    // it was "byte-identical to the skill loaders". It was not -- all three
    // differed on whether a newline after the closing fence was required. The
    // assertion is now true because there is one implementation.
    const split = splitSkillFrontmatter(content);
    if (!split) return { fm: null, body: content, lineEnding: detectLineEnding(content) };
    return { fm: split.frontmatter, body: split.body, lineEnding: split.lineEnding };
}

/**
 * Reassemble a SKILL.md in the line-ending style the file already had.
 *
 * FIX-29-05-10 (Issue #71): now that a CRLF manifest parses, writing it back
 * with a hardcoded LF frontmatter would leave a mixed-ending file that shows up
 * as a spurious diff for the Windows user who owns it. For an LF file (every
 * skill the plugin itself writes) this is byte-identical to the previous
 * hardcoded form. Same decision FIX-44-42 took for notes.
 */
function renderSkillMd(fm: string, body: string, lineEnding: '\n' | '\r\n'): string {
    const assembled = `---\n${fm.trim()}\n---\n\n${body}`;
    return lineEnding === '\n' ? assembled : assembled.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding);
}

/**
 * The key of a TOP-LEVEL `key: value` frontmatter line, or null for anything
 * else. Crucially, a key sits at column 0: an INDENTED line is a block-scalar
 * continuation, never a key. Treating indented lines as keys let setFmField
 * match a `  source:` line inside a `description: |` block and miss the real
 * top-level `source:` (the trust flip then silently failed). Matches the
 * top-level-key rule of SkillsManager.extractYamlField.
 */
function fmLineKey(line: string): string | null {
    if (line.length === 0 || /^\s/.test(line)) return null; // blank or indented -> continuation
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    return line.slice(0, colon).trim();
}

function getFmField(fm: string, key: string): string | undefined {
    for (const line of fm.split('\n')) {
        if (fmLineKey(line) !== key) continue;
        const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
        return value.length > 0 ? value : undefined;
    }
    return undefined;
}

function setFmField(fm: string, key: string, value: string): string {
    const out: string[] = [];
    let replaced = false;
    let dropping = false;
    for (const line of fm.split('\n')) {
        // After replacing a key, swallow its block-scalar continuation -- every
        // following line that is NOT a new top-level key (indented lines AND the
        // internal blank lines a `|`/`>` scalar may contain), until the next
        // top-level key. This mirrors extractYamlField's block boundary, so a
        // replaced multi-paragraph description leaves no orphaned value text.
        if (dropping) {
            if (fmLineKey(line) === null) continue;
            dropping = false;
        }
        if (!replaced && fmLineKey(line) === key) {
            out.push(`${key}: ${value}`);
            replaced = true;
            dropping = true;
            continue;
        }
        out.push(line);
    }
    if (!replaced) out.push(`${key}: ${value}`);
    return out.join('\n');
}
