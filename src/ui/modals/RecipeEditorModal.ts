/**
 * RecipeEditorModal -- FEAT-30-07 Phase 3b: Formular-Editor fuer
 * Custom-Recipes. Recipes sind Exekutions-Definitionen mit
 * Security-Kontrakt, kein Freitext: das Binary ist auf die enge
 * CUSTOM_RECIPE_ALLOWED_BINARIES-Liste beschraenkt (Dropdown), und jeder
 * Save laeuft durch validateStoredRecipe (dieselbe Pruefung wie beim
 * Laden). Parameter werden als JSON editiert; die Validierung erklaert
 * Fehler feldgenau, statt still zu verwerfen.
 */

import { App, Modal, Setting } from 'obsidian';
import {
    CUSTOM_RECIPE_ALLOWED_BINARIES,
    validateStoredRecipe,
    type StoredRecipe,
    type StoredRecipeParameter,
} from '../../core/tools/agent/recipeRegistry';
import { t } from '../../i18n';

const PARAMS_PLACEHOLDER = `[
  { "name": "input", "type": "vault-file", "required": true, "description": "Input file" },
  { "name": "output", "type": "vault-output", "required": true, "description": "Output file" }
]`;

export interface RecipeEditorResult {
    recipe: StoredRecipe;
}

export class RecipeEditorModal extends Modal {
    private draft: {
        id: string;
        name: string;
        description: string;
        binary: string;
        argsText: string;
        paramsText: string;
        timeout: string;
        maxOutputSize: string;
        producesFile: boolean;
    };

    private errorsEl: HTMLElement | null = null;

    constructor(
        app: App,
        private readonly existing: StoredRecipe | null,
        private readonly takenIds: ReadonlySet<string>,
        private readonly onSave: (result: RecipeEditorResult) => Promise<void>,
    ) {
        super(app);
        this.draft = existing
            ? {
                id: existing.id,
                name: existing.name,
                description: existing.description,
                binary: existing.binary,
                argsText: existing.argsTemplate.join('\n'),
                paramsText: JSON.stringify(existing.parameters, null, 2),
                timeout: String(existing.timeout),
                maxOutputSize: String(existing.maxOutputSize),
                producesFile: existing.producesFile,
            }
            : {
                id: '',
                name: '',
                description: '',
                binary: CUSTOM_RECIPE_ALLOWED_BINARIES[0],
                argsText: '',
                paramsText: PARAMS_PLACEHOLDER,
                timeout: '60000',
                maxOutputSize: '10000',
                producesFile: true,
            };
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', {
            text: this.existing
                ? t('settings.recipes.editorTitleEdit', { name: this.existing.name })
                : t('settings.recipes.editorTitleAdd'),
        });

        new Setting(contentEl)
            .setName(t('settings.recipes.editorId'))
            .setDesc(t('settings.recipes.editorIdDesc'))
            .addText((tx) => tx.setValue(this.draft.id)
                .onChange((v) => { this.draft.id = v.trim(); }));

        new Setting(contentEl)
            .setName(t('settings.recipes.editorName'))
            .addText((tx) => tx.setValue(this.draft.name)
                .onChange((v) => { this.draft.name = v; }));

        new Setting(contentEl)
            .setName(t('settings.recipes.editorDescription'))
            .addText((tx) => tx.setValue(this.draft.description)
                .onChange((v) => { this.draft.description = v; }));

        new Setting(contentEl)
            .setName(t('settings.recipes.editorBinary'))
            .setDesc(t('settings.recipes.editorBinaryDesc'))
            .addDropdown((dd) => {
                for (const b of CUSTOM_RECIPE_ALLOWED_BINARIES) dd.addOption(b, b);
                dd.setValue(this.draft.binary).onChange((v) => { this.draft.binary = v; });
            });

        new Setting(contentEl)
            .setName(t('settings.recipes.editorArgs'))
            .setDesc(t('settings.recipes.editorArgsDesc'))
            .addTextArea((ta) => {
                ta.setPlaceholder('{{input}}\n-o\n{{output}}').setValue(this.draft.argsText)
                    .onChange((v) => { this.draft.argsText = v; });
                ta.inputEl.rows = 4;
                ta.inputEl.addClass('agent-recipe-editor-textarea');
            });

        new Setting(contentEl)
            .setName(t('settings.recipes.editorParams'))
            .setDesc(t('settings.recipes.editorParamsDesc'))
            .addTextArea((ta) => {
                ta.setValue(this.draft.paramsText)
                    .onChange((v) => { this.draft.paramsText = v; });
                ta.inputEl.rows = 8;
                ta.inputEl.addClass('agent-recipe-editor-textarea');
            });

        new Setting(contentEl)
            .setName(t('settings.recipes.editorTimeout'))
            .addText((tx) => tx.setValue(this.draft.timeout)
                .onChange((v) => { this.draft.timeout = v; }));

        new Setting(contentEl)
            .setName(t('settings.recipes.editorMaxOutput'))
            .addText((tx) => tx.setValue(this.draft.maxOutputSize)
                .onChange((v) => { this.draft.maxOutputSize = v; }));

        new Setting(contentEl)
            .setName(t('settings.recipes.editorProducesFile'))
            .addToggle((tg) => tg.setValue(this.draft.producesFile)
                .onChange((v) => { this.draft.producesFile = v; }));

        this.errorsEl = contentEl.createDiv({ cls: 'agent-recipe-editor-errors agent-u-hidden' });

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText(t('settings.recipes.editorSave'))
                .setCta()
                .onClick(() => { void this.trySave(); }))
            .addButton((btn) => btn
                .setButtonText(t('settings.recipes.editorCancel'))
                .onClick(() => this.close()));
    }

    private renderErrors(errors: string[]): void {
        if (!this.errorsEl) return;
        this.errorsEl.empty();
        this.errorsEl.removeClass('agent-u-hidden');
        this.errorsEl.createEl('strong', { text: t('settings.recipes.editorErrorsTitle') });
        const list = this.errorsEl.createEl('ul');
        for (const e of errors) list.createEl('li', { text: e });
    }

    private async trySave(): Promise<void> {
        let parameters: StoredRecipeParameter[];
        try {
            const parsed: unknown = JSON.parse(this.draft.paramsText || '[]');
            if (!Array.isArray(parsed)) throw new Error('not an array');
            parameters = parsed as StoredRecipeParameter[];
        } catch (e) {
            this.renderErrors([t('settings.recipes.editorParamsJsonError', { error: e instanceof Error ? e.message : String(e) })]);
            return;
        }

        const candidate: StoredRecipe = {
            id: this.draft.id,
            name: this.draft.name.trim(),
            description: this.draft.description.trim(),
            binary: this.draft.binary,
            argsTemplate: this.draft.argsText.split('\n').map((s) => s.trim()).filter(Boolean),
            parameters,
            cwd: 'vault-root',
            timeout: Number.parseInt(this.draft.timeout, 10),
            maxOutputSize: Number.parseInt(this.draft.maxOutputSize, 10),
            producesFile: this.draft.producesFile,
        };

        const v = validateStoredRecipe(candidate);
        const errors = [...v.errors];
        if (this.takenIds.has(candidate.id) && candidate.id !== this.existing?.id) {
            errors.push(t('settings.recipes.editorDuplicateId', { id: candidate.id }));
        }
        if (errors.length > 0) {
            this.renderErrors(errors);
            return;
        }
        await this.onSave({ recipe: candidate });
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
