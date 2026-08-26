/**
 * TaskNotesAdapter -- Creates task notes in TaskNotes community plugin format.
 *
 * When the TaskNotes plugin (id: 'tasknotes') is active, this adapter creates
 * task files with TaskNotes-compatible frontmatter so they appear in TaskNotes
 * views (task list, kanban, calendar).
 *
 * Critical for TaskNotes recognition:
 * - taskIdentificationMethod: "tag" -> tasks MUST have `tags: [<taskTag>]`
 * - fieldMapping from plugin settings defines property names
 * - tasksFolder from plugin settings defines the target folder
 * - dateCreated must be full ISO 8601 with timezone offset
 */

import { App, TFile } from 'obsidian';
import type { TaskItem, TaskExtractionSettings } from './types';

/** Characters not allowed in file names */
const INVALID_FILENAME_CHARS = /[/\\:*?"<>|#^[\]]/g;

/** Markdown formatting that shouldn't appear in frontmatter text values */
const MARKDOWN_FORMATTING = /[*_~`[\]]/g;

/**
 * TaskNotes field mapping -- read from plugin settings (data.json -> fieldMapping).
 * Only the fields we actually write are listed here.
 */
interface TaskNotesFieldMap {
    title: string;
    status: string;
    due: string;
    scheduled: string;
    priority: string;
    contexts: string;
    projects: string;
    dateCreated: string;
    dateModified: string;
}

const DEFAULT_FIELD_MAP: TaskNotesFieldMap = {
    title: 'title',
    status: 'status',
    due: 'due',
    scheduled: 'scheduled',
    priority: 'priority',
    contexts: 'contexts',
    projects: 'projects',
    dateCreated: 'dateCreated',
    dateModified: 'dateModified',
};

/** Strips markdown formatting characters */
function stripMarkdown(text: string): string {
    return text.replace(MARKDOWN_FORMATTING, '').replace(/\s{2,}/g, ' ').trim();
}

/** Converts a title to a filesystem-safe slug */
function toSlug(title: string): string {
    return title.replace(INVALID_FILENAME_CHARS, '').trim().replace(/\s+/g, '-');
}

/**
 * Escapes a string for safe YAML frontmatter embedding.
 */
function yamlEscape(value: string): string {
    if (value === '') return '""';
    if (/[:#{}[\],&*?|>!'"%@`]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}

/** Returns current timestamp as ISO 8601 with timezone offset (e.g. 2026-03-18T10:52:00.000+01:00) */
function nowISO8601(): string {
    const d = new Date();
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offset) % 60).padStart(2, '0');
    // Remove trailing 'Z' and append offset
    return d.toISOString().replace('Z', `${sign}${hh}:${mm}`);
}

