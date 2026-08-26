/**
 * permissionInventory -- one list of everything the user has said yes to.
 *
 * AUDIT 2026-07-26 M-18. Consent was spread across a dozen stores that each
 * grew their own surface, or none: the auto-approve categories were toggles on
 * the Permissions tab, promoted plugin-API methods lived under Advanced, stdio
 * trust lived in the MCP tab, and session grants, imported-skill trust and the
 * MCP write flag had no surface at all. So the honest answer to "what have I
 * allowed, and how do I take it back?" was: look in four places, and for some
 * of it you cannot.
 *
 * The deeper problem is framing. A toggle labelled "Note edits" reads as a
 * capability switch, not as a record of a decision. A user who clicked "Always
 * allow" on a card three days ago sees a switch that is on and no indication
 * that they are the reason. Consent that cannot be reviewed is not consent, it
 * is a setting that happens to have been set.
 *
 * This module produces a flat, uniform list: what was granted, how far it
 * reaches, where it came from, and a function that takes it back. Pure and
 * host-shaped (no Obsidian, no DOM) so every entry can be tested, and so the
 * kill switch and the settings tab enumerate the SAME set rather than drifting
 * apart the way the stores did.
 *
 * Scope is deliberately part of every entry. "This vault", "this device" and
 * "until Obsidian restarts" have very different blast radii, and the old
 * surfaces never said which one a given control had.
 */

import { AUTO_APPROVAL_CATEGORY_KEYS } from '../tools/toolEffects';

/** How far a grant reaches. Ordered from widest to narrowest. */
export type GrantScope =
    /** Persisted in vault settings; travels with the vault (and with Sync). */
    | 'vault'
    /** Persisted per device outside the vault; does not travel. */
    | 'device'
    /** Lives until the plugin reloads (Obsidian restart or plugin toggle). */
    | 'session'
    /** Lives until the current agent run ends. */
    | 'run';

/** Where a grant came from, when we know. */
export type GrantOrigin = 'card' | 'settings' | 'preset' | 'onboarding' | 'unknown';

export interface GrantProvenance {
    origin: GrantOrigin;
    /** Epoch ms. Absent for grants made before provenance was recorded. */
    at?: number;
}

export interface GrantEntry {
    /** Stable id: `<store>:<key>`. Used as the revoke handle and the DOM key. */
    id: string;
    /** Which store holds it, for grouping in the UI. */
    store: GrantStoreId;
    /** What was granted, in the user's terms. Not an internal key. */
    label: string;
    /** Optional second line: the concrete thing (method name, server, host). */
    detail?: string;
    scope: GrantScope;
    provenance: GrantProvenance;
}

export type GrantStoreId =
    | 'autoApproval'
    | 'mcpWrite'
    | 'pluginApiMethod'
    | 'stdioTrust'
    | 'importedSkill'
    | 'webHost'
    | 'command'
    | 'sessionGrant'
    /** Content-hash "always allow this script" grant (autoApproval.sandboxScriptGrants). */
    | 'sandboxScript';

/**
 * What the inventory needs from the plugin. Structural on purpose: the concrete
 * plugin class drags in Obsidian, and every store here is independently
 * testable only if the reader does not.
 */
export interface PermissionInventoryHost {
    settings: {
        autoApproval: Record<string, unknown>;
        mcpAllowWriteTools?: boolean;
        pluginApi?: { safeMethodOverrides?: Record<string, boolean>; approvalCounts?: Record<string, number> };
        /** AUDIT M-18: when and how each grant was made. Keyed by GrantEntry.id. */
        grantProvenance?: Record<string, GrantProvenance>;
        /** AUDIT M-5: hosts the user allowed web_fetch to reach. */
        webFetchAllowedHosts?: string[];
        /** AUDIT M-8: Obsidian commands the user enabled for the agent. */
        executeCommandAllowedIds?: Array<{ id: string; name?: string; at?: number }>;
    };
    /** FEAT-44-02a session grants (effect keys). */
    sessionApprovedGrants?: Set<string>;
    /**
     * Per-device stdio spawn trust. Named to match the plugin field so the
     * structural cast in the UI carries it; `null` because it is null on mobile.
     */
    deviceLocalStore?: { listTrusted(): Array<{ name: string; fingerprint?: string }> } | null;
    /** Imported skills approved for this session. */
    listTrustedImportedSkills?: () => string[];
}

