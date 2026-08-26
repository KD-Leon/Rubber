/**
 * Obsidian DOM-helper globals for node-env DOM-stub tests.
 *
 * The prefer-create-el refactor (283f0180) moved the inline chat, edit-review
 * and picker UI from `ownerDocument.createElement(tag)` to Obsidian's GLOBAL
 * `createEl(tag)`; the eslint-plugin-obsidianmd 0.4.x shorthand rule then pushed
 * `createEl('div')`/`createEl('span')` to `createDiv()`/`createSpan()` (and
 * `createDocumentFragment` to `createFragment`). Obsidian injects all of these
 * globals at runtime; the vitest node environment does not, so the refactored
 * code throws `createDiv is not defined` under test.
 *
 * These tests each hand-roll their own fake document. Point the globals at that
 * document's factory so `createDiv({ cls, text })` returns the very fake node the
 * assertions inspect, with cls/text applied the way Obsidian's helpers do. The
 * tested components use the global form only (no method chaining on nodes), so a
 * global shim is enough. Test-only, lives under tests/ so the Review-Bot never
 * scans it, never bundled into main.js.
 *
 * Usage: installCreateEl(doc) in beforeEach (once the fake document exists),
 * clearCreateEl() in afterEach so nothing leaks into a test that does not opt in.
 */

interface CreateElHost {
    createElement: (tag: string) => unknown;
    createDocumentFragment?: () => unknown;
}

type ElementInfo = string | { cls?: string | string[]; text?: string; attr?: Record<string, unknown> };

/** Apply the cls/text/attr subset of Obsidian's DomElementInfo to a fake node. */
function applyInfo(node: unknown, info?: ElementInfo): unknown {
    if (info == null) return node;
    const opts = typeof info === 'string' ? { cls: info } : info;
    const n = node as {
        classList?: { add: (c: string) => void };
        setText?: (t: string) => void;
        textContent?: string;
        setAttribute?: (k: string, v: string) => void;
    };
    if (opts.cls != null && n.classList?.add) {
        const classes = Array.isArray(opts.cls) ? opts.cls : String(opts.cls).split(/\s+/);
        for (const c of classes) if (c) n.classList.add(c);
    }
    if (opts.text != null) {
        if (typeof n.setText === 'function') n.setText(String(opts.text));
        else { try { n.textContent = String(opts.text); } catch { /* getter-only stub */ } }
    }
    if (opts.attr && typeof n.setAttribute === 'function') {
        for (const [k, v] of Object.entries(opts.attr)) n.setAttribute(k, String(v));
    }
    return node;
}

export function installCreateEl(doc: CreateElHost): void {
    const create = (tag: string): unknown => doc.createElement(tag);
    const g = globalThis as Record<string, unknown>;
    g.createEl = (tag: string, info?: ElementInfo) => applyInfo(create(tag), info);
    g.createDiv = (info?: ElementInfo) => applyInfo(create('div'), info);
    g.createSpan = (info?: ElementInfo) => applyInfo(create('span'), info);
    g.createFragment = () => (typeof doc.createDocumentFragment === 'function'
        ? doc.createDocumentFragment()
        : create('fragment'));
}

export function clearCreateEl(): void {
    const g = globalThis as Record<string, unknown>;
    delete g.createEl;
    delete g.createDiv;
    delete g.createSpan;
    delete g.createFragment;
}
