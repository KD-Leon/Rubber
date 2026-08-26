/**
 * Folder autocomplete for a plain text input.
 *
 * Extracted from EmbeddingsTab (FEAT-72-01 / Issue #72): the chat-linking
 * exclude list needs the same widget, and importing a tab from another tab
 * would couple two unrelated settings screens. The behaviour is unchanged --
 * this is the same class, exported from its own module.
 *
 * `excluded` is read live on every keystroke, so pass the array the caller
 * keeps mutating rather than a copy, and already-picked folders disappear
 * from the suggestions.
 */

import { AbstractInputSuggest } from 'obsidian';
import type { App, TFolder } from 'obsidian';

export class FolderInputSuggest extends AbstractInputSuggest<string> {
    private excluded: string[];
    onPick: (folderPath: string) => void = () => {};

    constructor(app: App, inputEl: HTMLInputElement, excluded: string[]) {
        super(app, inputEl);
        this.excluded = excluded;
    }

    getSuggestions(query: string): string[] {
        const lower = query.toLowerCase().replace(/^\//, '');
        return this.app.vault
            .getAllFolders()
            .map((f: TFolder) => f.path)
            .filter((p: string) => !this.excluded.includes(p) && p.toLowerCase().includes(lower))
            .sort();
    }

    renderSuggestion(value: string, el: HTMLElement): void {
        el.setText(value);
    }

    selectSuggestion(value: string): void {
        this.onPick(value);
        this.close();
    }
}