/** Human labels for the auto-approve categories, resolved by the caller's t(). */
export type LabelResolver = (storeId: GrantStoreId, key: string) => string;

const UNKNOWN: GrantProvenance = { origin: 'unknown' };

function provenanceFor(host: PermissionInventoryHost, id: string): GrantProvenance {
    return host.settings.grantProvenance?.[id] ?? UNKNOWN;
}

/**
 * Every standing and live grant, widest scope first.
 *
 * Reads only; nothing here mutates. Revocation is a separate call so a caller
 * can render the list without any risk of changing it.
 */
export function collectGrants(host: PermissionInventoryHost, label: LabelResolver): GrantEntry[] {
    const out: GrantEntry[] = [];
    const s = host.settings;

    // --- Auto-approve categories (vault settings) ---------------------------
    // Only listed while the master is on: with the master off the flags are
    // inert, and showing an inert flag as an active grant would be a lie in the
    // alarming direction. The master itself is the first entry so the user can
    // switch everything off in one place.
    if (s.autoApproval.enabled === true) {
        for (const key of AUTO_APPROVAL_CATEGORY_KEYS) {
            if (s.autoApproval[key] !== true) continue;
            const id = `autoApproval:${key}`;
            out.push({
                id,
                store: 'autoApproval',
                label: label('autoApproval', key),
                scope: 'vault',
                provenance: provenanceFor(host, id),
            });
        }
    }

    // --- Per-script sandbox grants (vault settings, content-hash keyed) -----
    // NOT gated by the master toggle: the M-1 branch consults these directly,
    // regardless of autoApproval.enabled, so listing them only while the master
    // is on would hide a grant that is actually in force. Each is pinned to one
    // byte-state of one script; the skill/script names ride along for display.
    const scriptGrants = s.autoApproval.sandboxScriptGrants;
    if (Array.isArray(scriptGrants)) {
        for (const g of scriptGrants) {
            if (g === null || typeof g !== 'object') continue;
            const rec = g as { key?: unknown; skill?: unknown; script?: unknown; grantedAt?: unknown };
            if (typeof rec.key !== 'string' || rec.key.length === 0) continue;
            const id = `sandboxScript:${rec.key}`;
            const at = typeof rec.grantedAt === 'string' && !Number.isNaN(Date.parse(rec.grantedAt))
                ? Date.parse(rec.grantedAt)
                : undefined;
            out.push({
                id,
                store: 'sandboxScript',
                label: label('sandboxScript', rec.key),
                detail: typeof rec.skill === 'string' && typeof rec.script === 'string'
                    ? `${rec.skill} / ${rec.script}`
                    : undefined,
                scope: 'vault',
                provenance: { origin: 'card', ...(at !== undefined ? { at } : {}) },
            });
        }
    }

    // --- Inbound MCP write consent (vault settings) -------------------------
    if (s.mcpAllowWriteTools === true) {
        const id = 'mcpWrite:enabled';
        out.push({
            id,
            store: 'mcpWrite',
            label: label('mcpWrite', 'enabled'),
            scope: 'vault',
            provenance: provenanceFor(host, id),
        });
    }

    // --- Plugin-API methods promoted to no-prompt (vault settings) ----------
    const overrides = s.pluginApi?.safeMethodOverrides ?? {};
    for (const method of Object.keys(overrides).sort()) {
        if (overrides[method] !== true) continue;
        const id = `pluginApiMethod:${method}`;
        out.push({
            id,
            store: 'pluginApiMethod',
            label: label('pluginApiMethod', method),
            detail: method,
            scope: 'vault',
            provenance: provenanceFor(host, id),
        });
    }

    // --- Hosts web_fetch may reach (vault settings) -------------------------
    for (const hostName of [...(s.webFetchAllowedHosts ?? [])].sort()) {
        const id = `webHost:${hostName}`;
        out.push({
            id,
            store: 'webHost',
            label: label('webHost', hostName),
            detail: hostName,
            scope: 'vault',
            provenance: provenanceFor(host, id),
        });
    }

    // --- Obsidian commands the user enrolled (vault settings) ---------------
    // Only the user-enrolled tier is listed. The built-in allowlist ships with
    // the plugin and is not a decision the user made, so showing it here as
    // something to "take back" would be a lie in both directions.
    for (const entry of s.executeCommandAllowedIds ?? []) {
        if (typeof entry?.id !== 'string' || entry.id.length === 0) continue;
        const id = `command:${entry.id}`;
        out.push({
            id,
            store: 'command',
            label: label('command', entry.id),
            detail: entry.name ? `${entry.name} (${entry.id})` : entry.id,
            scope: 'vault',
            provenance: entry.at !== undefined
                ? { origin: 'settings', at: entry.at }
                : provenanceFor(host, id),
        });
    }

    // --- stdio spawn trust (per device, never synced) -----------------------
    for (const entry of host.deviceLocalStore?.listTrusted() ?? []) {
        const id = `stdioTrust:${entry.name}`;
        out.push({
            id,
            store: 'stdioTrust',
            label: label('stdioTrust', entry.name),
            detail: entry.name,
            scope: 'device',
            provenance: provenanceFor(host, id),
        });
    }

    // --- Session-scoped grants (die on plugin reload) -----------------------
    // These had no surface at all: the card's "Allow this session" armed a set
    // on the plugin instance that nothing ever showed or cleared short of a
    // restart.
    for (const key of [...(host.sessionApprovedGrants ?? [])].sort()) {
        out.push({
            id: `sessionGrant:${key}`,
            store: 'sessionGrant',
            label: label('sessionGrant', key),
            scope: 'session',
            provenance: { origin: 'card' },
        });
    }

    // --- Imported skills approved this session ------------------------------
    for (const name of host.listTrustedImportedSkills?.() ?? []) {
        out.push({
            id: `importedSkill:${name}`,
            store: 'importedSkill',
            label: label('importedSkill', name),
            detail: name,
            scope: 'session',
            provenance: { origin: 'card' },
        });
    }

    return out;
}

