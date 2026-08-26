/**
 * WorkflowLoader - Load and process slash-command workflows (Sprint 3.3)
 *
 * Workflows are Markdown/text files stored in ~/.obsidian-agent/workflows/ (global).
 * They are invoked by the user typing /workflow-name at the start of a message.
 * When a workflow is matched, its content is prepended to the message as
 * explicit instructions before sending to the LLM.
 *
 * Inspired by Kilo Code's slash-commands pattern.
 */

import type { FileAdapter } from '../storage/types';
import { defangBoundaryTags, escapeXmlAttribute } from '../tools/BaseTool';

export interface WorkflowMeta {
    /** Path relative to FileAdapter root: "workflows/my-workflow.md" */
    path: string;
    /** Slug used as slash command: "my-workflow" */
    slug: string;
    /** Human-readable display name: "my workflow" */
    displayName: string;
}

export class WorkflowLoader {
    private readonly fs: FileAdapter;
    readonly workflowsDir: string;

    constructor(fs: FileAdapter) {
        this.fs = fs;
        this.workflowsDir = 'workflows';
    }

    async initialize(): Promise<void> {
        try {
            const exists = await this.fs.exists(this.workflowsDir);
            if (!exists) {
                await this.fs.mkdir(this.workflowsDir);
            }
        } catch {
            // Non-fatal
        }
    }

    /**
     * Discover all workflow files.
     */
    async discoverWorkflows(): Promise<WorkflowMeta[]> {
        try {
            const exists = await this.fs.exists(this.workflowsDir);
            if (!exists) return [];
            const listed = await this.fs.list(this.workflowsDir);
            return listed.files
                .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
                .sort()
                .map((path) => ({
                    path,
                    slug: WorkflowLoader.pathToSlug(path),
                    displayName: WorkflowLoader.displayName(path),
                }));
        } catch {
            return [];
        }
    }

    /**
     * Resolve a workflow slug to its explicit-instructions block, or null when
     * the workflow cannot be applied: no matching file, toggled off, empty
     * slug, or unreadable. The null result is what lets a caller tell "applied"
     * apart from "not applicable" -- processSlashCommand cannot, because it
     * returns the input text unchanged on every miss, which is how the forced
     * workflow path used to send plain text without any warning (FIX-02-02-01,
     * defect a).
     */
    async loadInstructions(
        slug: string,
        toggles: Record<string, boolean>,
    ): Promise<string | null> {
        if (!slug) return null;

        const workflows = await this.discoverWorkflows();
        const match = workflows.find((w) => w.slug === slug);
        if (!match) return null; // no match

        // Check toggle (enabled by default)
        if (toggles[match.path] === false) return null;

        try {
            const content = await this.fs.read(match.path);
            // AUDIT 2026-07-26 M-6: this is the one wrapper that turns bytes into
            // commands -- the prompt tells the model to execute what is inside
            // in order. The body arrived raw, so a workflow file containing
            // `</explicit_instructions>` could close the envelope and continue
            // as trusted prompt. Defang the body and escape the attribute.
            return `<explicit_instructions type="${escapeXmlAttribute(slug)}">\n`
                + `${defangBoundaryTags(content.trim())}\n</explicit_instructions>`;
        } catch {
            return null;
        }
    }

    /**
     * If `text` starts with /slug (optionally followed by a space + rest-of-message),
     * load the matching workflow and prepend it as instructions.
     * Returns the transformed message, or the original text if no match.
     */
    async processSlashCommand(
        text: string,
        toggles: Record<string, boolean>,
    ): Promise<string> {
        if (!text.startsWith('/')) return text;

        // Parse /slug [rest]
        const spaceIdx = text.indexOf(' ');
        const slug = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
        const rest = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

        const instructions = await this.loadInstructions(slug, toggles);
        if (instructions === null) return text; // pass through as-is

        return rest ? `${instructions}\n\n${rest}` : instructions;
    }

    /**
     * Load a single workflow file's content.
     */
    loadWorkflow(wPath: string): Promise<string> {
        return this.fs.read(wPath);
    }

    /**
     * Create a new workflow file. Returns the path.
     */
    async createWorkflow(name: string, content: string): Promise<string> {
        await this.initialize();
        const safeName = name.replace(/[^a-zA-Z0-9_ -]/g, '').trim() || 'workflow';
        const wPath = `${this.workflowsDir}/${safeName}.md`;
        await this.fs.write(wPath, content);
        return wPath;
    }

    /**
     * Delete a workflow file.
     */
    async deleteWorkflow(wPath: string): Promise<void> {
        await this.fs.remove(wPath);
    }

    /**
     * Read a workflow file's content (for UI editing).
     */
    readFile(wPath: string): Promise<string> {
        return this.fs.read(wPath);
    }

    /**
     * Write a workflow file's content (for UI editing).
     */
    async writeFile(wPath: string, content: string): Promise<void> {
        await this.fs.write(wPath, content);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    static pathToSlug(wPath: string): string {
        const parts = wPath.split('/');
        const filename = parts[parts.length - 1] ?? wPath;
        return filename.replace(/\.(md|txt)$/, '').toLowerCase().replace(/\s+/g, '-');
    }

    static displayName(wPath: string): string {
        const parts = wPath.split('/');
        const filename = parts[parts.length - 1] ?? wPath;
        return filename.replace(/\.(md|txt)$/, '');
    }
}
