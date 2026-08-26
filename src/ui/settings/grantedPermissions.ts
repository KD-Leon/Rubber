/**
 * grantedPermissions -- the specific permissions, the ones no switch covers.
 *
 * AUDIT 2026-07-26 M-18, second pass after user feedback.
 *
 * The first version listed everything, including the auto-approve categories,
 * and that was wrong in a way worth recording. A category appeared twice on one
 * screen: once as a row here and once as its toggle below. Two controls for one
 * piece of state read as two pieces of state, so taking one back looked broken
 * even when it worked. Duplicating a control is not redundancy, it is a second
 * source of truth.
 *
 * The split now follows what the user can actually reason about:
 *
 * - A CATEGORY ("may edit notes") is a standing capability. Its home is the
 *   toggle. What the toggle could never say is WHO turned it on, so the
 *   provenance line moved onto the toggle instead of into a second row.
 * - A SPECIFIC grant ("this MCP server", "this host", "this plugin-API
 *   method", "for this session") has no toggle and never had a surface. That
 *   is this list, and it is all this list is.
 *
 * It sits at the END of the tab: it is a record to review, not a control to
 * reach for, and the switches above are what someone opening the tab is
 * looking for.
 *
 * Uses the Obsidian DOM API and CSS classes rather than inline styles, per the
 * review-bot rules.
 */

