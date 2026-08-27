/**
 * ConversationStore
 *
 * Persistence layer for chat conversations.
 * Stores conversations as JSON files in global storage with an in-memory index
 * for fast listing (no disk I/O for list operations).
 *
 * Storage: ~/.obsidian-agent/history/
 *   - index.json         — conversation metadata index
 *   - {id}.json          — individual conversation data
 */

import type { FileAdapter } from '../../core/storage/types';
import type { MessageParam } from '../../api/types';
import type { SourceInterface } from '../memory/SourceInterface';
import { generateShortId } from '../utils/generateShortId';
import { PerFileWriteQueue } from '../utils/perFileWriteQueue';
import { repairUiMessages } from './repairUiMessages';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMeta {
    id: string;
    title: string;
    created: string;
    updated: string;
    messageCount: number;
    mode: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    /**
     * BA-26 / FEAT-23-04: chat surface this conversation came from.
     * Optional for backward-compat with conversations created before
     * Cross-Surface MCP. Reads default to 'obsilo' when missing.
     */
    sourceInterface?: SourceInterface;
    /**
     * BA-26 / FEAT-23-04: gating state for Manual-Sync-Mode.
     * 'pending' conversations are visible in the History sidebar but
     * not picked up by the ExtractionQueue until they get confirmed
     * (Star-click, mark_for_memory, save_to_memory parallel call).
     * Default 'confirmed' for backward-compat.
     */
    syncState?: 'pending' | 'confirmed' | 'rejected';
    /**
     * FIX-23-01-01 / ADR-110 -- Cross-Interface-Thread-Klammer.
     * Identifier (`thread-${YYYY-MM-DD}-${6-hex}`) der mehrere
     * Conversations ueber source_interface-Grenzen hinweg verbindet.
     * Optional: Conversations ohne ID sind nicht Teil eines
     * Cross-Interface-Threads.
     */
    crossInterfaceThreadId?: string;
    /**
     * Provenance of `title`. 'user' bedeutet: manuell ueber den
     * Rename-Button gesetzt; jeder automatische Title-Writer
     * (onComplete-Fallback, LLM-Titler in finalizeConversation,
     * MCP saveConversation/syncSession) muss den Title dann
     * unangetastet lassen. Fehlt das Feld oder ist es 'auto',
     * darf der Title ueberschrieben werden. Backward-compat:
     * alte Konversationen ohne Feld verhalten sich wie 'auto'.
     */
    titleSource?: 'auto' | 'user';
}

/**
 * FIX-44-12: the persisted identity of a checkpoint marker rendered during an
 * assistant turn. Enough to re-render the marker after a reload and to verify
 * it against the shadow repo (commitOid). `toolName` and `skipped` are
 * deliberately NOT persisted -- they are session-only detail, exactly as in
 * the commit-message roundtrip of GitCheckpointService.loadCheckpointsForTask.
 */
export interface PersistedCheckpointMarker {
    taskId: string;
    commitOid: string;
    /** ISO timestamp of the snapshot. */
    timestamp: string;
    filesChanged: string[];
    newFiles?: string[];
}

