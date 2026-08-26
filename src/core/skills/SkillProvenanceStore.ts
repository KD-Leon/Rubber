/**
 * SkillProvenanceStore (FIX-44-05, EPIC-31)
 *
 * The trust class of a skill decides whether it may run without a per-skill
 * approval prompt and whether its instructions are treated as operator-level
 * rather than untrusted content. Before this store, that class was read
 * straight from the SKILL.md frontmatter, so any third-party skill could write
 * a trusted tier and inherit its privileges.
 *
 * This store is the authority instead. Only the BuiltinSkillMaterializer (plugin
 * code) records an entry, and only into a manifest that lives in the agent's
 * protected config zone -- the sandbox cannot write there (FIX-44-22), so a
 * skill script cannot forge its own provenance. Each entry pins a content hash,
 * so overwriting a managed skill's SKILL.md with malicious content also breaks
 * the match and drops it back to `user`.
 *
 * ADR-152 grandfathering: on first run after this fix the manifest is absent, so
 * we seed it once from whatever trusted skills are already on disk. From then on
 * the manifest is authoritative and a newly planted trusted tier is not honoured.
 *
 * EPIC-31 splits the one set into two, because the registry needs provenance
 * without privilege:
 *
 *   MANAGED  what the store records and hash-pins. `registry` is in here so the
 *            badge can say "this is still the version you installed" and so an
 *            update can be detected -- a user edit breaks the hash and the skill
 *            resolves to `user`, which is the tier demotion working as designed.
 *   TRUSTED  what actually skips the approval prompt. Only skills whose bytes
 *            came out of the compiled bundle. A registry skill is a foreign
 *            skill: the download says where it came from, not that it is safe.
 *
 * `pro` is gone from both. It was the monetization tier; a skill still carrying
 * it on disk has no installer provenance and resolves to `user`.
 */

/**
 * Tiers the store records and hash-pins. A superset of TRUSTED_SKILL_TIERS:
 * being tracked is not the same as being trusted.
 */
export const MANAGED_SKILL_TIERS: ReadonlySet<string> = new Set(['builtin', 'bundled', 'registry']);

/**
 * The tiers that grant elevated trust: no approval prompt, allowedTools left
 * unclamped, authoritative prompt framing. Kept in sync with the pipeline and
 * InvokeSkillTool -- all three must name the same set or the gate is decorative.
 *
 * Only bundle-shipped bytes. `registry` is deliberately absent.
 */
export const TRUSTED_SKILL_TIERS: ReadonlySet<string> = new Set(['builtin', 'bundled']);

interface ProvenanceEntry {
    /** The managed source tier (builtin | bundled | registry). */
    source: string;
    /** Non-cryptographic content hash of the SKILL.md when it was recorded. */
    hash: string;
}

interface ManifestShape {
    version: number;
    skills: Record<string, ProvenanceEntry>;
}

interface AdapterLike {
    exists(p: string): Promise<boolean>;
    read(p: string): Promise<string>;
    write(p: string, content: string): Promise<void>;
    list(p: string): Promise<{ files: string[]; folders: string[] }>;
}

const MANIFEST_VERSION = 1;

/** djb2, same family as the materializer's bundle hash. Not cryptographic; it
 *  only needs to detect that a managed SKILL.md was replaced. */
export function hashSkillContent(content: string): string {
    let h = 5381;
    for (let i = 0; i < content.length; i++) {
        h = ((h * 33) ^ content.charCodeAt(i)) >>> 0;
    }
    return `${content.length.toString(36)}.${h.toString(36)}`;
}

/**
 * LF-only ON PURPOSE, and deliberately NOT aligned with splitSkillFrontmatter.
 *
 * FIX-29-05-10 (Issue #71) made the skill loaders CRLF-tolerant so that
 * Windows-authored skills load. This reader stayed LF-only because it feeds
 * TRUSTED_SKILL_TIERS: making it tolerant would let a CRLF manifest claim
 * `source: builtin` and gain trust it never had. Returning null here means
 * "untrusted", so the strictness is fail-closed and the asymmetry is the safe
 * direction. Bundle-materialized skills are always written with LF, so no
 * legitimate trusted skill is affected. Do not "clean this up" for symmetry.
 */
function extractSource(content: string): string | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const fmLine = match[1].split('\n').find((line) => /^\s*source\s*:/.test(line));
    if (!fmLine) return null;
    return fmLine.slice(fmLine.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
}

export class SkillProvenanceStore {
    private entries: Record<string, ProvenanceEntry> = {};
    private existedOnDisk = false;
    /** FIX-44-05: manifest existed but was unreadable -> fail-closed, do not seed. */
    private corrupt = false;

