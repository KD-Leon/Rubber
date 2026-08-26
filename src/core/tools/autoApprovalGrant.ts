/**
 * autoApprovalGrant (FIX-44-03b)
 *
 * The pure state transition behind the sidebar "Always allow" button, extracted
 * so it can be tested without a DOM. Granting a category from an approval card
 * must never silently re-arm OTHER categories that a past permissive session
 * left true and that the (currently off) master toggle was masking.
 */

import { AUTO_APPROVAL_CATEGORY_KEYS } from './toolEffects';

/**
 * Grant persistent auto-approval for a single category flag.
 *
 * When the master toggle is already on, the flag is simply added -- existing
 * grants are preserved. When the master is off, flipping it on would otherwise
 * reactivate every dormant flag at once, so all category flags are cleared first
 * and only `permKey` is set. The net effect: "from now on auto-approve THIS, and
 * only this".
 *
 * Mutates `cfg` in place (caller persists with a single saveSettings()).
 */
export function grantAutoApproval(cfg: Record<string, unknown>, permKey: string): void {
    if (cfg.enabled !== true) {
        for (const k of AUTO_APPROVAL_CATEGORY_KEYS) cfg[k] = false;
        cfg.enabled = true;
    }
    cfg[permKey] = true;
}

/** The three grant scopes a card can arm beyond a one-shot Allow. */
export type ApprovalGrantScope = 'run' | 'session' | 'standing';

/**
 * FIX-44-03b follow-up (adversarial review 2026-07-14): which scope grants
 * need an explicit destructive confirm before they are armed.
 *
 * Sandbox auto-approval means arbitrary agent-authored code writes the vault
 * without further prompts. The standing grant (settings toggle, "Always
 * allow") already requires a confirm on both surfaces; the session grant
 * lives until the plugin reloads -- days, in practice -- and is functionally
 * close to the standing grant, so it gets the same friction. The run grant
 * dies with the task and stays one click.
 */
export function scopeGrantNeedsConfirm(
    permKey: string | null,
    scope: ApprovalGrantScope,
): boolean {
    return permKey === 'sandbox' && scope !== 'run';
}

/**
 * FEAT-44-07 (kill switch, part a): what the plugin instance must offer so the
 * reset can revoke every approval scope. Structural (not the concrete plugin
 * class) so the transition stays testable without a DOM or an Obsidian app.
 */
export interface ApprovalKillSwitchHost {
    // `object`, not Record: the concrete AutoApprovalConfig interface has no
    // index signature, and the transition only Object.assigns into it.
    settings: {
        autoApproval: object;
        /**
         * AUDIT 2026-07-26 M-13: standing consent that lets INBOUND MCP callers
         * write vault files and long-term memory with no card. It lives outside
         * `autoApproval`, so the old reset left it armed.
         */
        mcpAllowWriteTools?: boolean;
        /**
         * Plugin-API methods promoted to no-prompt, plus the accumulator that
         * promoted them. Both live outside `autoApproval` and both survived.
         */
        pluginApi?: {
            safeMethodOverrides?: Record<string, boolean>;
            approvalCounts?: Record<string, number>;
        };
        /** AUDIT 2026-07-26 M-5: hosts web_fetch may reach without asking. */
        webFetchAllowedHosts?: string[];
        /** AUDIT 2026-07-26 M-8: Obsidian commands enrolled by the user. */
        executeCommandAllowedIds?: unknown[];
        /** AUDIT 2026-07-26 M-18: the provenance records of the cleared grants. */
        grantProvenance?: Record<string, unknown>;
    };
    /** FEAT-44-02a session grants; cleared by the reset. */
    sessionApprovedGrants?: Set<string>;
    /** Bumped so per-task pipelines void their run grants lazily. */
    approvalRevocationEpoch?: number;
    /**
     * AUDIT 2026-07-26 M-18: per-device stdio spawn trust. Device-scoped, so it
     * lives outside settings, but a reset that leaves it armed would contradict
     * the list on the same tab -- and the two drifting apart is how the stores
     * got into this state to begin with.
     */
    deviceLocalStore?: { listTrusted(): Array<{ name: string }>; revokeTrust(name: string): void } | null;
}

