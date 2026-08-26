/**
 * ChatHistoryService
 *
 * Saves and loads chat conversations as JSON files in a user-configured vault folder.
 * Each conversation is stored as {folder}/{id}.json.
 */

import type { Vault } from 'obsidian';
import { generateShortId } from './utils/generateShortId';

export interface HistoryMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface SavedConversation {
    id: string;
    title: string;
    savedAt: string;
    messages: HistoryMessage[];
}

export class ChatHistoryService {
    constructor(private vault: Vault, private folder: string) {}

    async save(messages: HistoryMessage[]): Promise<void> {
        if (!this.folder || messages.length === 0) return;

        await this.ensureFolder();

        // FEAT-55-03 (ADR-171): collision-free id. The old second-granularity
        // ISO id collided when two saves happened in the same second. Dormant
        // today (chatHistoryFolder emptied by FEAT-29-01) but hardened before
        // any re-enable, per the ADR-171 note.
        const id = generateShortId();
        const firstUser = messages.find((m) => m.role === 'user');
        const title = firstUser ? firstUser.content.slice(0, 60) : 'Conversation';

        const conv: SavedConversation = {
            id,
            title,
            savedAt: new Date().toISOString(),
            messages,
        };

        const path = `${this.folder}/${id}.json`;
        await this.vault.adapter.write(path, JSON.stringify(conv, null, 2));
    }

    async list(): Promise<SavedConversation[]> {
        if (!this.folder) return [];
        try {
            const listed = await this.vault.adapter.list(this.folder);
            const results: SavedConversation[] = [];
            for (const file of listed.files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = await this.vault.adapter.read(file);
                    results.push(JSON.parse(raw) as SavedConversation);
                } catch { /* skip malformed files */ }
            }
            // Newest first
            return results.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
        } catch {
            return [];
        }
    }

    async load(id: string): Promise<SavedConversation | null> {
        const path = `${this.folder}/${id}.json`;
        try {
            const raw = await this.vault.adapter.read(path);
            return JSON.parse(raw) as SavedConversation;
        } catch {
            return null;
        }
    }

    async delete(id: string): Promise<void> {
        const path = `${this.folder}/${id}.json`;
        try {
            await this.vault.adapter.remove(path);
        } catch { /* non-fatal */ }
    }

    private async ensureFolder(): Promise<void> {
        const exists = await this.vault.adapter.exists(this.folder);
        if (!exists) {
            await this.vault.adapter.mkdir(this.folder);
        }
    }
}
