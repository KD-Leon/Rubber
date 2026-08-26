/**
 * permissionRevoke -- take back exactly one grant.
 *
 * AUDIT 2026-07-26 M-18, the other half of permissionInventory. Listing what
 * was granted is only useful if every row can be undone, so revocation is
 * written against the same id space the inventory produces. One function, one
 * switch, every store: a new consent store that forgets to add a case here
 * fails loudly (`unknown store`) instead of rendering a Revoke button that
 * quietly does nothing.
 *
 * Session grants are the reason this exists as its own module. They were armed
 * by a card, held on the plugin instance, and had no path back other than
 * restarting Obsidian.
 */

import { clearProvenance, parseGrantId } from './permissionInventory';
import type { PermissionInventoryHost } from './permissionInventory';

/** What revocation needs beyond the read host. */
export interface PermissionRevokeHost extends PermissionInventoryHost {
    deviceLocalStore?: {
        listTrusted(): Array<{ name: string; fingerprint?: string }>;
        revokeTrust(name: string): void;
    } | null;
    /** Drops one imported skill's session trust. */
    revokeImportedSkill?: (name: string) => void;
    /**
     * Bumped so per-task pipelines void their cached run grants lazily. Run
     * grants live inside each pipeline and cannot be reached directly; the
     * epoch is how the kill switch already invalidates them.
     */
    approvalRevocationEpoch?: number;
}

export type RevokeResult =
    | { ok: true; needsSave: boolean }
    | { ok: false; reason: string };

/**
 * Revoke a single grant by its inventory id.
 *
 * `needsSave` tells the caller whether vault settings changed, so a purely
 * in-memory revocation (session grants) does not trigger a settings write.
 */
export function revokeGrant(host: PermissionRevokeHost, id: string): RevokeResult {
    const parsed = parseGrantId(id);
    if (!parsed) return { ok: false, reason: `Malformed grant id: ${id}` };
    const { store, key } = parsed;
    const s = host.settings;

    switch (store) {
        case 'autoApproval': {
            s.autoApproval[key] = false;
            // The master stays on: other categories may still be granted, and
            // switching it off here would silently revoke those too.
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'mcpWrite': {
            s.mcpAllowWriteTools = false;
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'pluginApiMethod': {
            const api = s.pluginApi;
            if (api?.safeMethodOverrides) delete api.safeMethodOverrides[key];
            // AUDIT M-15 again: the accumulator that promoted the method has to
            // go with it, or the next approval promotes it straight back and the
            // revocation looks broken.
            if (api?.approvalCounts) delete api.approvalCounts[key];
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'webHost': {
            s.webFetchAllowedHosts = (s.webFetchAllowedHosts ?? []).filter((h) => h !== key);
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'command': {
            s.executeCommandAllowedIds = (s.executeCommandAllowedIds ?? []).filter((e) => e?.id !== key);
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'stdioTrust': {
            if (!host.deviceLocalStore) return { ok: false, reason: 'Device store unavailable.' };
            host.deviceLocalStore.revokeTrust(key);
            // Provenance for a device-scoped grant still lives in vault settings,
            // so it needs clearing and saving even though the trust itself does
            // not live there.
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        case 'sessionGrant': {
            host.sessionApprovedGrants?.delete(key);
            // Run grants are held per pipeline and outlive nothing but the task;
            // bumping the epoch is what makes an already-running task drop them.
            // Without it, revoking a session grant would leave the current run
            // still auto-approving -- exactly the "I took it back and it kept
            // going" failure this whole surface exists to prevent.
            host.approvalRevocationEpoch = (host.approvalRevocationEpoch ?? 0) + 1;
            return { ok: true, needsSave: false };
        }

        case 'importedSkill': {
            if (!host.revokeImportedSkill) return { ok: false, reason: 'Skill trust store unavailable.' };
            host.revokeImportedSkill(key);
            return { ok: true, needsSave: false };
        }

        case 'sandboxScript': {
            // Drop exactly the entry whose content-hash key matches. The list
            // lives inside autoApproval but is NOT a category flag, so it is not
            // reachable through the master toggle -- only here and via the reset.
            const list = s.autoApproval.sandboxScriptGrants;
            if (Array.isArray(list)) {
                s.autoApproval.sandboxScriptGrants = list.filter(
                    (g) => !(g !== null && typeof g === 'object' && (g as { key?: unknown }).key === key),
                );
            }
            clearProvenance(s, id);
            return { ok: true, needsSave: true };
        }

        default:
            return { ok: false, reason: `Unknown store: ${store}` };
    }
}
