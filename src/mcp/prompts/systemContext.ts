/**
 * MCP Prompt Builder -- returns the neutral "vault-operator-context"
 * prompt that external MCP clients (Claude Desktop, Claude.ai connector
 * mode) can opt into via prompts/list + prompts/get.
 *
 * FIX-23-09-01: this payload is deliberately neutral. It contains no
 * persona (soul.md), no user memory dump, no imperative wording. Persona
 * and memory remain reachable only through the explicit save_to_memory
 * and recall_memory tools the user has opted into. The previous
 * auto-injection into the first tool response was removed (see
 * tools/index.ts).
 */

import type ObsidianAgentPlugin from '../../main';
import type { McpPromptMessage } from '../types';
import { loadableSkills } from '../../core/context/SkillsManager';
import { sanitizeDirectoryEntry } from '../../core/tools/BaseTool';
import { SKILL_DESCRIPTION_PROMPT_CAP } from '../../core/skills/descriptionCaps';

export async function buildPrompts(plugin: ObsidianAgentPlugin): Promise<McpPromptMessage[]> {
    const sections: string[] = [];

    sections.push([
        '# Vault Operator Context',
        '',
        'Vault Operator is an Obsidian plugin that exposes vault search, read, write, and memory tools over MCP.',
        '',
        '## Recommended Tool Use',
        '- Start with `get_context` to load vault stats and, when authorized, user preferences.',
        '- Use `search_vault` for vault research; it runs a hybrid retrieval pipeline internally.',
        '- Use `read_notes` to read specific files when the path is known.',
        '- Use `write_vault` to create or modify files.',
        '- Use `save_to_memory` only when the user explicitly asks to remember something.',
        '',
        '## Conversation Sync',
        'After a session that used Vault Operator tools, call `sync_session` so the transcript is saved to the user\'s Obsidian history.',
        'Include this as the final step before ending the session.',
    ].join('\n'));

    // User rules (project-level conventions, neutral by nature).
    if (plugin.rulesLoader) {
        try {
            const rules = await plugin.rulesLoader.discoverRules();
            if (rules.length > 0) {
                const ruleTexts = rules.map((r: string) => `- ${r}`).join('\n');
                sections.push(`## User Rules\n${ruleTexts}`);
            }
        } catch { /* non-fatal */ }
    }

    // Skills overview (workflow names + short descriptions only; no PII).
    if (plugin.skillsManager) {
        try {
            // FIX-29-05-03: skills that fail hard validation do not load, so
            // advertising them to an external MCP client is a dead end.
            // FIX-29-05-04: name and description are untrusted frontmatter --
            // sanitise before they enter a prompt, matching the sidebar and
            // main.ts assembly paths (AUDIT 2026-07-14 Codex M-1).
            const skills = loadableSkills(await plugin.skillsManager.discoverSkills());
            if (skills.length > 0) {
                const skillTexts = skills
                    .map((s: { name: string; description?: string }) =>
                        `- ${sanitizeDirectoryEntry(s.name, 80)}: ${sanitizeDirectoryEntry(s.description ?? '', SKILL_DESCRIPTION_PROMPT_CAP)}`)
                    .join('\n');
                sections.push(`## Available Skills\nUse these as workflow guides:\n${skillTexts}`);
            }
        } catch { /* non-fatal */ }
    }

    return [{
        role: 'user',
        content: { type: 'text', text: sections.join('\n\n') },
    }];
}
