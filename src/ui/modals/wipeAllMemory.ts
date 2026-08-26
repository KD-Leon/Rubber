/**
 * Right-to-be-forgotten flow shared by MemoryViewerModal (modal footer)
 * and MemoryTab (Settings entry). Two-step confirmation:
 *   1. ConfirmModal listing consequences.
 *   2. PromptModal demanding the user type "DELETE".
 *
 * On confirmation, every Memory v2 + legacy v1 table is wiped and the
 * cached settings (capability hash, token budget) reset so the next
 * plugin onload starts from a clean slate.
 *
 * FEATURE-0319b follow-up.
 */

import type { App } from 'obsidian';
import { Notice } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { confirmModal, promptModal } from './PromptModal';
import { t } from '../../i18n';

export type WipeOutcome = 'deleted' | 'cancelled' | 'failed' | 'no-db';

export async function confirmAndWipeAllMemory(
    app: App,
    plugin: ObsidianAgentPlugin,
): Promise<WipeOutcome> {
    if (!plugin.memoryDB?.isOpen()) {
        new Notice(t('notice.memory.dbNotOpen'));
        return 'no-db';
    }

    const ok = await confirmModal(app, {
        title: t('modal.wipeMemory.title'),
        message: t('modal.wipeMemory.message'),
        confirmLabel: t('modal.wipeMemory.confirm'),
        cancelLabel: t('modal.modelConfig.cancel'),
        destructive: true,
    });
    if (!ok) return 'cancelled';

    const typed = await promptModal(app, {
        title: t('modal.wipeMemory.typeDeleteTitle'),
        message: t('modal.wipeMemory.typeDeleteMessage'),
        placeholder: 'DELETE',
        submitLabel: t('settings.memory.deleteAll'),
    });
    if (typed === null || typed.trim() !== 'DELETE') {
        new Notice(t('notice.memory.wipeCancelled'));
        return 'cancelled';
    }

    try {
        const memDB = plugin.memoryDB;
        const db = memDB.getDB();
        const tables = [
            'memory_audit', 'fact_edges', 'fact_embeddings', 'facts',
            'communication_styles', 'thread_sessions', 'conversation_threads',
            'known_topics', 'memory_source_notes',
            'sessions', 'episodes', 'recipes', 'patterns',
        ];
        for (const table of tables) {
            try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
        }
        await memDB.save().catch(() => undefined);

        plugin.settings.memory.lastCapabilityHash = null;
        plugin.settings.memory.tokenBudgetState = null;
        await plugin.saveSettings();

        new Notice(t('notice.memory.wipeDone'));
        return 'deleted';
    } catch (e) {
        console.warn('[wipeAllMemory] failed:', e);
        new Notice(t('notice.memory.wipeFailed'));
        return 'failed';
    }
}