/** Returns today's date as YYYY-MM-DD */
function todayISO(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export class TaskNotesAdapter {
    constructor(private app: App) {}

    /**
     * Creates task notes in TaskNotes-compatible format.
     * Same signature as TaskNoteCreator.createNotes() for easy substitution.
     */
    async createNotes(
        items: TaskItem[],
        settings: TaskExtractionSettings,
        sourceNote: string,
    ): Promise<string[]> {
        const tnSettings = this.getTaskNotesSettings();
        const folder = this.getTaskFolder(tnSettings, settings);
        const fields = this.getFieldMap(tnSettings);
        const taskTag = this.getTaskTag(tnSettings);
        const defaultStatus = this.getDefaultStatus(tnSettings);
        const defaultPriority = this.getDefaultPriority(tnSettings);
        const created: string[] = [];

        await this.ensureFolder(folder);

        for (const item of items) {
            try {
                const title = stripMarkdown(item.cleanText);
                const slug = toSlug(title);
                const path = this.uniquePath(folder, slug);
                const content = this.buildNoteContent(
                    item, title, sourceNote, fields, taskTag, defaultStatus, defaultPriority,
                );
                await this.app.vault.create(path, content);
                created.push(path);
            } catch (err) {
                console.warn('[TaskNotesAdapter] Failed to create task note:', err);
            }
        }

        return created;
    }

    // -----------------------------------------------------------------------
    // TaskNotes settings access
    // -----------------------------------------------------------------------

    private getTaskNotesSettings(): Record<string, unknown> | undefined {
        try {
            const plugins = (this.app as unknown as {
                plugins?: { plugins?: Record<string, { settings?: unknown }> }
            }).plugins;
            const tnPlugin = plugins?.plugins?.['tasknotes'];
            if (tnPlugin?.settings && typeof tnPlugin.settings === 'object') {
                return tnPlugin.settings as Record<string, unknown>;
            }
        } catch {
            // Ignore
        }
        return undefined;
    }

    /** Reads task folder from TaskNotes settings (key: tasksFolder) */
    private getTaskFolder(
        tnSettings: Record<string, unknown> | undefined,
        fallback: TaskExtractionSettings,
    ): string {
        const folder = tnSettings?.tasksFolder;
        if (typeof folder === 'string' && folder.trim()) {
            return folder.trim();
        }
        return fallback.taskFolder;
    }

    /** Reads field name mapping from TaskNotes settings (key: fieldMapping) */
    private getFieldMap(tnSettings: Record<string, unknown> | undefined): TaskNotesFieldMap {
        const mapping = tnSettings?.fieldMapping;
        if (mapping && typeof mapping === 'object') {
            const m = mapping as Record<string, unknown>;
            return {
                title: typeof m.title === 'string' ? m.title : DEFAULT_FIELD_MAP.title,
                status: typeof m.status === 'string' ? m.status : DEFAULT_FIELD_MAP.status,
                due: typeof m.due === 'string' ? m.due : DEFAULT_FIELD_MAP.due,
                scheduled: typeof m.scheduled === 'string' ? m.scheduled : DEFAULT_FIELD_MAP.scheduled,
                priority: typeof m.priority === 'string' ? m.priority : DEFAULT_FIELD_MAP.priority,
                contexts: typeof m.contexts === 'string' ? m.contexts : DEFAULT_FIELD_MAP.contexts,
                projects: typeof m.projects === 'string' ? m.projects : DEFAULT_FIELD_MAP.projects,
                dateCreated: typeof m.dateCreated === 'string' ? m.dateCreated : DEFAULT_FIELD_MAP.dateCreated,
                dateModified: typeof m.dateModified === 'string' ? m.dateModified : DEFAULT_FIELD_MAP.dateModified,
            };
        }
        return { ...DEFAULT_FIELD_MAP };
    }

    /** Reads the task identification tag (key: taskTag, default: "task") */
    private getTaskTag(tnSettings: Record<string, unknown> | undefined): string {
        const tag = tnSettings?.taskTag;
        return typeof tag === 'string' && tag.trim() ? tag.trim() : 'task';
    }

    /** Reads default task status (key: defaultTaskStatus, default: "open") */
    private getDefaultStatus(tnSettings: Record<string, unknown> | undefined): string {
        const status = tnSettings?.defaultTaskStatus;
        return typeof status === 'string' && status.trim() ? status.trim() : 'open';
    }

    /** Reads default task priority (key: defaultTaskPriority, default: "normal") */
    private getDefaultPriority(tnSettings: Record<string, unknown> | undefined): string {
        const priority = tnSettings?.defaultTaskPriority;
        return typeof priority === 'string' && priority.trim() ? priority.trim() : 'normal';
    }

    // -----------------------------------------------------------------------
    // Note content generation
    // -----------------------------------------------------------------------

    private buildNoteContent(
        item: TaskItem,
        title: string,
        sourceNote: string,
        fields: TaskNotesFieldMap,
        taskTag: string,
        defaultStatus: string,
        defaultPriority: string,
    ): string {
        const now = nowISO8601();
        const today = todayISO();
        const lines: string[] = ['---'];

        // Core TaskNotes fields
        lines.push(`${fields.title}: ${yamlEscape(title)}`);
        lines.push(`${fields.status}: ${defaultStatus}`);
        lines.push(`${fields.priority}: ${defaultPriority}`);

        // Dates
        if (item.dueDate) {
            lines.push(`${fields.due}: ${item.dueDate}`);
        }
        lines.push(`${fields.scheduled}: ${today}`);
        lines.push(`${fields.dateCreated}: ${now}`);
        lines.push(`${fields.dateModified}: ${now}`);

        // Task identification tag -- CRITICAL for TaskNotes to recognize this as a task
        lines.push('tags:');
        lines.push(`  - ${taskTag}`);

        // Optional metadata
        lines.push(`${fields.contexts}: []`);
        lines.push(`${fields.projects}: []`);

        // Extra fields from our extraction (not part of TaskNotes core but harmless)
        if (item.assignee) {
            lines.push(`assignee: ${yamlEscape(item.assignee)}`);
        }
        if (sourceNote) {
            lines.push(`source: ${yamlEscape(`[[${sourceNote}]]`)}`);
        }

        lines.push('---');
        lines.push('');
        lines.push(stripMarkdown(item.text));
        lines.push('');

        return lines.join('\n');
    }

    // -----------------------------------------------------------------------
    // File system helpers
    // -----------------------------------------------------------------------

    private async ensureFolder(folder: string): Promise<void> {
        // Ensure all parent folders exist (e.g. "TaskNotes/Tasks" needs "TaskNotes" first)
        const parts = folder.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current).catch(() => { /* already exists */ });
            }
        }
    }

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

        return `${folder}/${slug}-${Date.now()}.md`;
    }
}
