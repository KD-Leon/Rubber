/**
 * RecipesTab -- FEAT-30-07: Recipes leben unter Customize neben Rules und
 * Workflows. Der Tab erklaert die Abgrenzung der drei Konzepte und bietet
 * Master- plus per-Recipe-Toggles. Recipes sind KEIN Prompt-Text, sondern
 * geprueft parametrisierte Aufrufe externer Programme (ExecuteRecipeTool,
 * 7-Layer-Security-Kontrakt inkl. spawnAllowlist).
 */

import { App, Setting, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import {
    BUILT_IN_RECIPES,
    validateStoredRecipe,
    type StoredRecipe,
} from '../../core/tools/agent/recipeRegistry';
import { RecipeEditorModal } from '../modals/RecipeEditorModal';
import { confirmModal } from '../modals/PromptModal';
import { t } from '../../i18n';
import { addSectionHeading } from './utils';

export class RecipesTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    private buildConceptIntro(containerEl: HTMLElement): void {
        const infoBanner = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const infoIcon = infoBanner.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(infoIcon, 'lightbulb');
        const infoText = infoBanner.createDiv({ cls: 'vault-op-box__text' });
        infoText.createEl('strong', { text: t('settings.recipes.introTitle') });
        infoText.createDiv({ text: t('settings.recipes.introDesc') });
        const list = infoText.createEl('ul');
        list.createEl('li', { text: t('settings.recipes.conceptRules') });
        list.createEl('li', { text: t('settings.recipes.conceptWorkflows') });
        list.createEl('li', { text: t('settings.recipes.conceptRecipes') });
    }

    /**
     * Single init/normalize helper for settings.recipes (Review-Finding:
     * the `{ enabled, recipeToggles, customRecipes }` literal was
     * copy-pasted at three call sites). Always returns a fully-shaped object.
     */
    private ensureRecipes(): NonNullable<typeof this.plugin.settings.recipes> {
        const s = this.plugin.settings;
        if (!s.recipes) {
            s.recipes = { enabled: true, recipeToggles: {}, customRecipes: [] };
        }
        if (!Array.isArray(s.recipes.customRecipes)) s.recipes.customRecipes = [];
        if (!s.recipes.recipeToggles) s.recipes.recipeToggles = {};
        return s.recipes;
    }

    /** Recipe changes are baked into the execute_recipe tool description; drop the cache so the agent sees them this session. */
    private refreshRecipeToolDefinition(): void {
        this.plugin.toolRegistry?.refreshDefinitions();
    }

    build(containerEl: HTMLElement): void {
        this.buildConceptIntro(containerEl);

        new Setting(containerEl)
            .setName(t('settings.recipes.enable'))
            .setDesc(t('settings.recipes.enableDesc'))
            .addToggle((tg) =>
                tg.setValue(this.plugin.settings.recipes?.enabled ?? true).onChange(async (v) => {
                    this.ensureRecipes().enabled = v;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        if (this.plugin.settings.recipes?.enabled) {
            this.buildBuiltinRecipesSection(containerEl);
            this.buildCustomRecipesSection(containerEl);
        }
    }

    /**
     * FEAT-30-07 Phase 3b: Custom-Recipes anlegen, editieren, loeschen.
     * Jeder Save laeuft durch validateStoredRecipe (Binary gegen die enge
     * Custom-Allowlist, Template-Platzhalter gegen die Parameter, Pattern
     * gegen die ReDoS-Heuristik). Ungueltig persistierte Eintraege werden
     * markiert statt still verworfen.
     */
    private buildCustomRecipesSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.recipes.headingCustom'),
            { body: t('settings.recipes.sectionCustomInfo') },
        );

        const settings = this.plugin.settings;
        const custom = settings.recipes?.customRecipes ?? [];
        const toggles = settings.recipes?.recipeToggles ?? {};
        const takenIds = new Set<string>([
            ...BUILT_IN_RECIPES.map((r) => r.id),
            ...custom.map((r) => r.id),
        ]);

        const openEditor = (existing: StoredRecipe | null) => {
            new RecipeEditorModal(this.app, existing, takenIds, async ({ recipe }) => {
                const store = this.ensureRecipes();
                const idx = existing ? store.customRecipes.findIndex((r) => r.id === existing.id) : -1;
                if (idx >= 0) {
                    // Review-Finding: bei Id-Aenderung wandert der
                    // per-Recipe-Toggle mit, sonst bliebe ein verwaister
                    // Eintrag unter der alten Id und die neue Id waere
                    // ungetogglet -> ein deaktiviertes Recipe wuerde still
                    // wieder aktiviert.
                    if (existing && existing.id !== recipe.id) {
                        if (Object.prototype.hasOwnProperty.call(store.recipeToggles, existing.id)) {
                            store.recipeToggles[recipe.id] = store.recipeToggles[existing.id];
                            delete store.recipeToggles[existing.id];
                        }
                    }
                    store.customRecipes[idx] = recipe;
                } else {
                    store.customRecipes.push(recipe);
                }
                await this.plugin.saveSettings();
                this.refreshRecipeToolDefinition();
                this.rerender();
            }).open();
        };

        for (const recipe of custom) {
            const validation = validateStoredRecipe(recipe);
            const isEnabled = toggles[recipe.id] !== false;
            const row = new Setting(containerEl)
                .setName(recipe.name || recipe.id)
                .setDesc(validation.ok
                    ? t('settings.recipes.recipeDesc', { description: recipe.description, binary: recipe.binary })
                    : t('settings.recipes.customInvalid', { errors: validation.errors.join('; ') }));
            if (validation.ok) {
                row.addToggle((tg) =>
                    tg.setValue(isEnabled).onChange(async (v) => {
                        this.ensureRecipes().recipeToggles[recipe.id] = v;
                        await this.plugin.saveSettings();
                    }),
                );
            }
            row.addButton((btn) => btn
                .setButtonText(t('settings.recipes.customEdit'))
                .onClick(() => openEditor(recipe)));
            row.addButton((btn) => btn
                .setButtonText(t('settings.recipes.customDelete'))
                .onClick(() => {
                    void (async () => {
                        const ok = await confirmModal(this.app, {
                            title: t('settings.recipes.customDeleteConfirmTitle'),
                            message: t('settings.recipes.customDeleteConfirmMessage', { name: recipe.name || recipe.id }),
                            confirmLabel: t('settings.recipes.customDelete'),
                            cancelLabel: t('settings.recipes.editorCancel'),
                        });
                        if (!ok) return;
                        const store = this.ensureRecipes();
                        store.customRecipes = store.customRecipes.filter((r) => r.id !== recipe.id);
                        delete store.recipeToggles[recipe.id];
                        await this.plugin.saveSettings();
                        this.refreshRecipeToolDefinition();
                        this.rerender();
                    })();
                }));
        }

        new Setting(containerEl)
            .setName(t('settings.recipes.customAdd'))
            .setDesc(t('settings.recipes.customAddDesc'))
            .addButton((btn) => btn
                .setButtonText(t('settings.recipes.customAddButton'))
                .setIcon('plus')
                .onClick(() => openEditor(null)));
    }

    private buildBuiltinRecipesSection(containerEl: HTMLElement): void {
        addSectionHeading(containerEl, t('settings.recipes.headingBuiltin'));

        const toggles = this.plugin.settings.recipes?.recipeToggles ?? {};

        for (const recipe of BUILT_IN_RECIPES) {
            const isEnabled = toggles[recipe.id] !== false;
            new Setting(containerEl)
                .setName(recipe.name)
                .setDesc(t('settings.recipes.recipeDesc', { description: recipe.description, binary: recipe.binary }))
                .addToggle((tg) =>
                    tg.setValue(isEnabled).onChange(async (v) => {
                        this.ensureRecipes().recipeToggles[recipe.id] = v;
                        await this.plugin.saveSettings();
                    }),
                );
        }
    }
}
