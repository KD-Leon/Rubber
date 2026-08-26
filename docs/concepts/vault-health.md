---
title: Vault health
description: How Vault Operator monitors the structural integrity of your knowledge graph, scores cluster freshness, and surfaces problems through severity-tiered findings.
---

# Vault health

Vault Operator runs continuous structural checks on your vault and surfaces problems through a single repair modal. The system is distinct from the `vault_health_check` tool: the tool is one of three ways the checks fire, alongside a silent background pass and a periodic web-update pass.

## What gets checked

Nine classes of finding, computed against the [knowledge layer](./knowledge-layer.md). The list mirrors the `HealthCheckType` union in `src/core/knowledge/VaultHealthService.ts`:

| Check | What it finds |
|-------|---------------|
| Orphaned notes | Notes with zero inbound links |
| Missing backlinks | A note links out but the target does not link back |
| Broken links | Wikilinks pointing to files that no longer exist |
| Weak clusters | Semantically similar notes with no wikilink between them |
| Inconsistent tags | Spelling variants like `#meeting` vs `#meetings` |
| Category mismatches | A note's declared category does not match the cluster it actually sits in |
| God nodes | Hub notes with so many inbound connections they stop being useful indexes |
| Stale clusters | Cluster freshness score below the configured threshold |
| Source concentration | A cluster draws too heavily from one source domain |

Freshness scoring drives the stale-cluster check. It runs per cluster, on a 0-100 scale, with three weighted inputs. The full formula lives inline in the `cluster_freshness` check in `src/core/knowledge/VaultHealthService.ts`; `src/core/health/Stufe2ActivityTrigger.ts` carries a simplified copy that only scores the age term:

- 60% content age, scaled against the cluster's half-life
- 30% coverage drift (the share of cluster notes older than the half-life)
- 10% stale-reference rate, currently a fixed baseline (broken external links are not measured yet)

Thresholds map to severity: under 30 is Critical, 30 to 50 is Warning, 50 to 70 is Hint, above 70 is fine.

## How checks fire

Three trigger paths:

**Stage 1 (silent structural pass).** The `cluster_freshness` check runs together with the other structural checks: as a background job when the vault opens, and on every scan you or the agent trigger. Pure database queries, no UI noise, no LLM call. Findings feed the health badge and the repair modal like any other check.

**Stage 2 (activity-based hint).** When you open or edit a note in a cluster that scores below 70, the trigger (`src/core/health/Stufe2ActivityTrigger.ts`) may offer a subtle hint with a light web-update option. Each cluster is rate-limited to one hint per 7 days, and the global cap is 5 hints per day by default (both configurable in **Settings > Vault**).

**Stage 3 (weekly external check).** An opt-in background job walks the clusters with notes due for a recheck (recheck intervals depend on how volatile a cluster is), runs a semantic pre-filter (a yes / no / unsure LLM call), and for "yes" clusters performs a light web search before generating findings. The job respects a weekly USD budget (default 2.00 USD, editable in settings), notifies you at 80% spend, and stops at the hard cap. Besides the weekly schedule you can start the same run on demand: the "Run freshness check now" button in **Settings > Vault** uses the same pipeline including the budget cap. Both paths refuse to run while external sources are disabled.

The `vault_health_check` tool is the user-triggered version of the same pipeline: it runs the structural checks on demand and returns a Markdown report.

## What you see

Findings land in the Vault Health Repair modal, grouped by severity. Each finding has up to three actions:

- **Repair** for the handful of checks the modal can fix mechanically: missing backlinks, category mismatches, inconsistent tags.
- **Discuss** to open a fresh chat scoped to that single finding.
- **Dismiss** to mark the finding as accepted by design.

A colored badge in the sidebar reflects the worst-severity finding. The badge is the primary entry point to the modal.

## Tunables

In **Settings > Vault**:

- **Enable external sources** is the master switch for any web traffic from the freshness system. Both Stage 3 paths refuse to run while it is off.
- **Weekly automatic check** turns the Stage 3 job on or off (default off). The run covers the whole vault, driven by note age; **Never-check clusters** and **Exclude paths** opt clusters and folders out, and the **Freshness scan scope** block previews what the next run would cover.
- **Run freshness check now** starts a one-off Stage 3 run with the same pipeline and budget.
- **Weekly budget (USD)** caps the cost of external checks per week (default 2.00).
- **Enable activity hint** turns the Stage 2 nudges on or off (default off).
- **Freshness score threshold** sets the cluster score below which a hint may fire (default 70).
- **Minimum days since last external check**, **Cooldown per cluster (days)** (default 7), and **Max hints per day (global)** (default 5) shape the Stage 2 rate-limiter.

The god-node connection threshold (default 50) is currently a code constant. ADR-106 and ADR-105 cover the design rationale.

## Limits

- Stage 2 and 3 use LLM calls. If the API fails, the cluster is skipped without retry.
- Only three check types have mechanical repair. Broken links and god nodes need your judgement.
- The daily hint cap is global, so a noisy cluster can swallow the day's budget and block hints elsewhere.
- Freshness is computed at indexing time. Real-time edits to linked notes do not reflect until the next index pass.

See also: [Knowledge layer](./knowledge-layer.md), [Vault health guide](/guides/vault-health), [Tools reference](/reference/tools#vault-tools).