/** Count by scope, for the summary line above the list. */
export function countByScope(entries: readonly GrantEntry[]): Record<GrantScope, number> {
    const counts: Record<GrantScope, number> = { vault: 0, device: 0, session: 0, run: 0 };
    for (const e of entries) counts[e.scope] += 1;
    return counts;
}

/**
 * Record how a grant was made, so the list can say "you allowed this from a
 * card on the 14th" instead of showing a switch with no history.
 *
 * Mutates settings in place; the caller persists. Stamping is best-effort by
 * design: a missing stamp degrades to origin `unknown`, never to a wrong claim.
 */
export function stampProvenance(
    settings: { grantProvenance?: Record<string, GrantProvenance> },
    id: string,
    provenance: GrantProvenance,
): void {
    settings.grantProvenance ??= {};
    settings.grantProvenance[id] = provenance;
}

/**
 * Drop the provenance record for a revoked grant.
 *
 * Without this the map grows without bound and, worse, a later re-grant would
 * inherit the old timestamp and claim the user allowed it earlier than they
 * did. Same lesson as the promotion counter that survived its own removal.
 */
export function clearProvenance(
    settings: { grantProvenance?: Record<string, GrantProvenance> },
    id: string,
): void {
    if (settings.grantProvenance) delete settings.grantProvenance[id];
}

/**
 * Parse a grant id back into store and key.
 *
 * The key may itself contain ':' (a plugin-API method, a host with a port), so
 * this splits on the FIRST separator only. Splitting on every colon is how a
 * revoke button silently targets the wrong entry.
 */
export function parseGrantId(id: string): { store: string; key: string } | null {
    const i = id.indexOf(':');
    if (i <= 0 || i === id.length - 1) return null;
    return { store: id.slice(0, i), key: id.slice(i + 1) };
}