    constructor(private adapter: AdapterLike, private manifestPath: string) {}

    /**
     * Load the manifest. Returns whether it already existed (false means a fresh
     * install or a pre-fix install that needs the ADR-152 seed).
     */
    async load(): Promise<boolean> {
        try {
            if (!(await this.adapter.exists(this.manifestPath))) {
                // Genuinely first run: reconcile() is allowed to seed from disk
                // (ADR-152 grandfathering of an existing install).
                this.existedOnDisk = false;
                this.corrupt = false;
                return false;
            }
            const raw = await this.adapter.read(this.manifestPath);
            const parsed = JSON.parse(raw) as ManifestShape;
            this.entries = (parsed && typeof parsed === 'object' && parsed.skills) ? parsed.skills : {};
            this.existedOnDisk = true;
            this.corrupt = false;
            return true;
        } catch {
            // FIX-44-05 fail-CLOSED: a manifest that EXISTS but is unreadable
            // (truncated write, sync conflict) must NOT be treated as a first run.
            // Seeding here would re-grandfather every on-disk `source: pro` skill,
            // re-opening the forgery window for anything imported since. Mark it
            // corrupt: reconcile() will NOT seed, so unverifiable trusted-tier
            // claims drop to `user`. Grandfathered skills lose auto-approval until
            // the plugin re-materializes them -- fail-safe, not fail-open.
            this.entries = {};
            this.existedOnDisk = false;
            this.corrupt = true;
            return false;
        }
    }

    /**
     * Return the verified managed source for a skill, or null when it cannot be
     * trusted. `content` is the current on-disk SKILL.md: the recorded hash must
     * match it, so a replaced file drops back to null.
     */
    getVerifiedSource(skillName: string, content: string): string | null {
        const entry = this.entries[skillName];
        if (!entry) return null;
        // MANAGED, not TRUSTED: a registry skill gets a verified badge and
        // update detection without inheriting any privilege.
        if (!MANAGED_SKILL_TIERS.has(entry.source)) return null;
        if (entry.hash !== hashSkillContent(content)) return null;
        return entry.source;
    }

    /**
     * Is there a managed record for this skill at all? Read-only, no trust.
     *
     * getVerifiedSource() answers null to two very different situations: the
     * manifest never recorded this skill, and the manifest recorded it but the
     * file has since changed. Only the second one means somebody edited it. A
     * caller that cannot tell them apart reports a lost, corrupt (fail-closed
     * to {}), pruned or never-stamped entry as a user edit.
     *
     * Deliberately says nothing about hashes and grants nothing: a `true` here
     * only means "there is something to compare against". The comparison itself
     * stays in getVerifiedSource, where the tier gate lives.
     */
    hasManagedEntry(skillName: string): boolean {
        const entry = this.entries[skillName];
        return entry !== undefined && MANAGED_SKILL_TIERS.has(entry.source);
    }

    /**
     * Rebuild the manifest for this boot.
     *
     * @param skillsRoot     the vault-relative skills directory
     * @param freshlyManaged skill folder names the materializer just wrote (these
     *                       are authoritative -- their entry is refreshed from the
     *                       current on-disk content)
     *
     * Entries not re-materialized this boot are preserved -- EXCEPT trusted-tier
     * entries whose skill is no longer in `bundleNames`: those are pruned, so
     * trust ends when bundle membership ends (the on-disk folder stays, the
     * skill resolves as `user`). On a first run without a manifest, existing
     * trusted skills on disk are seeded once (ADR-152, bundle-gated).
     */
    async reconcile(
        skillsRoot: string,
        freshlyManaged: Iterable<string>,
        bundleNames?: ReadonlySet<string>,
    ): Promise<void> {
        // Seed ONLY on a genuine first run. A corrupt manifest is deliberately
        // NOT seeded (FIX-44-05 fail-closed) -- otherwise a lost/truncated file
        // would re-grandfather a planted skill.
        //
        // A MISSING manifest used to be seeded from whatever the disk claimed,
        // which made the whole store bypassable: plant a folder declaring a
        // trusted tier, delete the manifest, restart. `bundleNames` closes that
        // by making the bundle the authority -- a skill the bundle does not
        // contain is never grandfathered, however its frontmatter reads.
        // Omitting the argument seeds nothing, so a caller that cannot name the
        // bundle fails closed rather than trusting the disk.
        if (!this.existedOnDisk && !this.corrupt) {
            await this.seedFromDisk(skillsRoot, bundleNames ?? new Set());
        }
        // Prune trusted entries for skills that left the bundle (2026-08-14,
        // first case: skill-creator moving to the registry). TRUSTED means
        // "bytes came out of THIS build's bundle" -- an entry whose skill the
        // bundle no longer contains fails that definition, however intact its
        // hash. Without this, the manifest-present path diverged from the
        // manifest-lost path (which already revokes via the bundle-gated
        // seed): an intact manifest preserved trust forever. Guards: only
        // prune when the caller names a non-empty bundle (a caller that
        // cannot say what shipped must not destroy state); only TRUSTED
        // tiers, so `registry` entries survive; membership is checked against
        // the bundle, not freshlyManaged, so a skill whose materialization
        // failed this boot keeps its entry. The on-disk folder is NOT touched
        // (materializer contract) -- the skill keeps working, resolved as
        // `user`, and prompts like any other foreign skill.
        if (bundleNames && bundleNames.size > 0) {
            for (const [name, entry] of Object.entries(this.entries)) {
                if (TRUSTED_SKILL_TIERS.has(entry.source) && !bundleNames.has(name)) {
                    delete this.entries[name];
                }
            }
        }
        for (const name of freshlyManaged) {
            const skillMd = `${skillsRoot}/${name}/SKILL.md`;
            try {
                if (!(await this.adapter.exists(skillMd))) continue;
                const content = await this.adapter.read(skillMd);
                const source = extractSource(content);
                if (source && MANAGED_SKILL_TIERS.has(source)) {
                    this.entries[name] = { source, hash: hashSkillContent(content) };
                }
            } catch {
                // Skip a skill we cannot read; its absence just means "untrusted".
            }
        }
        await this.save();
    }

