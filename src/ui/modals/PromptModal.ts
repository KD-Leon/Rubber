import { App, Modal, Setting } from 'obsidian';
import { applyDestructiveStyle } from '../buttonStyle';

export interface PromptOptions {
    title: string;
    message?: string;
    placeholder?: string;
    defaultValue?: string;
    submitLabel?: string;
    cancelLabel?: string;
}

export interface ChooseOption {
    id: string;
    label: string;
    description?: string;
}

export interface ChooseOptions {
    title: string;
    message?: string;
    options: ChooseOption[];
    cancelLabel?: string;
}

export interface ConfirmOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    /**
     * A document the user should be able to read before deciding, rendered as
     * a link under the message. Terms you are asked to accept and cannot open
     * are not terms, so anything the message names has somewhere to point.
     */
    link?: { label: string; url: string };
}

class PromptModalImpl extends Modal {
    private value: string;
    private submitted = false;

    constructor(
        app: App,
        private opts: PromptOptions,
        private resolve: (value: string | null) => void,
    ) {
        super(app);
        this.value = opts.defaultValue ?? '';
    }

    onOpen(): void {
        const { contentEl, opts } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: opts.title });

        if (opts.message) {
            const desc = contentEl.createEl('p');
            for (const line of opts.message.split('\n')) {
                if (desc.childNodes.length > 0) desc.createEl('br');
                desc.appendText(line);
            }
        }

        new Setting(contentEl).addText((text) => {
            text.setPlaceholder(opts.placeholder ?? '');
            text.setValue(this.value);
            text.onChange((v) => { this.value = v; });
            text.inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submit();
                }
            });
            window.setTimeout(() => text.inputEl.focus(), 0);
        });

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText(opts.cancelLabel ?? 'Cancel')
                .onClick(() => this.close()))
            .addButton((btn) => btn
                .setButtonText(opts.submitLabel ?? 'OK')
                .setCta()
                .onClick(() => this.submit()));
    }

    private submit(): void {
        this.submitted = true;
        this.resolve(this.value);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.submitted) this.resolve(null);
    }
}

class ConfirmModalImpl extends Modal {
    private decided = false;

    constructor(
        app: App,
        private opts: ConfirmOptions,
        private resolve: (confirmed: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl, opts } = this;
        contentEl.empty();

        contentEl.createEl('h3', { text: opts.title });

        const body = contentEl.createEl('p');
        for (const line of opts.message.split('\n')) {
            if (body.childNodes.length > 0) body.createEl('br');
            body.appendText(line);
        }

        if (opts.link) {
            contentEl.createEl('p', { cls: 'agent-confirm-link' }).createEl('a', {
                text: opts.link.label,
                attr: { href: opts.link.url, target: '_blank', rel: 'noopener' },
            });
        }

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText(opts.cancelLabel ?? 'Cancel')
                .onClick(() => this.decide(false)))
            .addButton((btn) => {
                btn.setButtonText(opts.confirmLabel ?? 'Confirm').setCta();
                if (opts.destructive) applyDestructiveStyle(btn);
                btn.onClick(() => this.decide(true));
            });
    }

    private decide(confirmed: boolean): void {
        this.decided = true;
        this.resolve(confirmed);
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.decided) this.resolve(false);
    }
}

/**
 * Pick one of several routes.
 *
 * Distinct from confirmModal: that one asks yes or no about a thing already
 * decided, this one asks which thing. Each option carries a description,
 * because a bare pair of buttons makes the user guess what the difference is.
 * Resolves to null when dismissed.
 */
class ChooseModalImpl extends Modal {
    private decided = false;

    constructor(
        app: App,
        private opts: ChooseOptions,
        private resolve: (value: string | null) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.opts.title });
        if (this.opts.message) contentEl.createEl('p', { text: this.opts.message });

        for (const opt of this.opts.options) {
            const setting = new Setting(contentEl).setName(opt.label);
            if (opt.description) setting.setDesc(opt.description);
            setting.addButton((b) => b
                .setButtonText(opt.label)
                .setCta()
                .onClick(() => {
                    this.decided = true;
                    this.resolve(opt.id);
                    this.close();
                }));
        }

        new Setting(contentEl).addButton((b) => b
            .setButtonText(this.opts.cancelLabel ?? 'Cancel')
            .onClick(() => this.close()));
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.decided) this.resolve(null);
    }
}

export function chooseModal(app: App, opts: ChooseOptions): Promise<string | null> {
    return new Promise((resolve) => new ChooseModalImpl(app, opts, resolve).open());
}

export function promptModal(app: App, opts: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => new PromptModalImpl(app, opts, resolve).open());
}

export function confirmModal(app: App, opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModalImpl(app, opts, resolve).open());
}
