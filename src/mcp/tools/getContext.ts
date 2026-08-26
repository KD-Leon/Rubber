/**
 * get_context -- Returns vault stats and, when authorized, user profile,
 * memory, skills, and rules. Recommended as the first call of a session
 * so the assistant understands the vault and any user-supplied rules.
 */

import type ObsidianAgentPlugin from '../../main';
import { keepVisible } from '../../core/tools/vault/denyZoneFilter';
import type { McpToolResult } from '../types';
import { AGENT_INTERNAL_TOOLS } from '../toolDefinitions';
import { resolveExternalSourceInterface } from '../../core/memory/SourceInterface';
import { loadableSkills } from '../../core/context/SkillsManager';
import { sanitizeDirectoryEntry } from '../../core/tools/BaseTool';
import { SKILL_DESCRIPTION_PROMPT_CAP } from '../../core/skills/descriptionCaps';

export async function handleGetContext(
    plugin: ObsidianAgentPlugin,
    args: Record<string, unknown> = {},
): Promise<McpToolResult> {
    const sections: string[] = [];

    // AUDIT-016 M-3: strictSourceIsolation gates memory, soul, skills,
    // and rules. When the setting is ON and source_interface != 'obsilo'
    // (i.e. an external connector), we return only vault stats instead
    // of memory content. This prevents shared-account connectors (e.g.
    // ChatGPT, Perplexity) from pulling personal memory context.
    const crossSurface = plugin.settings?.memory?.crossSurface;
    // AUDIT 2026-07-14 (Codex) H-1: an external client cannot claim 'obsilo'.
    const sourceInterface = resolveExternalSourceInterface(args.source_interface);
    const strictMode = (crossSurface?.strictSourceIsolation ?? false)
        && sourceInterface !== 'obsilo';

    // Memory context (user-profile, patterns, soul, projects).
    // Skipped under strictSourceIsolation for non-obsilo callers.
    if (plugin.memoryService && !strictMode) {
        try {
            const files = await plugin.memoryService.loadMemoryFiles();
            const ctx = plugin.memoryService.buildMemoryContext(files);
            if (ctx) sections.push(ctx);
        } catch { /* non-fatal */ }
    } else if (strictMode) {
        // FIX-23-09-08: the closing sentence used to advise the client to pass
        // source_interface to opt into shared mode. resolveExternalSourceInterface
        // coerces every externally supplied value away from 'obsilo', so no
        // argument can reach this branch -- the advice only bought retries. The
        // lever is the setting, and only the user can move it.
        sections.push(
            `--- Memory + Soul context omitted ---\n`
            + `strictSourceIsolation is enabled in Settings; personal memory context `
            + `is only exposed to the plugin itself. No argument to get_context `
            + `changes this -- the vault owner turns the setting off if they want `
            + `memory shared with external clients.`,
        );
    }

    // Available vault operations (via execute_vault_op)
    const availableOps = plugin.toolRegistry.getAllTools()
        .map(t => t.name)
        .filter(name => !AGENT_INTERNAL_TOOLS.has(name))
        .sort();
    sections.push([
        '--- Available Vault Operations (via execute_vault_op) ---',
        `Use execute_vault_op with operation parameter set to any of: ${availableOps.join(', ')}`,
        'Pass tool-specific parameters via the params object.',
    ].join('\n'));

    // Vault stats
    const vault = plugin.app.vault;
    // AUDIT 2026-07-26 M-7: the MCP twin of get_vault_stats. It reported the
    // raw note and folder counts to an external client, which publishes the
    // size of the deny zone just as the in-app tool did.
    const files = keepVisible(plugin, vault.getMarkdownFiles(), (f) => f.path);
    const graphStore = plugin.graphStore;
    sections.push([
        '--- Vault Stats ---',
        `Notes: ${files.length}`,
        `Folders: ${keepVisible(plugin, vault.getAllFolders(), (f) => f.path).length}`,
        `Graph edges: ${graphStore?.getEdgeCount() ?? 0}`,
        `Graph tags: ${graphStore?.getTagCount() ?? 0}`,
        `Semantic index: ${plugin.semanticIndex?.isIndexed ? 'built' : 'not built'}`,
        `Implicit connections: ${plugin.implicitConnectionService?.getCount() ?? 0}`,
    ].join('\n'));

    // Available skills + Rules: skipped under strictSourceIsolation.
    // Local skills and rules are not direct memory content, but they may
    // carry personalization hints (tone, language preferences). Treat
    // conservatively.
    if (!strictMode) {
        if (plugin.skillsManager) {
            try {
                // FIX-29-05-03 / FIX-29-05-04: only skills that actually load,
                // and sanitise the untrusted frontmatter before it reaches an
                // external client's model context.
                const skills = loadableSkills(await plugin.skillsManager.discoverSkills());
                if (skills.length > 0) {
                    sections.push('--- Available Skills ---');
                    for (const s of skills) {
                        sections.push(
                            `- ${sanitizeDirectoryEntry(s.name, 80)}: ${sanitizeDirectoryEntry(s.description ?? '', SKILL_DESCRIPTION_PROMPT_CAP)}`,
                        );
                    }
                }
            } catch { /* non-fatal */ }
        }

        if (plugin.rulesLoader) {
            try {
                const rules = await plugin.rulesLoader.discoverRules();
                if (rules.length > 0) {
                    sections.push('--- User Rules ---');
                    for (const r of rules) {
                        sections.push(`- ${r}`);
                    }
                }
            } catch { /* non-fatal */ }
        }
    }

    return {
        content: [{ type: 'text', text: sections.join('\n\n') }],
    };
}
