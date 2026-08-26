/**
 * TaskNoteCreator -- Creates task notes with structured frontmatter.
 *
 * ADR-027: Task-Note Frontmatter Schema.
 * FIX-42-01-01: property names follow the user's graph-expansion settings
 * (OKF vocabulary by default); icons and base integration key off the
 * category property carrying the "task" type.
 */

import { App, TFile } from 'obsidian';
import { t } from '../../i18n';
import { OKF_DEFAULTS } from '../../types/settings';
import type { TaskItem, TaskExtractionSettings } from './types';

/** Frontmatter property names the task note writes; defaults to OKF. */
export interface TaskNoteVocabulary {
    categoryProperty: string;
    summaryProperty: string;
    backlinksProperty: string;
}

/** Characters not allowed in file names */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|#^[\]]/g;

/** Markdown formatting that can't be rendered in frontmatter text values */
const MARKDOWN_FORMATTING = /[*_~`[\]]/g;

/**
 * Creates a concise, semantically meaningful title from task text.
 * Tries to cut at natural phrase boundaries (after verbs, before parentheticals)
 * rather than arbitrarily truncating mid-thought.
 */
function toTitle(text: string): string {
    const clean = text.replace(INVALID_FILENAME_CHARS, '').trim();
    const words = clean.split(/\s+/);

    // Short enough already — use as-is
    if (words.length <= 8) return clean;

    // Try to find a natural break point within 5-8 words.
    // Prefer cutting before prepositions/conjunctions that start subordinate clauses,
    // or before parenthetical additions.
    const breakWords = new Set([
        'und', 'und', 'oder', 'aber', 'sowie', 'damit', 'weil', 'wenn', 'falls',
        'and', 'or', 'but', 'because', 'when', 'if', 'then', 'so', 'since',
        'sodass', 'bevor', 'nachdem', 'wobei', 'insbesondere', 'inklusive',
        'before', 'after', 'including', 'especially', 'regarding',
    ]);

    // Scan words 5-8 looking for a break word to cut before
    for (let i = 4; i < Math.min(words.length, 8); i++) {
        const w = words[i].toLowerCase().replace(/[,;:\-()]/g, '');
        if (breakWords.has(w) || words[i].startsWith('(')) {
            return words.slice(0, i).join(' ').replace(/[,;:-]+$/, '').trim();
        }
    }

    // No natural break found — take first 7 words and trim trailing connectors
    let result = words.slice(0, 7).join(' ');
    result = result.replace(/\s+(und|and|oder|or|,|;|:|-)+\s*$/i, '').trim();
    return result;
}

/** Converts a title to a filesystem-safe slug */
function toSlug(title: string): string {
    return title.replace(/\s+/g, '-');
}

/**
 * Escapes a string for safe YAML frontmatter embedding.
 * Wraps in quotes if it contains special characters.
 */
function yamlEscape(value: string): string {
    if (value === '') return '""';
    if (/[:#{}[\],&*?|>!'"%@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}

/** Strips markdown formatting characters that can't be rendered in plain text contexts */
function stripMarkdown(text: string): string {
    return text.replace(MARKDOWN_FORMATTING, '').replace(/\s{2,}/g, ' ').trim();
}

/** Returns today's date as YYYY-MM-DD */
function todayISO(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export class TaskNoteCreator {
    private readonly vocab: TaskNoteVocabulary;

    constructor(private app: App, vocab?: TaskNoteVocabulary) {
        this.vocab = vocab ?? { ...OKF_DEFAULTS };
    }

    /**
     * Creates task notes for selected items.
     * Returns array of created file paths. Partial success: already-created notes remain.
     */
    async createNotes(
        items: TaskItem[],
        settings: TaskExtractionSettings,
        sourceNote: string,
    ): Promise<string[]> {
        const folder = settings.taskFolder;
        const created: string[] = [];
        const today = todayISO();

        // Ensure folder exists
        await this.ensureFolder(folder);

        for (const item of items) {
            try {
                const title = toTitle(stripMarkdown(item.cleanText));
                const slug = toSlug(title);
                const path = this.uniquePath(folder, slug);
                const content = this.buildNoteContent(item, title, sourceNote, today);
                await this.app.vault.create(path, content);
                created.push(path);
            } catch (err) {
                console.warn('[TaskExtraction] Failed to create task note:', err);
            }
        }

        return created;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private buildNoteContent(
        item: TaskItem,
        title: string,
        sourceNote: string,
        today: string,
    ): string {
        const lines: string[] = ['---'];

        lines.push(`${this.vocab.categoryProperty}:`);
        lines.push('  - task');
        lines.push(`${this.vocab.summaryProperty}: ${yamlEscape(title)}`);
        lines.push('status: todo');
        lines.push('urgent: false');
        lines.push('important: false');
        lines.push(`due: ${item.dueDate || ''}`);
        lines.push(`assignee: ${yamlEscape(item.assignee)}`);
        lines.push(`resource: ${yamlEscape(sourceNote ? `[[${sourceNote}]]` : '')}`);
        lines.push(`created: ${today}`);
        lines.push(`${this.vocab.backlinksProperty}: []`);

        lines.push('---');
        lines.push('');
        lines.push(`# ${title}`);
        lines.push('');
        lines.push(`> ${t('tool.taskNote.extracted', { date: today })}`);
        if (sourceNote) {
            lines.push(`> ${t('tool.taskNote.source', { link: `[[${sourceNote}]]` })}`);
        }
        lines.push('');
        lines.push(`## ${t('tool.taskNote.descriptionHeading')}`);
        lines.push('');
        lines.push(stripMarkdown(item.text));
        lines.push('');
        lines.push(`## ${t('tool.taskNote.notesHeading')}`);
        lines.push('');

        return lines.join('\n');
    }

    private async ensureFolder(folder: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (!existing) {
            await this.app.vault.createFolder(folder).catch(() => { /* already exists */ });
        }
    }

    /**
     * Returns a unique file path, appending -2, -3 etc. if the slug already exists.
     */
    private uniquePath(folder: string, slug: string): string {
        let candidate = `${folder}/${slug}.md`;
        if (!(this.app.vault.getAbstractFileByPath(candidate) instanceof TFile)) {
            return candidate;
        }

        let suffix = 2;
        while (suffix <= 100) {
            candidate = `${folder}/${slug}-${suffix}.md`;
            if (!(this.app.vault.getAbstractFileByPath(candidate) instanceof TFile)) {
                return candidate;
            }
            suffix++;
        }

        // Extremely unlikely: fall back to timestamp
        return `${folder}/${slug}-${Date.now()}.md`;
    }
}
