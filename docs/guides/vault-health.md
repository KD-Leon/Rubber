---
title: Vault health check
description: Diagnose and repair structural problems in your vault, from orphans and broken links to category mismatches and overloaded hub notes.
---

# Vault health check

Any vault you keep for more than a few months accumulates rough edges. You rename a note and the wikilinks pointing at the old name quietly break. A Map of Content links outward but never gets linked back. One person writes `#meeting` everywhere while another part of the vault has drifted to `#meetings`. A topic note that started as a clean hub is now carrying eighty backlinks and has turned into a dumping ground.

The vault health check finds these problems and helps you fix them.

## The health badge

The badge is a stethoscope icon among the action icons on the right side of the sidebar header, just left of the settings button. It stays hidden until a scan finds something. Once findings exist the icon appears and takes its colour from the highest severity in the result: low is the neutral accent, medium goes orange, high goes red.

Click the icon to open the repair modal. To trigger a scan, use the sidebar ellipsis menu or just ask the agent:

> "Run a health check on my vault."

Under the hood the agent calls the `vault_health_check` tool. The check runs entirely in code against the knowledge database, so no LLM tokens are spent on the scan itself.

## What the check looks for

Each check is a SQL query against the knowledge graph. Together they cover the ways a vault typically drifts out of shape.

| Check | What it finds | Why it matters |
|-------|---------------|----------------|
| Orphaned notes | Notes with zero incoming wikilinks | Nothing points at them, so they're invisible to backlink navigation and rank poorly in retrieval |
| Missing backlinks | A note links out but the target doesn't link back | One-directional links make the graph less useful as a navigation layer |
| Broken links | Wikilinks pointing to notes that no longer exist | Usually the result of a rename or delete that Obsidian couldn't rewrite cleanly |
| Weak clusters | Notes that are semantically very close but unlinked | These are connections you likely meant to make but didn't, and now the agent can surface them for you |
| Inconsistent tags | Spelling variants of the same tag, like `#meeting` and `#meetings` | Fragmented tags fragment search and MOC coverage |
| Category mismatches | A note's category property disagrees with the topic cluster it actually belongs to | Either the note is miscategorized or your ontology needs updating |
| God nodes | Hub notes with far more connections than they can usefully organize | A hub with eighty backlinks has become a bottleneck |
| Stale clusters | Topic clusters whose freshness score has dropped below the threshold | Old clusters quietly drift out of date, and the score shows where a refresh pays off |
| Source concentration | Clusters that draw most of their notes from a single source domain | A one-source cluster inherits that source's blind spots |

Weak clusters, category mismatches, and the two cluster-level checks (stale clusters, source concentration) need the [semantic index](/guides/knowledge-discovery) to be built. Without the index the check still runs, it just returns fewer findings.

## The repair modal

Click the health badge and the repair modal opens. Findings are grouped by check type, each with a severity marker and a short description of what's wrong and where.

Each finding has an action bar with three options.

**Repair** is the right choice for mechanical fixes: adding a missing backlink, pruning an orphaned edge, correcting a category. The service applies the change and creates a checkpoint first, so you always have an undo. Nothing gets lost.

**Discuss** is for findings that need judgment. A god-node needs a decision about how to split it. A weak cluster might or might not be a real connection that belongs in the graph. Click discuss and Vault Operator opens a new agent chat pre-loaded with the context of that specific finding. The agent walks you through what it is and where it lives, then suggests a concrete fix that you can accept, tweak, or reject.

**Dismiss** is for findings that aren't actually problems. A broken link might point at a note you deliberately deleted. A note might be meant to stay orphaned because it's a private draft you don't want indexed anywhere. Click the eye-off button and the finding is filtered out of future scans. It's not deleted, just hidden.

### Dismissed findings

The modal footer shows a count of everything you've dismissed. Click it to open a searchable list. From there you can restore a single finding, or restore all of them if you've changed your mind. Restored findings reappear right away without a reload.

## When to run it

The scan runs once automatically when the vault opens; beyond that there is no schedule. It is cheap enough that you could run it after every session, but in practice most users only run it when something prompts them: after importing a batch of notes, after reorganizing folders, when search results start feeling patchy, or as occasional housekeeping every few weeks.

Once you've done a few of these, a session settles into a rhythm. Open the modal, deal with the red (high-severity) items first. Batch-repair the obvious mechanical stuff. Use discuss on the few findings that actually need you to think. Dismiss the ones that were fine all along. Come back another day if there's still orange left over.

## Configuration

The health check reads a few vault conventions from [Settings > Vault Operator > Providers > Embeddings](/reference/settings#knowledge-properties) so it can validate category and summary properties correctly. Set those once and the check uses them for every scan. The god-node threshold is currently fixed at fifty connections.

The stale-cluster check has an optional companion: an external freshness verification that checks aging notes against the web on a weekly schedule or on demand. It is off by default and lives under **Settings > Vault**. The [vault health concept page](/concepts/vault-health) describes how it works.

For mechanical, low-risk repairs (like reformatting a malformed wikilink), you can let the agent apply them without asking. Toggle "Vault health auto-fix" under [Settings > Vault Operator > Vault > Vault](/reference/settings#vault). Anything ambiguous still goes through Discuss.

## Related

- [Knowledge ingest](/guides/knowledge-ingest) is the other half of the same story: prevent findings by adding notes cleanly in the first place.
- [Knowledge discovery](/guides/knowledge-discovery) explains the graph and semantic index that the checks run against.
- [Safety and control](/guides/safety-control) covers the checkpoint system that backs every repair.
