---
title: Languages
description: Which languages Vault Operator's interface supports, how the language is chosen, and how to install a language pack.
---

# Languages

Vault Operator's interface (settings, dialogs, chat panel, buttons, notices) is available in nine languages. English is built in; the other eight are one-time downloads called language packs.

## Supported languages

| Language | Obsidian code | Delivery |
| --- | --- | --- |
| English | `en` | Built in |
| German | `de` | Language pack |
| Chinese (Simplified) | `zh` | Language pack |
| Chinese (Traditional) | `zh-TW` | Language pack |
| Japanese | `ja` | Language pack |
| Korean | `ko` | Language pack |
| Spanish | `es` | Language pack |
| French | `fr` | Language pack |
| Russian | `ru` | Language pack |

## How the language is chosen

Vault Operator follows the Obsidian app language. Set it under **Settings > General > Language**. There is no separate language setting inside the plugin: whatever Obsidian is set to is what the plugin uses.

If Obsidian runs in a language Vault Operator does not ship (for example Portuguese or Thai), the interface stays in English. Regional variants fall back to their base language where one exists, so `de-AT` uses the German pack and `zh-HK` uses Simplified Chinese, while `zh-TW` is treated as its own language.

The language of the interface is independent from the language you chat in. You can write to the agent in any language regardless of the interface setting.

## Installing a language pack

English needs no download. When Obsidian runs in one of the other eight languages:

1. On start, if the pack is not yet installed, a notice offers the download. Click it once. The pack (about 0.2 to 0.3 MB) is fetched, its checksum is verified, and it is stored in your vault under `.vault-operator/assets/`.
2. Reload the plugin or restart Obsidian. The interface now renders in your language.

You can also install or remove a pack any time under **Settings > Vault Operator > Advanced > Optional assets**. The pack block appears there only when Obsidian runs in a non-English language.

The download never happens automatically. Nothing leaves your machine without the explicit click, in line with Obsidian's developer policy.

## Why packs instead of a single download

Bundling all nine languages into the plugin would push its main file past the 5 MB threshold that Obsidian Sync uses to decide what to sync. Shipping English inline and the rest on demand keeps the plugin small for everyone and only spends bandwidth on the language you actually use.

## Reporting a translation problem

The translations are machine-generated and reviewed for consistency, not yet by native speakers for every string. If a label reads wrong or an interface element overflows in your language, open an issue on GitHub with the English key or a screenshot. English is always the fallback, so any untranslated or removed string still shows readable text.
