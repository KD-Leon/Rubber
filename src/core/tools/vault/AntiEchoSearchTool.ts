/**
 * AntiEchoSearchTool (FEAT-19-14)
 *
 * Stufe-2 Anti-Echo-Web-Suche: bei Concentration-Warning sucht das
 * Tool aktiv nach Gegenpositionen aus alternativen Source-Domains.
 * Reuse des existing WebSearchTool ueber dessen execute()-Pfad mit
 * Source-Filter (block dominant domain via -site:domain.com).
 *
 * Tool ist ein Convenience-Wrapper plus Concentration-Lookup.
 */

import { BaseTool } from '../BaseTool';
import type { ToolDefinition, ToolExecutionContext } from '../types';
import type ObsidianAgentPlugin from '../../../main';

interface AntiEchoInput {
    cluster: string;
    /** Optional: konkrete Anfrage zum Cluster-Topic. */
    query?: string;
}

export class AntiEchoSearchTool extends BaseTool<'anti_echo_search'> {
    readonly name = 'anti_echo_search' as const;
    readonly isWriteOperation = false;

    constructor(plugin: ObsidianAgentPlugin) { super(plugin); }

    getDefinition(): ToolDefinition {
        return {
            name: 'anti_echo_search',
            description:
                'Aktive Web-Suche nach Gegenpositionen zu einem Cluster, der von einer Source-Domain '
                + 'dominiert ist. Blockiert die dominante Domain in der Suche, gibt 5 Top-Treffer aus '
                + 'alternativen Quellen zurueck. Nutzt den konfigurierten Web-Search-Provider (BYOK, ADR-104).',
            input_schema: {
                type: 'object',
                properties: {
                    cluster: { type: 'string', description: 'Cluster-Name fuer den Anti-Echo-Pass.' },
                    query: { type: 'string', description: 'Optional: konkrete Suchanfrage. Sonst wird aus Cluster-Name abgeleitet.' },
                },
                required: ['cluster'],
            },
        };
    }

    async execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<void> {
        const { cluster, query } = input as unknown as AntiEchoInput;
        // FIX-19-16-10: die Tabelle fuellt nur der Deep-Ingest; ohne den war
        // JEDER Aufruf ein Fehler (Live-Vault: 0 Zeilen). Der Store leitet
        // die Dominanz notfalls aus Frontmatter-URLs ab, und ganz ohne
        // Dominanz-Daten laeuft die Suche ohne -site:-Filter, statt ein Tool
        // zu sein, das in einem frischen Vault nur Fehler zurueckgibt.
        const stats = this.plugin.clusterSourceStatsStore?.getStatsForClusterWithFallback(cluster) ?? [];
        const dominantDomain = stats.length ? stats[0].sourceDomain : null;
        const total = stats.reduce((s, x) => s + x.noteCount, 0);
        const conc = dominantDomain && total > 0 ? stats[0].noteCount / total : 0;
        const searchQuery = query
            ?? `Critical perspectives on ${cluster} alternative viewpoints`;

        // Reuse WebSearchTool via Tool-Registry-Lookup
        const webSearchTool = this.plugin.toolRegistry?.getTool('web_search');
        if (!webSearchTool) {
            ctx.callbacks.pushToolResult(this.formatError('web_search-Tool nicht verfuegbar. Bitte Provider in Settings konfigurieren.'));
            return;
        }
        // Source-Filter: dominante Domain blockieren, wenn eine bekannt ist
        const filteredQuery = dominantDomain ? `${searchQuery} -site:${dominantDomain}` : searchQuery;

        const captured: string[] = [];
        const subCtx: ToolExecutionContext = {
            ...ctx,
            callbacks: {
                ...ctx.callbacks,
                pushToolResult: (r: string) => { captured.push(r); },
            },
        };
        await webSearchTool.execute({ query: filteredQuery, max_results: 5 }, subCtx);

        const dominanceLine = dominantDomain
            ? `- Dominante Domain im Cluster: **${dominantDomain}** (${(conc * 100).toFixed(0)}% von ${total} Notes)`
            : '- Keine Dominanz-Daten fuer diesen Cluster (weder Ingest-Statistik noch Frontmatter-URLs); Suche ohne Source-Filter.';
        const intro = [
            `## Anti-Echo-Suche fuer Cluster "${cluster}"`,
            dominanceLine,
            `- Suchanfrage: \`${filteredQuery}\``,
            '',
            '### Treffer (alternative Quellen):',
            '',
            captured.join('\n\n'),
        ];
        ctx.callbacks.pushToolResult(this.formatSuccess(intro.join('\n')));
    }
}
