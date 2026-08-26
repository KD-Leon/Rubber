/**
 * Setup-wizard skip hints (Phase 2.3).
 *
 * When the user closes the FirstRunWizard without finishing a step,
 * the corresponding setting tab shows an inline banner so the user
 * can pick the configuration back up later. Clicking "Re-open wizard"
 * launches the wizard at the matching step. Clicking the close icon
 * removes the hint without re-opening the wizard.
 */

import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';

export type SkippedStepId =
    | 'welcome'
    | 'llm-model'
    | 'embedding-model'
    | 'role-models'
    | 'search-provider'
    | 'optional-downloads'
    | 'done';

const STEP_MESSAGE_KEYS: Record<string, string> = {
    'llm-model': 'settings.skipHint.llmModel',
    'embedding-model': 'settings.skipHint.embeddingModel',
    'search-provider': 'settings.skipHint.searchProvider',
    'role-models': 'settings.skipHint.roleModels',
};

/**
 * Render a hint banner at the top of a settings tab if the matching
 * step was skipped. Returns true if a hint was rendered (so callers
 * can adjust their layout, e.g. add extra spacing).
 */
export function renderSkipHintIfSkipped(
    containerEl: HTMLElement,
    plugin: ObsidianAgentPlugin,
    stepId: SkippedStepId,
): boolean {
    const skipped = plugin.settings.onboarding?.skippedSteps as string[] | undefined;
    if (!skipped || !skipped.includes(stepId)) return false;

    const messageKey = STEP_MESSAGE_KEYS[stepId];
    if (!messageKey) return false;

    const banner = containerEl.createDiv({ cls: 'vault-op-box vault-op-box--info' });
    const text = banner.createDiv({ cls: 'vault-op-box__text' });
    const headline = text.createEl('strong');
    headline.setText(t('settings.skipHint.title'));
    text.createDiv({ text: t(messageKey) });

    const actions = banner.createDiv({ cls: 'vault-op-box__actions' });
    const reopenBtn = actions.createEl('button', { text: t('settings.skipHint.reopenWizard') });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
    reopenBtn.addEventListener('click', async () => {
        const { FirstRunWizardModal } = await import('../modals/FirstRunWizardModal');
        new FirstRunWizardModal(plugin.app, plugin).open();
    });

    const dismissBtn = actions.createEl('button', { text: t('settings.skipHint.dismiss') });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- event handler / callback returns Promise; errors handled inside
    dismissBtn.addEventListener('click', async () => {
        const arr = plugin.settings.onboarding.skippedSteps as string[];
        const idx = arr.indexOf(stepId);
        if (idx >= 0) {
            arr.splice(idx, 1);
            await plugin.saveSettings();
        }
        banner.detach();
    });

    return true;
}
