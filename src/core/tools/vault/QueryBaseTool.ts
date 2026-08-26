/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * QueryBaseTool
 *
 * Returns notes that match a base file's filter conditions.
 * Parses the .base file, extracts the first (or named) view's filter,
 * and queries the vault metadataCache against those conditions.
 *
 * Supported filter functions:
 *   - containsAny("val1", "val2", ...)  — property contains any of the values
 *   - contains("val")                    — property contains value
 *   - == "val"                           — property equals value
 *   - file.name.contains("val")          — file name contains
 * Negation prefix: ! is supported.
 */

import { BaseTool } from '../BaseTool';
import { isDeniedPath } from './denyZoneFilter';
import { sanitizeDirectoryEntry } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';
import type { TFile } from 'obsidian';
import { extractFilters, extractOrder } from './baseQueryParser';

export class QueryBaseTool extends BaseTool<'query_base'> {
    readonly name = 'query_base' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) {
        super(plugin);
    }

    getDefinition(): ToolDefinition {
        return {
            name: 'query_base',
            description:
                'Query an Obsidian Bases file and return the notes that match its filter. ' +
                'Returns note paths and key frontmatter properties.',
            input_schema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Path to the .base file to query',
                    },
                    view_name: {
                        type: 'string',
                        description: 'Name of the view to use (defaults to first view)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of results to return (default: 20)',
                    },
                },
                required: ['path'],
            },
        };
    }

    async execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<void> {
        const { callbacks } = context;
        const path: string = (input.path as string ?? '').trim();
        const viewName: string = (input.view_name as string ?? '').trim();
        const limit: number = Math.min(Number(input.limit) || 20, 100);

        if (!path) {
            callbacks.pushToolResult(this.formatError(new Error('path is required')));
            return;
        }

        try {
            const file = this.app.vault.getFileByPath(path);
            if (!file) {
                callbacks.pushToolResult(this.formatError(new Error(`Base file not found: ${path}`)));
                return;
            }

            const yaml = await this.app.vault.read(file);

            // Extract the target view's filter conditions (simple text parsing).
            // AUDIT-038 ISSUE-006: the parser was extracted into baseQueryParser
            // so its view-boundary handling can be regression-tested.
            const filters = extractFilters(yaml, viewName);
            const orderFields = extractOrder(yaml, viewName);

            // Query vault
            const allFiles = this.app.vault.getMarkdownFiles();
            const matched: TFile[] = [];
            for (const f of allFiles) {
                // AUDIT 2026-07-26 M-7: drop denied notes HERE, not at render
                // time. `matched` feeds both the "N of M" header and the "N more
                // not shown" line, so filtering later would still publish the
                // size of the deny zone. Skipping before getFileCache also means
                // denied frontmatter is never even read.
                if (isDeniedPath(this.plugin, f.path)) continue;
                const cache = this.app.metadataCache.getFileCache(f);
                const fm = cache?.frontmatter ?? {};
                if (this.matchesFilters(f, fm, filters)) {
                    matched.push(f);
                }
            }

            // Limit results
            const results = matched.slice(0, limit);

            if (results.length === 0) {
                callbacks.pushToolResult(`No notes matched the filters in **${path}**.`);
                return;
            }

            const displayFields = orderFields.filter((f) => f !== 'file.name').slice(0, 5);

            const header = `Query results from **${path}** `
                + `(${results.length} of ${matched.length} matching notes):`;
            const lines: string[] = [];
            for (const f of results) {
                const cache = this.app.metadataCache.getFileCache(f);
                const fm = cache?.frontmatter ?? {};
                const row = [`**${sanitizeDirectoryEntry(f.path, 200)}**`];
                for (const field of displayFields) {
                    const val = fm[field];
                    if (val !== undefined && val !== null) {
                        const display = Array.isArray(val) ? val.join(', ') : String(val);
                        // AUDIT 2026-07-26 M-6: slice is a length cap, not a
                        // sanitiser -- a frontmatter value could carry a boundary
                        // tag or a newline and forge an extra result row.
                        row.push(`${field}: ${sanitizeDirectoryEntry(display, 60)}`);
                    }
                }
                lines.push('- ' + row.join(' | '));
            }
            const more = matched.length > limit
                ? `\n\n...${matched.length - limit} more notes not shown.`
                : '';

            callbacks.pushToolResult(
                `${header}\n\n${this.formatUntrustedContent('vault', lines.join('\n'), { base: path })}${more}`,
            );
            callbacks.log(`query_base: ${path} → ${results.length} results`);
        } catch (error) {
            callbacks.pushToolResult(this.formatError(error));
            await callbacks.handleError('query_base', error);
        }
    }

    // -------------------------------------------------------------------------
    // .base YAML parser lives in ./baseQueryParser (AUDIT-038 ISSUE-006)
    // -------------------------------------------------------------------------

    private matchesFilters(file: TFile, fm: Record<string, unknown>, filters: string[]): boolean {
        for (const filter of filters) {
            if (!this.evaluateFilter(file, fm, filter)) return false;
        }
        return true;
    }

    private evaluateFilter(file: TFile, fm: Record<string, unknown>, filter: string): boolean {
        const negated = filter.startsWith('!');
        const expr = negated ? filter.slice(1) : filter;

        // file.name.contains("value")
        const fileNameContains = expr.match(/^file\.name\.contains\("(.+?)"\)$/i);
        if (fileNameContains) {
            const result = file.basename.toLowerCase().includes(fileNameContains[1].toLowerCase());
            return negated ? !result : result;
        }

        // property.containsAny("v1", "v2")
        const containsAny = expr.match(/^(\w[\w.]*?)\.containsAny\((.+)\)$/i);
        if (containsAny) {
            const prop = containsAny[1];
            const vals = this.parseStringArgs(containsAny[2]);
            const result = vals.some((v) => this.propContains(fm[prop], v));
            return negated ? !result : result;
        }

        // property.contains("value")
        const contains = expr.match(/^(\w[\w.]*?)\.contains\("(.+?)"\)$/i);
        if (contains) {
            const result = this.propContains(fm[contains[1]], contains[2]);
            return negated ? !result : result;
        }

        // property == "value" or property == true/false/number
        const eq = expr.match(/^(\w[\w.]*?)\s*==\s*(.+)$/);
        if (eq) {
            const prop = eq[1].trim();
            const rawVal = eq[2].trim().replace(/^"|"$/g, '');
            const fmVal = fm[prop];
            const fmStr = typeof fmVal === 'string' ? fmVal
                : typeof fmVal === 'number' || typeof fmVal === 'boolean' ? String(fmVal)
                : JSON.stringify(fmVal);
            const result = fmVal !== undefined && fmStr === rawVal;
            return negated ? !result : result;
        }

        return true; // unknown filter — pass-through
    }

    private toStr(val: unknown): string {
        if (typeof val === 'string') return val;
        if (typeof val === 'number' || typeof val === 'boolean') return String(val);
        return JSON.stringify(val);
    }

    private propContains(value: unknown, needle: string): boolean {
        if (value === undefined || value === null) return false;
        if (Array.isArray(value)) {
            return value.some((v) => this.toStr(v).toLowerCase().includes(needle.toLowerCase()));
        }
        return this.toStr(value).toLowerCase().includes(needle.toLowerCase());
    }

    private parseStringArgs(argsStr: string): string[] {
        const result: string[] = [];
        const regex = /"([^"\\]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(argsStr)) !== null) {
            result.push(m[1]);
        }
        return result;
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
