/**
 * BuiltinSkillMaterializer
 *
 * FEAT-29-11 Step B. Writes the esbuild-generated `BUNDLED_SKILLS` constant
 * to disk under `<agent-folder>/data/skills/{name}/` so built-in skills live
 * side-by-side with user-authored and plugin-managed skills (the user's
 * "Skill ist Skill" decision). Runs on every plugin onload BEFORE the
 * SelfAuthoredSkillLoader scans the skills directory, so the materialized
 * skills become visible without a second loadAll() pass.
 *
 * Contract:
 *   - SKILL.md is written with `source: builtin` in frontmatter, regardless
 *     of what the bundle's own frontmatter said (single normalization point).
 *   - Nested files (scripts/, references/, assets/) are written verbatim.
 *     Binary files use the `__b64__` key suffix from esbuild and get
 *     decoded + writeBinary'd here.
 *   - User-override wins: when the existing SKILL.md has `source: user`
 *     or `source: <plugin-id>`, the bundle is skipped with a notice.
 *   - On re-materialization, the previous builtin folder is wiped so a
 *     bundled-skill file that disappeared between releases is gone.
 *   - Grandfathering (ADR-152): the pass ONLY iterates over skills present
 *     in the bundle. A skill that left the bundle entirely -- e.g. a premium
 *     skill moved to pro-skills/ and stripped from the public build, or
 *     skill-creator moving to the registry (2026-08-14) -- is never
 *     iterated, so an existing on-disk copy is left fully intact
 *     (not updated, not deleted) and keeps working. Do NOT add an "orphan
 *     cleanup" that deletes on-disk skills absent from the bundle: it would
 *     silently destroy a skill the user still relies on. Guarded by the
 *     "Pro-skill grandfathering" tests in BuiltinSkillMaterializer.test.ts.
 *     The FILES survive; the TRUST does not: SkillProvenanceStore.reconcile
 *     prunes the trusted-tier manifest entry of a skill that left the
 *     bundle, so the orphaned copy resolves as `user` and prompts like any
 *     other foreign skill.
 */

import { normalizePath } from 'obsidian';
import { isSafePathSegment } from '../utils/safePathName';

// FIX-PERF-15: djb2 string hash for bundle-fingerprinting. Not a
// cryptographic hash; collisions across bundle inputs are vanishingly
// unlikely because the hash inputs include length and content prefix.
function stringHashCode(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    }
    return h;
}