import { Notice, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import { addSectionHeading } from './utils';
import {
    collectGrants,
    type GrantEntry,
    type GrantScope,
    type GrantStoreId,
    type PermissionInventoryHost,
} from '../../core/governance/permissionInventory';
import { revokeGrant, type PermissionRevokeHost } from '../../core/governance/permissionRevoke';
import { listTrustedImportedSkills, revokeImportedSkillTrust } from '../../core/tools/agent/InvokeSkillTool';

/**
 * Effect names, mapped to the labels the approval card uses. Session grants are
 * keyed by effect, so this is the only place a category name still appears --
 * and there it is a live grant, not a duplicate of a toggle.
 */
const EFFECT_LABEL: Record<string, () => string> = {
    'note-edit': () => t('ui.approval.noteEdits'),
    'vault-change': () => t('ui.approval.vaultChanges'),
    web: () => t('ui.approval.web'),
    mcp: () => t('ui.approval.mcp'),
    subtask: () => t('ui.approval.subAgents'),
    skill: () => t('ui.approval.pluginSkills'),
    sandbox: () => t('ui.approval.sandbox'),
    recipe: () => t('ui.approval.recipes'),
    'plugin-api:read': () => `${t('ui.approval.pluginApi')} (${t('ui.approval.read')})`,
    'plugin-api:write': () => `${t('ui.approval.pluginApi')} (${t('settings.permissions.write')})`,
    config: () => t('ui.approval.config'),
    'self-modify': () => t('ui.approval.selfModify'),
    read: () => t('ui.approval.read'),
};

function labelFor(storeId: GrantStoreId, key: string): string {
    if (storeId === 'sessionGrant') return EFFECT_LABEL[key]?.() ?? key;
    switch (storeId) {
        case 'mcpWrite': return t('settings.permissions.grantMcpWrite');
        case 'pluginApiMethod': return t('settings.permissions.grantPluginApiMethod');
        case 'stdioTrust': return t('settings.permissions.grantStdioTrust');
        case 'importedSkill': return t('settings.permissions.grantImportedSkill');
        case 'webHost': return t('settings.permissions.grantWebHost');
        case 'command': return t('settings.permissions.grantCommand');
        case 'sandboxScript': return t('settings.permissions.grantSandboxScript');
        default: return key;
    }
}

const SCOPE_LABEL: Record<GrantScope, () => string> = {
    vault: () => t('settings.permissions.scopeVault'),
    device: () => t('settings.permissions.scopeDevice'),
    session: () => t('settings.permissions.scopeSession'),
    run: () => t('settings.permissions.scopeRun'),
};

/** "Allowed from a card on 14 Jul 2026". Exported: the toggles use it too. */
export function provenanceText(entry: Pick<GrantEntry, 'provenance'>): string {
    const when = entry.provenance.at !== undefined
        ? new Date(entry.provenance.at).toLocaleDateString()
        : '';
    switch (entry.provenance.origin) {
        case 'card':
            return when
                ? t('settings.permissions.originCardOn', { date: when })
                : t('settings.permissions.originCard');
        case 'settings': return t('settings.permissions.originSettings');
        case 'preset': return t('settings.permissions.originPreset');
        case 'onboarding': return t('settings.permissions.originOnboarding');
        default: return t('settings.permissions.originUnknown');
    }
}

/**
 * Provenance line for one auto-approve category, or null when nothing was
 * recorded. Appended to the toggle's description, which is where the question
 * "who turned this on?" actually gets asked.
 */
export function categoryProvenanceText(
    plugin: ObsidianAgentPlugin,
    categoryKey: string,
): string | null {
    const rec = plugin.settings.grantProvenance?.[`autoApproval:${categoryKey}`];
    if (!rec) return null;
    return provenanceText({ provenance: rec });
}

/**
 * The grants this list renders: everything the inventory found EXCEPT the
 * auto-approve categories.
 *
 * A category's control is its toggle. Rendering it here as well put one piece
 * of state behind two controls, so revoking in one place left the other looking
 * untouched and the whole surface looked broken. The inventory still collects
 * categories -- the kill switch needs the complete set -- but the display
 * decision belongs here, stated once and testable.
 */
export function specificGrantsOnly(entries: readonly GrantEntry[]): GrantEntry[] {
    return entries.filter((e) => e.store !== 'autoApproval');
}

function hostOf(plugin: ObsidianAgentPlugin): PermissionInventoryHost & PermissionRevokeHost {
    return plugin as unknown as PermissionInventoryHost & PermissionRevokeHost;
}

/**
 * Render the section at the end of the Permissions tab.
 *
 * `rerender` redraws the whole tab. The row is also removed from the DOM
 * directly before that call: a revoke that visibly does nothing is exactly the
 * complaint this surface exists to answer, so the feedback must not depend on
 * the redraw path succeeding.
 */
export function buildGrantedPermissionsSection(
    plugin: ObsidianAgentPlugin,
    containerEl: HTMLElement,
    rerender: () => void,
): void {
    const host = hostOf(plugin);
    // The two session stores are module state, not plugin fields.
    host.listTrustedImportedSkills = listTrustedImportedSkills;
    host.revokeImportedSkill = revokeImportedSkillTrust;

    const entries = specificGrantsOnly(collectGrants(host, labelFor));

    const section = containerEl.createDiv('agent-granted');
    // USER 2026-07-26: was a hand-rolled <h4> in its own div, which sat at a
    // different indent than every other heading on the tab. Use the shared
    // helper so it lines up and carries the same info affordance.
    addSectionHeading(
        section,
        t('settings.permissions.headingGranted'),
        { body: t('settings.permissions.sectionGrantedInfo') },
    );

    if (entries.length === 0) {
        const empty = section.createDiv('agent-granted-empty');
        const icon = empty.createSpan({ cls: 'agent-granted-empty-icon' });
        setIcon(icon, 'shield-check');
        empty.createSpan({ text: t('settings.permissions.grantedEmpty') });
        return;
    }

    const list = section.createDiv('agent-granted-list');
    for (const entry of entries) {
        const row = list.createDiv('agent-granted-row');

        const main = row.createDiv('agent-granted-main');
        main.createDiv({ cls: 'agent-granted-title', text: entry.label });
        // One meta line, not three: what it covers, how far it reaches, where
        // it came from. The first version spent a full Setting row per grant
        // and pushed the list off the screen.
        const meta: string[] = [];
        if (entry.detail !== undefined) meta.push(entry.detail);
        meta.push(SCOPE_LABEL[entry.scope]());
        meta.push(provenanceText(entry));
        main.createDiv({ cls: 'agent-granted-meta', text: meta.join(' · ') });

        const btn = row.createEl('button', {
            cls: 'agent-granted-revoke',
            text: t('settings.permissions.revoke'),
        });
        btn.addEventListener('click', () => {
            void (async () => {
                try {
                    const result = revokeGrant(host, entry.id);
                    if (!result.ok) {
                        new Notice(t('settings.permissions.revokeFailed', { reason: result.reason }));
                        return;
                    }
                    // Immediate, local feedback first. A failure further down
                    // (settings write, tab redraw) must not leave the click
                    // looking like it did nothing -- the grant IS already gone
                    // from the store at this point.
                    row.remove();
                    if (result.needsSave) await plugin.saveSettings();
                    new Notice(t('settings.permissions.revoked', { what: entry.label }));
                    rerender();
                } catch (e) {
                    // Never swallow: a silent Take-back is the failure mode this
                    // whole surface exists to prevent.
                    const reason = e instanceof Error ? e.message : String(e);
                    new Notice(t('settings.permissions.revokeFailed', { reason }));
                    rerender();
                }
            })();
        });
    }
}