export interface UiMessage {
    role: 'user' | 'assistant';
    text: string;
    ts: string;
    /**
     * Review F4 (2026-07-29): true for a user bubble that is the typed answer
     * to an ask_followup_question, NOT an independent send. Such an answer
     * enters the API history as a tool_result (role user, but not a real user
     * turn), so it has no matching anchor there. The edit+resend cut
     * (computeEditResendCut) excludes these bubbles from its real-send count so
     * the alignment guard no longer trips for every conversation that used a
     * followup. Persisted with the message so a reloaded conversation keeps the
     * distinction. Optional -- absent means a real send.
     */
    isFollowupAnswer?: boolean;
    /**
     * Serialised HTML of the assistant's collapsed "Steps" block (tool
     * calls + grouped operations) captured when the turn finished.
     * Re-injected on conversation reload so the user can still expand
     * the actions even after switching chats. Optional -- older
     * messages and turns without tool calls omit it.
     */
    toolStepsHtml?: string;
    /**
     * The rendered usage/cost footer line of this assistant turn
     * ("18:55 · 6 in · 176 out · 37.537 cached · 49% hit · 0,049 €"),
     * captured verbatim from the live footer when the turn is persisted.
     * Stored as display text on purpose: recomputing from raw token counts
     * would drift whenever model pricing changes, while the historical line
     * should show what the run actually cost at the time. Optional -- turns
     * saved before 2026-08-10 and runs whose provider reported no usage
     * omit it, and their reloaded bubbles simply stay footer-less.
     */
    usageFooter?: string;
    /**
     * Stable task id for assistant turns. Used by FIX-01-07-02 to
     * re-render the checkpoint markers and undo-bar when an old
     * conversation is re-opened (the sidebar otherwise only renders
     * them inside the live taskCompleted path). Optional for
     * backwards compatibility with pre-2026-05-19 stored conversations
     * -- those messages still render, just without the checkpoint UI
     * block.
     */
    taskId?: string;
    /**
     * FIX-44-12: checkpoint markers rendered during this assistant turn.
     * Persisted so a reloaded conversation can re-render LIVE markers (with
     * working Diff/Undo buttons) at the bubble they belong to, and degrade to
     * a disabled marker when the shadow repo no longer holds the snapshot
     * (REF_RETENTION_DAYS pruning). Optional -- older messages and turns
     * without writes omit it; those fall back to the FIX-01-07-02 legacy
     * rehydration (shadow-repo scan anchored at the task's last bubble).
     */
    checkpoints?: PersistedCheckpointMarker[];
    /**
     * Captured reasoning text for assistant turns produced by reasoner
     * models (DeepSeek deepseek-reasoner via OpenAI-compatible provider,
     * FIX-04-03-07). Replayed on conversation reload as a collapsed
     * "Reasoning..." bubble above the assistant answer. Optional --
     * older messages and non-reasoner turns omit it.
     */
    reasoningText?: string;
}

export interface ConversationData {
    meta: ConversationMeta;
    messages: MessageParam[];
    uiMessages: UiMessage[];
}

/** One full-text match: the conversation plus where it matched. */
export interface ConversationSearchHit {
    conversation: ConversationMeta;
    /** First matching snippet, trimmed to a readable window. */
    snippet: string;
    /** How many messages in this conversation contain the query. */
    matchCount: number;
}

