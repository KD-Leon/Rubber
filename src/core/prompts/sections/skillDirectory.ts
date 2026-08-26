/**
 * Skill Directory Section (ADR-116, FEAT-24-09)
 *
 * Renders the **stable** SKILLS directory: name + description (and inventory
 * lines for self-authored skills) of every installed skill. The directory
 * lives in the cached system-prompt prefix above the CACHE_BREAKPOINT_MARKER,
 * so it does not invalidate the KV cache between turns.
 *
 * Replaces the previous per-message ACTIVE-SKILLS injection (see ADR-116
 * for the rationale): the model decides itself which skill to load and
 * fetches the full body via the `read_skill` tool. The body then lives in
 * the message stream and falls under microcompaction (ADR-12 amendment /
 * FEAT-24-02) like any other tool result.
 */

import { defangBoundaryTags } from '../../tools/BaseTool';

export function getSkillDirectorySection(directory?: string): string {
    if (!directory?.trim()) return '';

    // AUDIT 2026-07-14 (Codex re-review, M-1): this is the single chokepoint all
    // three buildSkillDirectory assemblies flow through before the wrapper is
    // added (sidebar, inline-chat AgentRuntimeContext, mode ModesTab). A final
    // reconstruction-safe defang here neutralises any boundary tag that survived
    // per-field sanitisation on a raw assembly path OR was reassembled across the
    // ", " / "\n" joins between two independently-sanitised fields.
    const safeDirectory = defangBoundaryTags(directory.trim());

    return [
        '',
        '====',
        '',
        'SKILLS',
        '',
        'Skills are step-by-step workflows for specific task types. The directory below',
        'lists every installed skill (name + what it is for, plus its sidecars when present).',
        'When the current task matches a skill\'s purpose, call read_skill({ name: "<name>" })',
        'to load its full instructions as a tool result, then follow that workflow step by',
        'step -- it OVERRIDES default tool selection and general guidelines. If a skill says',
        '"ASK the user", you MUST ask and STOP. Do NOT load a skill that does not match the',
        'task. If no skill applies, proceed with normal tools and capabilities.',
        '',
        'To CHANGE an installed skill (fix or improve it), call write_skill({ name, content }) --',
        'like read_skill it takes the skill NAME, not a path. Skill files live in a hidden,',
        'per-install configurable folder, so NEVER construct a filesystem path to a skill or edit',
        'one with write_file/read_file; use write_skill and read_skill by name. To build a NEW',
        'skill, use the skill-creator skill when it is listed below; otherwise scaffold it',
        'yourself with write_skill.',
        '',
        '<available_skills>',
        safeDirectory,
        '</available_skills>',
    ].join('\n');
}
