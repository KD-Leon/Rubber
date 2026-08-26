/**
 * PluginBuilder
 *
 * Compiles the full plugin from source using esbuild-wasm.
 * Creates a new main.js from the in-memory source files managed by
 * EmbeddedSourceManager.
 *
 * Part of Self-Development Phase 4: Core Self-Modification.
 */

import type { EsbuildWasmManager } from '../sandbox/EsbuildWasmManager';
import type { EmbeddedSourceManager } from './EmbeddedSourceManager';

// ---------------------------------------------------------------------------
// PluginBuilder
// ---------------------------------------------------------------------------

export class PluginBuilder {
    constructor(
        private esbuildManager: EsbuildWasmManager,
        private sourceManager: EmbeddedSourceManager,
    ) {}

    /**
     * Build the complete plugin from embedded source.
     * Returns the compiled JavaScript as a string.
     *
     * Note: This uses esbuild-wasm's build() with a virtual filesystem
     * that resolves imports from the in-memory source files.
     */
    async build(): Promise<string> {
        if (!this.sourceManager.isLoaded) {
            throw new Error('Embedded source not loaded. Cannot build.');
        }

        await this.esbuildManager.ensureReady();

        const allFiles = this.sourceManager.getAllFiles();
        const entryContent = allFiles.get('src/main.ts');
        if (!entryContent) {
            throw new Error('Entry point src/main.ts not found in embedded source.');
        }

        // For a full rebuild, we need esbuild's build() with a virtual filesystem
        // that resolves all internal imports from the in-memory source map.
        // This is delegated to esbuild-wasm's build mode.
        const result = await this.esbuildManager.build(entryContent, []);

        console.debug(`[PluginBuilder] Build complete (${result.length} bytes)`);
        return result;
    }

    /**
     * Get a diff preview between the current and modified source.
     */
    getDiff(path: string, original: string, modified: string): string {
        const origLines = original.split('\n');
        const modLines = modified.split('\n');
        const diff: string[] = [`--- ${path} (original)`, `+++ ${path} (modified)`];

        const maxLines = Math.max(origLines.length, modLines.length);
        for (let i = 0; i < maxLines; i++) {
            const origLine = origLines[i];
            const modLine = modLines[i];
            if (origLine !== modLine) {
                if (origLine !== undefined) diff.push(`- ${origLine}`);
                if (modLine !== undefined) diff.push(`+ ${modLine}`);
            }
        }

        return diff.join('\n');
    }
}