interface ConversationIndex {
    version: number;
    conversations: ConversationMeta[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// FEAT-55-03 (ADR-171): the id logic (AUDIT-016 M-4 + AUDIT-025 H-2:
// crypto.randomUUID, no Math.random fallback, date prefix, 48-bit/day
// entropy) now lives in the shared generateShortId util so run ids and
// conversation ids share one hardened implementation. Kept as a local
// wrapper so existing call sites read unchanged.
function generateId(): string {
    return generateShortId();
}

// ---------------------------------------------------------------------------
// ConversationStore
// ---------------------------------------------------------------------------

/**
 * First line of the first user message, for a conversation file whose meta has
 * no usable title. Same shape the live titling uses, so a recovered row reads
 * like one that was never lost.
 */
function deriveTitleFromMessages(uiMessages: unknown[]): string {
    for (const raw of uiMessages) {
        if (raw === null || typeof raw !== 'object') continue;
        const m = raw as { role?: string; type?: string; text?: string; content?: unknown };
        const isUser = m.role === 'user' || m.type === 'user';
        if (!isUser) continue;
        const text = typeof m.text === 'string'
            ? m.text
            : (typeof m.content === 'string' ? m.content : '');
        const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
        if (!line) continue;
        return line.length > 60 ? `${line.slice(0, 57)}...` : line;
    }
    return '';
}

/**
 * Placeholder title a conversation carries until it has a real one.
 *
 * USER 2026-07-26 renamed it to "New chat". The OLD string stays recognised by
 * isUnnamedTitle, because every conversation created before that day still
 * carries it on disk -- treating those as "already named" would stop the first
 * message from ever titling them.
 */
export const UNNAMED_CONVERSATION_TITLE = 'New chat';
const LEGACY_UNNAMED_TITLES = new Set(['New Conversation', 'New chat', 'New Chat']);

/** True while a conversation still carries a placeholder title. */
export function isUnnamedTitle(title: string | undefined): boolean {
    return title === undefined || title.trim() === '' || LEGACY_UNNAMED_TITLES.has(title.trim());
}

export class ConversationStore {
    private dir: string;
    private indexPath: string;
    private index: ConversationIndex = { version: 1, conversations: [] };
    // FEAT-55-03 (ADR-171): serialize per-conversation read-modify-writes and
    // index writes so two parallel chats (or a save racing an append, or the
    // sidebar racing an MCP/background writer) cannot lose an update. The
    // underlying VaultDataFileAdapter already writes atomically (tmp+rename),
    // so this queue only adds the missing in-process serialization.
    private readonly writeQueue = new PerFileWriteQueue();
    /**
     * Review F3: ids explicitly deleted by the user this session. save()
     * refuses to re-mint a tombstoned id so a stale background session (another
     * tab still holding the deleted conversation) cannot resurrect it. In-memory
     * only: after a restart the row and the session are both gone, so there is
     * nothing to resurrect. Distinct from a ghost-pruned row (never tombstoned),
     * which the FIX-03-20-05 re-mint still recreates.
     */
    private readonly deletedIds = new Set<string>();

    constructor(private fs: FileAdapter) {
        this.dir = 'history';
        this.indexPath = 'history/index.json';
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async initialize(): Promise<void> {
        await this.ensureDir();
        await this.loadIndex();
        await this.reconcileWithDisk();
    }

    // -----------------------------------------------------------------------
    // CRUD
    // -----------------------------------------------------------------------

    /**
     * Create a new conversation and return its id.
     *
     * BA-26 / FEAT-23-04: optional source-tagging + sync-state for
     * Cross-Surface MCP. Default values keep backward-compat with
     * Vault Operator-internal call sites that pass only mode + model.
     */
    async create(
        mode: string,
        model: string,
        opts?: { sourceInterface?: SourceInterface; syncState?: 'pending' | 'confirmed' | 'rejected' },
    ): Promise<string> {
        const id = generateId();
        const now = new Date().toISOString();
        const meta: ConversationMeta = {
            id,
            title: UNNAMED_CONVERSATION_TITLE,
            created: now,
            updated: now,
            messageCount: 0,
            mode,
            model,
            inputTokens: 0,
            outputTokens: 0,
            sourceInterface: opts?.sourceInterface,
            syncState: opts?.syncState,
        };
        this.index.conversations.unshift(meta);
        await this.saveIndex();
        return id;
    }

    /**
     * BA-26 / FEAT-23-03: list conversations filtered by source.
     * Pass `undefined` to get the full list. Conversations without an
     * explicit sourceInterface tag are treated as 'obsilo'.
     */
    listBySource(source: SourceInterface | undefined): ConversationMeta[] {
        if (!source) return this.list();
        return this.index.conversations.filter((c) =>
            (c.sourceInterface ?? 'obsilo') === source
        );
    }

    /**
     * BA-26 / FEAT-23-04: confirm a pending conversation. Idempotent.
     * Returns true on a state change (pending -> confirmed), false
     * if the row was already confirmed or unknown.
     */
    async confirm(id: string): Promise<boolean> {
        const meta = this.getMeta(id);
        if (!meta) return false;
        if ((meta.syncState ?? 'confirmed') === 'confirmed') return false;
        meta.syncState = 'confirmed';
        await this.saveIndex();
        return true;
    }

    /**
     * FIX-23-01-01 / ADR-110: append delta messages to an existing
     * conversation. Living-Document-Pfad fuer Cross-Surface MCP.
     *
     * Reads the existing data, concatenates apiMessages + uiMessages,
     * writes the combined set back. Updates meta.updated +
     * messageCount. Returns the new total messageCount.
     *
     * Returns -1 if the conversation does not exist (caller should
     * fall back to create).
     */
    async appendMessages(
        id: string,
        deltaApiMessages: MessageParam[],
        deltaUiMessages: UiMessage[],
    ): Promise<number> {
        const filePath = `${this.dir}/${id}.json`;
        // FEAT-55-03: serialize the whole load -> merge -> write on this
        // conversation so a concurrent append/save cannot drop a delta.
        return this.writeQueue.run(filePath, async () => {
            const meta = this.getMeta(id);
            if (!meta) return -1;
            const data = await this.load(id);
            if (!data) return -1;

            const combinedApi = [...data.messages, ...deltaApiMessages];
            const combinedUi = [...data.uiMessages, ...deltaUiMessages];

            meta.updated = new Date().toISOString();
            meta.messageCount = combinedUi.length;

            const merged: ConversationData = { meta, messages: combinedApi, uiMessages: combinedUi };
            await this.fs.write(filePath, JSON.stringify(merged));
            await this.saveIndex();
            return combinedUi.length;
        });
    }

    /**
     * FIX-23-01-01: list conversations sharing a Cross-Interface
     * Thread. Returns members across all source interfaces (so
     * History UI can group them).
     */
    listByThread(threadId: string): ConversationMeta[] {
        return this.index.conversations.filter((c) =>
            c.crossInterfaceThreadId === threadId
        );
    }

    /**
     * Phase A3 (history hardening, FIX-03-20-02): persistently rebuild the
     * missing assistant answers of a damaged conversation ON DISK. While the
     * drain-owner gate was broken, files kept the full API history but only
     * the user prompts in uiMessages -- the History list (index messageCount)
     * and every load looked empty. Runs load -> repair -> write inside ONE
     * write-queue slot (appendMessages pattern) so a concurrent session save
     * cannot interleave. created/updated/title stay untouched: ordering and
     * names in History must not change; only messageCount is corrected (file
     * meta and index row). Returns true when the file was rewritten.
     */
    async repairConversation(id: string): Promise<boolean> {
        const filePath = `${this.dir}/${id}.json`;
        return this.writeQueue.run(filePath, async () => {
            const data = await this.load(id);
            if (!data || !Array.isArray(data.messages) || !Array.isArray(data.uiMessages)) return false;
            const repaired = repairUiMessages(data.messages, data.uiMessages);
            if (repaired.length <= data.uiMessages.length) return false;

            const meta: ConversationMeta = { ...data.meta, messageCount: repaired.length };
            const row = this.getMeta(id);
            if (row) row.messageCount = repaired.length;

            const merged: ConversationData = { meta, messages: data.messages, uiMessages: repaired };
            await this.fs.write(filePath, JSON.stringify(merged));
            await this.saveIndex();
            return true;
        });
    }

    /**
     * Save (overwrite) full conversation data.
     *
     * History hardening phase C (FIX-03-20-02): returns { written } and
     * refuses to shrink silently. A payload with FEWER uiMessages than the
     * file holds is a red flag (a stale/thin session state about to clobber a
     * fuller conversation -- the 22.7. Plaud chat was lost exactly so) unless
     * the caller declares the truncation deliberate via allowShrink (pencil
     * edit, checkpoint delete). The cheap RAM check (meta.messageCount) gates
     * an actual file read inside the queue slot; equal-length divergent
     * states remain last-writer-wins (documented limit).
     */
    async save(
        id: string,
        messages: MessageParam[],
        uiMessages: UiMessage[],
        opts?: { allowShrink?: boolean },
    ): Promise<{ written: boolean }> {
        const filePath = `${this.dir}/${id}.json`;
        // FEAT-55-03: serialize against concurrent append/save on this
        // conversation (same per-path key as appendMessages).
        return this.writeQueue.run(filePath, async () => {
            let meta = this.getMeta(id);
            if (meta && !opts?.allowShrink && uiMessages.length < meta.messageCount) {
                const existing = await this.load(id);
                if (existing && existing.uiMessages.length > uiMessages.length) {
                    console.warn(
                        `[ConversationStore] save(${id}) refused: payload has ${uiMessages.length} uiMessages, `
                        + `file holds ${existing.uiMessages.length}. A deliberate truncation must pass allowShrink.`,
                    );
                    return { written: false };
                }
            }
            if (!meta) {
                if (this.deletedIds.has(id)) {
                    // Review F3: this id was explicitly deleted from History.
                    // A late save from a stale background session (another tab
                    // still holding it) must NOT bring the deleted chat back.
                    // A ghost-pruned row is never tombstoned, so the re-mint
                    // below still applies to that (the FIX-03-20-05) case.
                    console.warn(
                        `[ConversationStore] save(${id}) refused: the conversation was deleted; not resurrecting it.`,
                    );
                    return { written: false };
                }
                // FIX-03-20-05: the row can be gone while the session lives on
                // (boot reconcile ghost-prunes messageCount-0 rows without a
                // file). The old `return` here silently discarded EVERY
                // subsequent save for this id -- the 2026-07-28 Storyline chat
                // was lost exactly this way. Re-mint the row from the payload.
                meta = {
                    id,
                    title: deriveTitleFromMessages(uiMessages) || UNNAMED_CONVERSATION_TITLE,
                    created: uiMessages[0]?.ts || new Date().toISOString(),
                    updated: new Date().toISOString(),
                    messageCount: uiMessages.length,
                    mode: 'agent',
                    model: '',
                    inputTokens: 0,
                    outputTokens: 0,
                };
                this.index.conversations.unshift(meta);
                console.warn(
                    `[ConversationStore] save(${id}): index row was missing (ghost-pruned or deleted); re-minted it so the conversation is not silently lost`,
                );
            }

            meta.updated = new Date().toISOString();
            meta.messageCount = uiMessages.length;

            const data: ConversationData = { meta, messages, uiMessages };
            await this.fs.write(filePath, JSON.stringify(data));
            await this.saveIndex();
            return { written: true };
        });
    }

    /** Update metadata fields (e.g., title, token counts). */
    async updateMeta(id: string, patch: Partial<ConversationMeta>): Promise<void> {
        const meta = this.getMeta(id);
        if (!meta) return;
        // Title-Lock fuer issue #45 quirk 2: ein manueller Rename setzt
        // `titleSource: 'user'`. Spaetere Patches automatischer Writer
        // (LLM-Titler, onComplete-Fallback, MCP-Sync) schicken nur
        // `{ title }`; der Lock entfernt das title-Feld aus dem Patch,
        // andere Felder im selben Patch (z.B. crossInterfaceThreadId)
        // bleiben unberuehrt. Ein erneuter expliziter Rename muss
        // weiterhin `titleSource: 'user'` mitschicken und darf
        // ueberschreiben.
        const effective: Partial<ConversationMeta> = { ...patch };
        if (
            meta.titleSource === 'user'
            && effective.title !== undefined
            && effective.titleSource !== 'user'
        ) {
            delete effective.title;
        }
        Object.assign(meta, effective, { updated: new Date().toISOString() });
        await this.saveIndex();
    }

    /** Load full conversation from disk. */
    async load(id: string): Promise<ConversationData | null> {
        const filePath = `${this.dir}/${id}.json`;
        try {
            const raw = await this.fs.read(filePath);
            return JSON.parse(raw) as ConversationData;
        } catch {
            return null;
        }
    }

    /** Return cached index (no disk I/O). Newest first. */
    list(): ConversationMeta[] {
        return this.index.conversations;
    }

    /** Delete a single conversation. */
    async delete(id: string): Promise<void> {
        // Review F3: remember the explicit delete so a late save from a stale
        // background session cannot re-mint the row (see save()).
        this.deletedIds.add(id);
        this.index.conversations = this.index.conversations.filter((c) => c.id !== id);
        await this.saveIndex();
        const filePath = `${this.dir}/${id}.json`;
        try {
            await this.fs.remove(filePath);
        } catch { /* non-fatal */ }
    }

    /** Delete all conversations. */
    async deleteAll(): Promise<void> {
        for (const c of this.index.conversations) {
            // Review F3 (re-verify): tombstone like delete() so a stale
            // background session cannot re-mint a conversation the user just
            // cleared. deleteAll is the same resurrection class as a single
            // delete, only wider.
            this.deletedIds.add(c.id);
            try {
                await this.fs.remove(`${this.dir}/${c.id}.json`);
            } catch { /* non-fatal */ }
        }
        this.index.conversations = [];
        await this.saveIndex();
    }

    /** Get count of stored conversations. */
    count(): number {
        return this.index.conversations.length;
    }

    /**
     * Full-text search over persisted conversation bodies (uiMessages).
     * Scans newest first and stops at the caps, so a large history costs
     * at most maxConversations file reads per query. Caller debounces.
     */
    async searchContent(
        query: string,
        opts?: { maxConversations?: number; maxHits?: number },
    ): Promise<ConversationSearchHit[]> {
        const q = query.trim().toLowerCase();
        if (q.length < 2) return [];
        const maxConversations = opts?.maxConversations ?? 200;
        const maxHits = opts?.maxHits ?? 40;

        const hits: ConversationSearchHit[] = [];
        const candidates = this.index.conversations.slice(0, maxConversations);
        for (const meta of candidates) {
            if (hits.length >= maxHits) break;
            const data = await this.load(meta.id);
            if (!data) continue;
            let matchCount = 0;
            let snippet = '';
            for (const msg of data.uiMessages) {
                if (!msg.text) continue;
                const idx = msg.text.toLowerCase().indexOf(q);
                if (idx === -1) continue;
                matchCount++;
                if (!snippet) {
                    const start = Math.max(0, idx - 40);
                    const end = Math.min(msg.text.length, idx + q.length + 80);
                    const body = msg.text.slice(start, end).replace(/\s+/g, ' ').trim();
                    snippet = `${start > 0 ? '…' : ''}${body}${end < msg.text.length ? '…' : ''}`;
                }
            }
            if (matchCount > 0) {
                hits.push({ conversation: meta, snippet, matchCount });
            }
        }
        return hits;
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    getMeta(id: string): ConversationMeta | undefined {
        return this.index.conversations.find((c) => c.id === id);
    }

    private async ensureDir(): Promise<void> {
        const exists = await this.fs.exists(this.dir);
        if (!exists) {
            await this.fs.mkdir(this.dir);
        }
    }

    /**
     * USER 2026-07-26: "viele Chats in der History lassen sich nicht mehr laden,
     * obwohl sie dort angezeigt werden."
     *
     * This used to catch every failure and start with an EMPTY index. Two very
     * different situations collapsed into one: "there is no index yet" (a fresh
     * vault) and "the index could not be read this once". In the second case the
     * next write persisted the empty list, and every conversation recorded
     * before that moment was gone from the list forever -- while its file sat
     * untouched on disk. Measured in the live vault: 442 conversation files, 96
     * index rows, with a hard cut at one date.
     *
     * The parse failure is now separated from the absence, and neither starts
     * from nothing: reconcileWithDisk rebuilds what the files can tell us.
     */
    private async loadIndex(): Promise<void> {
        if (!(await this.fs.exists(this.indexPath))) {
            this.index = { version: 1, conversations: [] };
            return;
        }
        try {
            const raw = await this.fs.read(this.indexPath);
            const parsed = JSON.parse(raw) as ConversationIndex;
            this.index = {
                version: parsed.version ?? 1,
                conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
            };
        } catch (e) {
            // Present but unreadable. Keep the empty list only as the starting
            // point for the rebuild below; do NOT let it reach disk as-is.
            console.error(
                '[ConversationStore] index.json is present but unreadable; rebuilding it '
                + 'from the conversation files on disk. Cause:',
                e,
            );
            this.index = { version: 1, conversations: [] };
        }
    }

    /**
     * Make the index agree with the files that actually exist.
     *
     * Two directions, both observed in the live vault:
     *
     * ORPHAN FILES -- a conversation file with no index row is invisible in
     * History even though its content is intact. 374 of them, every one from
     * before the index was truncated. A row is rebuilt from the file itself, so
     * they come back with their real title and message count.
     *
     * GHOST ROWS -- an index row whose file was never written. These are what
     * "shows in History but will not load" actually is: a conversation id is
     * minted when a send begins, and if the first save never lands (an empty
     * tab, an interrupted run) the row stays forever pointing at nothing. Only
     * rows with NO messages are dropped: a row that claims content is a
     * different problem and must not be deleted on a hunch.
     */
    private async reconcileWithDisk(): Promise<void> {
        let files: string[];
        try {
            const listed = await this.fs.list(this.dir);
            files = listed.files;
        } catch {
            return; // cannot list: leave the index exactly as it is
        }

        const known = new Set(this.index.conversations.map((c) => c.id));
        const onDisk = new Set<string>();
        const recovered: ConversationMeta[] = [];

        for (const full of files) {
            const name = full.split('/').pop() ?? full;
            if (!name.endsWith('.json') || name === 'index.json') continue;
            const id = name.slice(0, -'.json'.length);
            onDisk.add(id);
            if (known.has(id)) continue;
            const meta = await this.metaFromFile(id);
            if (meta) recovered.push(meta);
        }

        // History hardening phase C (FIX-03-20-02): ghosts must AGE before
        // they are pruned. A freshly created chat whose first save has not
        // landed yet looks exactly like a ghost (messageCount 0, no file) --
        // pruning it at the next boot made the Storyline chat vanish without
        // a trace. 48h keeps such rows visible long enough for the save
        // re-mint (or the user) to catch them; stale leftovers still clean up.
        const ghostCutoff = Date.now() - 48 * 3600 * 1000;
        const ghosts = this.index.conversations.filter((c) => {
            if (onDisk.has(c.id) || (c.messageCount ?? 0) !== 0) return false;
            // Review F6: a missing/unparseable `updated` yields NaN, and
            // `NaN < cutoff` is false -- which kept an empty file-less legacy
            // row forever. Treat an unparseable timestamp as infinitely old so
            // it is still pruned. Fresh rows always carry a valid recent
            // timestamp (create/appendMessages/updateMeta set it), so the 48h
            // aging protection for just-created chats is unaffected.
            const updatedMs = Date.parse(c.updated ?? '');
            return Number.isNaN(updatedMs) || updatedMs < ghostCutoff;
        });
        if (recovered.length === 0 && ghosts.length === 0) return;

        const ghostIds = new Set(ghosts.map((c) => c.id));
        this.index.conversations = [...this.index.conversations.filter((c) => !ghostIds.has(c.id)), ...recovered]
            // Newest first, which is what list() promises.
            .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));

        console.debug(
            `[ConversationStore] index reconciled: +${recovered.length} recovered from disk, `
            + `-${ghosts.length} empty rows with no file`,
        );
        await this.saveIndex();
    }

    /** Rebuild a meta row from a conversation file. Null if unusable. */
    private async metaFromFile(id: string): Promise<ConversationMeta | null> {
        try {
            const raw = await this.fs.read(`${this.dir}/${id}.json`);
            const data = JSON.parse(raw) as Partial<ConversationData>;
            const ui = Array.isArray(data.uiMessages) ? data.uiMessages : [];
            const stored = data.meta;
            // Prefer the meta the file carries; fall back to what can be derived.
            const stat = await this.fs.stat(`${this.dir}/${id}.json`).catch(() => null);
            const fallbackDate = stat ? new Date(stat.mtime).toISOString() : new Date().toISOString();
            return {
                id,
                title: stored?.title?.trim() || deriveTitleFromMessages(ui) || id,
                created: stored?.created ?? fallbackDate,
                updated: stored?.updated ?? fallbackDate,
                messageCount: stored?.messageCount ?? ui.length,
                mode: stored?.mode ?? 'agent',
                model: stored?.model ?? '',
                inputTokens: stored?.inputTokens ?? 0,
                outputTokens: stored?.outputTokens ?? 0,
                sourceInterface: stored?.sourceInterface,
                syncState: stored?.syncState,
            };
        } catch {
            return null;
        }
    }

    private async saveIndex(): Promise<void> {
        await this.fs.write(this.indexPath, JSON.stringify(this.index, null, 2));
    }
}
