/**
 * DataDiagnosticsTab -- FEAT-30-07: buendelt die frueheren Advanced-Sub-Tabs
 * Backup, Log und Debug zu einem Tab "Data & diagnostics".
 *
 * Reihenfolge Endnutzer-Wert zuerst: Backup & restore (Datensicherung),
 * dann Operation log (Audit-Trail), dann Debugging (ein Toggle).
 * Die drei Bausteine bleiben eigene Klassen; dieser Tab komponiert sie nur.
 */

import type { App } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { BackupTab } from './BackupTab';
import { LogTab } from './LogTab';
import { DebugTab } from './DebugTab';

export class DataDiagnosticsTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    build(containerEl: HTMLElement): void {
        new BackupTab(this.plugin, this.app, this.rerender).build(containerEl);
        new LogTab(this.plugin, this.app, this.rerender).build(containerEl);
        new DebugTab(this.plugin, this.app, this.rerender).build(containerEl);
    }
}