interface AdapterLike {
    exists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    read(p: string): Promise<string>;
    write(p: string, content: string): Promise<void>;
    writeBinary(p: string, data: ArrayBuffer): Promise<void>;
    remove(p: string): Promise<void>;
    rmdir(p: string, recursive: boolean): Promise<void>;
    list(p: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface MaterializeReport {
    written: string[];
    skipped: Array<{ name: string; reason: 'user-override' | 'plugin-override' | 'bundle-hash-unchanged' }>;
    errors: Array<{ name: string; reason: string }>;
}

const BINARY_SUFFIX = '__b64__';

export class BuiltinSkillMaterializer {
    constructor(private adapter: AdapterLike, private skillsRoot: string) {}

    /**
     * FIX-PERF-15: stable bundle hash. Builds a deterministic string
     * from skill names + per-file path + content length + first 32
     * chars of content. Avoids hashing entire skill bodies (2 MB)
     * while still detecting any edit. JS-only djb2 hash; collisions
     * across real bundles are vanishingly unlikely since the inputs
     * include length and content-prefix.
     */
    private computeBundleHash(bundle: Record<string, Record<string, string>>): string {
        let hash = 5381;
        const skillNames = Object.keys(bundle).sort();
        for (const skill of skillNames) {
            hash = (hash * 33) ^ stringHashCode(skill);
            const files = bundle[skill];
            const filePaths = Object.keys(files).sort();
            for (const path of filePaths) {
                const content = files[path];
                hash = (hash * 33) ^ stringHashCode(path);
                hash = (hash * 33) ^ content.length;
                hash = (hash * 33) ^ stringHashCode(content.slice(0, 32));
            }
        }
        return (hash >>> 0).toString(16);
    }

    private hashMarkerPath(): string {
        return normalizePath(`${this.skillsRoot}/.builtin-bundle-hash`);
    }

    async materializeAll(bundle: Record<string, Record<string, string>>): Promise<MaterializeReport> {
        const report: MaterializeReport = { written: [], skipped: [], errors: [] };

        // FIX-PERF-15: bundle-hash skip. When the materialised hash
        // matches the bundle hash there is nothing to re-write on this
        // boot. Wipe-and-rewrite of 2,584 skill files on every plugin
        // load was a 50-300 ms cold-boot stall.
        const bundleHash = this.computeBundleHash(bundle);
        const markerPath = this.hashMarkerPath();
        try {
            if (await this.adapter.exists(markerPath)) {
                const previous = (await this.adapter.read(markerPath)).trim();
                if (previous === bundleHash) {
                    // Mark every skill as skipped (no work done).
                    for (const skillName of Object.keys(bundle)) {
                        report.skipped.push({ name: skillName, reason: 'bundle-hash-unchanged' });
                    }
                    return report;
                }
            }
        } catch {
            // Marker missing or unreadable -- fall through to full materialize.
        }

        // ADR-152 grandfathering: iterate over bundle entries only. Skills
        // absent from the bundle (e.g. removed premium skills) are never
        // reached here and their on-disk copies stay untouched by design.
        for (const [skillName, files] of Object.entries(bundle)) {
            try {
                if (!isSafePathSegment(skillName)) {
                    report.errors.push({ name: skillName, reason: 'unsafe-name' });
                    continue;
                }

                const targetDir = normalizePath(`${this.skillsRoot}/${skillName}`);
                const skillMdPath = `${targetDir}/SKILL.md`;

                if (await this.adapter.exists(skillMdPath)) {
                    const existing = await this.adapter.read(skillMdPath);
                    const existingSource = this.extractSource(existing);
                    // FEAT-29-13: also protect `agent`-tagged skills
                    // (skill-creator output) and the legacy `learned`
                    // discriminator from being wiped by a same-named
                    // bundled-skills entry on plugin reload.
                    if (
                        existingSource === 'user'
                        || existingSource === 'agent'
                        || existingSource === 'learned'
                    ) {
                        report.skipped.push({ name: skillName, reason: 'user-override' });
                        continue;
                    }
                    if (
                        existingSource
                        && existingSource !== 'builtin'
                        && existingSource !== 'bundled'
                        && existingSource !== 'pro'
                    ) {
                        // Plugin-id source (e.g. "dataview"). Plugin-managed
                        // skills win over builtin materialization. `pro` is our
                        // own managed premium tier (IMP-01-09-01) -- it ships in
                        // the same private bundle and must be overwritable so a
                        // skill update reaches the runtime.
                        report.skipped.push({ name: skillName, reason: 'plugin-override' });
                        continue;
                    }
                }

                // Wipe previous builtin materialization so a removed-from-bundle
                // file does not linger on disk.
                if (await this.adapter.exists(targetDir)) {
                    await this.removeFolderRecursive(targetDir);
                }
                await this.ensureDir(targetDir);

                for (const [rawRelPath, content] of Object.entries(files)) {
                    let relPath = rawRelPath;
                    let binary = false;
                    if (relPath.endsWith(BINARY_SUFFIX)) {
                        relPath = relPath.slice(0, -BINARY_SUFFIX.length);
                        binary = true;
                    }
                    // FEAT-29-11 AUDIT L-1 defense-in-depth: refuse relPaths
                    // that escape the skill folder via `..` segments or that
                    // try to write under an absolute path. Bundle is built
                    // from the local bundled-skills/ tree at compile time so
                    // the risk is theoretical, but enforcing containment
                    // closes the path-traversal class outright.
                    if (
                        relPath.includes('..')
                        || relPath.startsWith('/')
                        || relPath.startsWith('\\')
                        || relPath.includes('\0')
                    ) {
                        report.errors.push({
                            name: skillName,
                            reason: `unsafe relpath rejected: ${relPath}`,
                        });
                        continue;
                    }
                    const fullPath = normalizePath(`${targetDir}/${relPath}`);
                    if (!fullPath.startsWith(`${targetDir}/`) && fullPath !== targetDir) {
                        report.errors.push({
                            name: skillName,
                            reason: `path escapes skill folder: ${relPath}`,
                        });
                        continue;
                    }
                    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
                    if (parent && parent !== targetDir) {
                        await this.ensureDir(parent);
                    }

                    if (binary) {
                        const bytes = this.decodeBase64(content);
                        await this.adapter.writeBinary(fullPath, bytes);
                    } else if (relPath === 'SKILL.md') {
                        await this.adapter.write(fullPath, this.ensureManagedSource(content));
                    } else {
                        await this.adapter.write(fullPath, content);
                    }
                }

                report.written.push(skillName);
            } catch (e) {
                report.errors.push({ name: skillName, reason: (e as Error).message ?? String(e) });
            }
        }

        // FIX-PERF-15: persist the bundle hash on full success so the
        // next boot can skip work. If any skill errored we leave the
        // marker missing so the next boot retries the failed entries.
        if (report.errors.length === 0) {
            try {
                await this.adapter.write(markerPath, bundleHash);
            } catch {
                // Best-effort: a missing marker just means re-materialize
                // next boot, which is the safe default.
            }
        }

        return report;
    }

    private extractSource(content: string): string | null {
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;
        const fmLine = match[1].split('\n').find((line) => /^\s*source\s*:/.test(line));
        if (!fmLine) return null;
        const value = fmLine.slice(fmLine.indexOf(':') + 1).trim();
        return value.replace(/^['"]|['"]$/g, '');
    }

    private ensureManagedSource(content: string): string {
        // Everything the bundle ships is `builtin`, full stop. The old `pro`
        // exception (IMP-01-09-01) kept a monetization tag alive for a licence
        // mechanism that EPIC-31 dropped; keeping it would mean the bundle can
        // still stamp a tier nobody honours. `bundled` and a missing source
        // normalise the same way.
        const target = 'builtin';
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) {
            // No frontmatter at all -- prepend a minimal block. Should not
            // happen for bundled skills but the guard keeps the contract.
            return `---\nsource: ${target}\n---\n\n${content}`;
        }
        const fm = fmMatch[1];
        const lines = fm.split('\n');
        const sourceIdx = lines.findIndex((line) => /^\s*source\s*:/.test(line));
        if (sourceIdx >= 0) {
            lines[sourceIdx] = `source: ${target}`;
        } else {
            lines.push(`source: ${target}`);
        }
        const newFm = lines.join('\n');
        return content.replace(fmMatch[0], `---\n${newFm}\n---`);
    }

    private decodeBase64(b64: string): ArrayBuffer {
        // Buffer is available in Electron's Node integration, but to stay
        // portable for tests in jsdom we fall back to atob.
        const binStr =
            typeof Buffer !== 'undefined'
                ? Buffer.from(b64, 'base64').toString('binary')
                : atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return bytes.buffer;
    }

    private async ensureDir(p: string): Promise<void> {
        if (await this.adapter.exists(p)) return;
        const parent = p.slice(0, p.lastIndexOf('/'));
        if (parent && !(await this.adapter.exists(parent))) {
            await this.ensureDir(parent);
        }
        await this.adapter.mkdir(p);
    }

    private async removeFolderRecursive(dir: string): Promise<void> {
        const { files, folders } = await this.adapter.list(dir);
        for (const f of files) {
            await this.adapter.remove(f);
        }
        for (const sub of folders) {
            await this.removeFolderRecursive(sub);
        }
        await this.adapter.rmdir(dir, true);
    }
}