    /**
     * ADR-152 one-time seed, restricted to the bundle.
     *
     * Grandfathering exists so a lost manifest does not suddenly make the
     * plugin's own skills prompt on every invoke. It was never meant to confer
     * trust on whatever happens to be lying in the skills folder, and that is
     * the difference `bundleNames` enforces: the frontmatter says what a skill
     * claims, the bundle says what actually shipped, and only the second one
     * counts. An authority the attacker can write is not an authority.
     */
    private async seedFromDisk(skillsRoot: string, bundleNames: ReadonlySet<string>): Promise<void> {
        if (bundleNames.size === 0) return;
        try {
            if (!(await this.adapter.exists(skillsRoot))) return;
            const { folders } = await this.adapter.list(skillsRoot);
            for (const folder of folders) {
                const skillMd = `${folder}/SKILL.md`;
                try {
                    if (!(await this.adapter.exists(skillMd))) continue;
                    const content = await this.adapter.read(skillMd);
                    const name = folder.slice(folder.lastIndexOf('/') + 1);
                    if (!bundleNames.has(name)) continue;
                    const source = extractSource(content);
                    if (source && TRUSTED_SKILL_TIERS.has(source)) {
                        this.entries[name] = { source, hash: hashSkillContent(content) };
                    }
                } catch {
                    // Skip unreadable entries.
                }
            }
        } catch {
            // No skills dir yet (fresh install): nothing to seed.
        }
    }

    /**
     * Record a skill as managed, from an installer that verified where the bytes
     * came from (FEAT-31-02).
     *
     * This is the ONLY write path besides the materializer, and it is the reason
     * the store distinguishes MANAGED from TRUSTED. The registry installer has
     * checked the download against a catalogue checksum, so it may say "this is
     * the published version" -- and nothing more. Recording `registry` here
     * grants no privilege; it makes the badge honest and lets an update be
     * detected by comparing hashes.
     *
     * Refuses any tier outside MANAGED_SKILL_TIERS, so a caller cannot smuggle
     * `builtin` in through the installer and escalate.
     */
    async recordVerified(skillName: string, source: string, content: string): Promise<void> {
        if (!MANAGED_SKILL_TIERS.has(source)) {
            throw new Error(`refusing to record unmanaged tier "${source}" for ${skillName}`);
        }
        if (TRUSTED_SKILL_TIERS.has(source)) {
            throw new Error(
                `refusing to record trusted tier "${source}" from an installer; `
                + 'only the materializer may write bundle provenance',
            );
        }
        this.entries[skillName] = { source, hash: hashSkillContent(content) };
        await this.save();
    }

    private async save(): Promise<void> {
        const manifest: ManifestShape = { version: MANIFEST_VERSION, skills: this.entries };
        try {
            await this.adapter.write(this.manifestPath, JSON.stringify(manifest, null, 2));
            this.existedOnDisk = true;
        } catch (e) {
            console.warn('[SkillProvenanceStore] Failed to persist manifest:', e);
        }
    }
}