/**
 * One-click return to the fail-closed default (FEAT-44-07 part a):
 *
 * 1. apply the restrictive preset (master off, every category off) -- the
 *    preset is passed in by the caller (PRESETS.restrictive) to keep this
 *    module free of the UpdateSettingsTool dependency,
 * 2. clear all session-scope grants,
 * 3. bump the revocation epoch so every pipeline's run-scope grants are
 *    voided on its next approval check.
 *
 * Mutates the host in place; the caller persists settings and re-renders.
 * paranoidMode is deliberately NOT touched: turning the brake off is never
 * a side effect of pressing another brake.
 */
export function resetToDefaultDeny(
    host: ApprovalKillSwitchHost,
    restrictivePreset: Record<string, unknown>,
    /**
     * AUDIT 2026-07-26 M-13: clears the imported-skill trust-on-first-use set.
     * Injected because that Set is module state inside InvokeSkillTool, which
     * this module must not import (it would drag the whole tool graph in).
     */
    clearImportedSkillTrust?: () => void,
): void {
    Object.assign(host.settings.autoApproval, restrictivePreset);
    host.sessionApprovedGrants?.clear();
    host.approvalRevocationEpoch = (host.approvalRevocationEpoch ?? 0) + 1;

    // Content-hash grant (M-1 follow-up): the persistent "always allow THIS
    // script" list is a standing consent too, and it lives INSIDE autoApproval,
    // so the restrictive preset (which names only category flags) does not touch
    // it. Clear it here with a FRESH array -- assigning the preset's own [] would
    // alias every reset onto one shared array. A reset that left these armed
    // would be the M-18 failure: the button promises default-deny while
    // agent-authored scripts still run without a card.
    const autoApproval = host.settings.autoApproval as { sandboxScriptGrants?: unknown[] };
    if (autoApproval.sandboxScriptGrants !== undefined) {
        autoApproval.sandboxScriptGrants = [];
    }

    // AUDIT 2026-07-26 M-13: the consents that live OUTSIDE settings.autoApproval.
    // The old reset touched only that object, so a button labelled "reset
    // permissions to default-deny" left inbound MCP write access armed and every
    // promoted plugin-API method in place -- the exact opposite of what its name
    // promises, and worse than no brake because the user believes they are covered.

    // Inbound MCP write consent. `false` IS the shipped default (settings.ts),
    // so resetting to default means clearing it.
    if (host.settings.mcpAllowWriteTools !== undefined) {
        host.settings.mcpAllowWriteTools = false;
    }

    // Promoted plugin-API methods AND their approval counts. Dropping the
    // overrides alone is not enough: the counts stay above the promotion
    // threshold, so the very next approval re-promotes the same method.
    const pluginApi = host.settings.pluginApi;
    if (pluginApi) {
        if (pluginApi.safeMethodOverrides) pluginApi.safeMethodOverrides = {};
        if (pluginApi.approvalCounts) pluginApi.approvalCounts = {};
    }

    // Imported-skill trust-on-first-use.
    clearImportedSkillTrust?.();

    // AUDIT 2026-07-26 M-5 / M-18: the stores the permissions list renders must
    // ALL be reachable from the one button that claims to clear everything.
    // Anything listed there but missed here would reappear after a reset and
    // teach the user that the brake does not work.
    if (host.settings.webFetchAllowedHosts !== undefined) {
        host.settings.webFetchAllowedHosts = [];
    }
    if (host.settings.executeCommandAllowedIds !== undefined) {
        host.settings.executeCommandAllowedIds = [];
    }
    for (const entry of host.deviceLocalStore?.listTrusted() ?? []) {
        host.deviceLocalStore?.revokeTrust(entry.name);
    }
    // Provenance records of grants that no longer exist. Kept last so the
    // clearing above cannot re-stamp anything.
    if (host.settings.grantProvenance !== undefined) {
        host.settings.grantProvenance = {};
    }
}
