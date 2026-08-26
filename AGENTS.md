# Vault Operator, Projekt-Regeln

> Runtime-neutrale Regeln für dieses Repo. Gilt für jeden Coding-Agenten.
> Die übergreifende Arbeitsweise steht in `~/.claude/AGENTS.md`,
> Claude-Code-Spezifisches in `CLAUDE.md`.

---

## Navigation, zuerst lesen

`_devprocess/SYSTEM-MAP.md` beantwortet, wo die Antwort steht. Sie ist der
Einstieg vor arc42 und vor jeder Code-Suche. Der Wegweiser mit einer Zeile
pro Konzept ist `src/ARCHITECTURE.map`, der Router über die
Architektur-Entscheidungen `_devprocess/architecture/README.md`.

Zahlen (Tool-Anzahl, Testdateien, Imports) stehen nur in der SYSTEM-MAP und
driften. Im Zweifel nachzählen, nicht aus einer Doku übernehmen.

## Projekt

Kilo Code Clone als Obsidian Plugin. AI-gesteuerter Agent für
Vault-Management, Semantic Search, Canvas-Generierung und
Multi-Agent-Orchestrierung.

Vault Operator ist für Sebastian auch ein Lernprojekt. Bei Architektur- und
Design-Entscheidungen das Problem und die Lösung so erklären, dass sie für
einen technisch interessierten Nicht-Entwickler nachvollziehbar sind: mit
Analogien, aber die zugrundeliegenden Konzepte trotzdem beim richtigen Namen
nennen.

## Tech Stack

- **Sprache:** TypeScript (strict)
- **Framework:** Obsidian Plugin API
- **Build:** esbuild mit Deploy-Plugin
- **Runtime:** Electron (via Obsidian)
- **AI APIs:** Anthropic SDK, OpenAI SDK

Versionen stehen in `package.json` und `manifest.json`, nicht hier.

## Build und Deploy

```bash
npm run build              # Build
npm run dev                # Watch-Mode mit Auto-Deploy
npm run deploy             # Nur Deploy (ohne Build)
```

Deploy-Ziel kommt aus `PLUGIN_DIR` in `.env`, aktuell der lokale Vault
`~/Obsidian/Nexus/.obsidian/plugins/vault-operator/`.

Build und Deploy nach jedem Implementierungsschritt, nicht erst am Ende.

## Verifikation

`npm run build`, `npm run test`, `npm run typecheck`, `npm run lint`. Vor
jedem Push ins Public-Repo zusätzlich der Review-Bot-Check.

## Referenz-Implementierung

`forked-kilocode/` enthält die originale Kilo Code Codebase. Vor jeder neuen
Feature-Implementierung dort das Pattern prüfen.

## Review-Bot-Regeln (verbindlich)

Diese Regeln müssen eingehalten werden, sonst lehnt der Obsidian Community
Plugin Review-Bot das Plugin ab:

| Verboten | Ersatz |
|----------|--------|
| `console.log()` / `console.info()` | `console.debug()`, `.warn()`, `.error()` |
| `fetch()` | `requestUrl` aus obsidian (oder SDK-Clients) |
| `require()` | ES `import` (Ausnahme: `require('electron')` in SafeStorageService) |
| Hardcoded `.obsidian` | `vault.configDir` |
| `element.style.X = Y` | CSS-Klassen (`.agent-u-*`) oder `style.setProperty()` |
| `innerHTML` | Obsidian DOM API (`createEl`, `createDiv`, `appendText`) |
| `any` Types | `unknown` plus Type Guards, oder `obsidian-augments.d.ts` |
| Floating Promises | `void` Prefix oder `.catch()` |
| `as TFile` / `as TFolder` | `instanceof` Checks |
| `Vault.delete()` / `Vault.trash()` | `FileManager.trashFile()` |

Vollständige Referenz mit den Bot-Tiers und den bekannten
Falsch-Positiven: `memory/review-bot-compliance.md`.

## Neues Tool verkabeln

Ein Tool ist erst fertig, wenn alle vier Punkte sitzen. Ein vergessener
Punkt fällt nicht im Build auf, sondern erst zur Laufzeit:

1. Datei unter `src/core/tools/<gruppe>/` anlegen, ein File pro Tool.
2. In `src/core/tools/ToolRegistry.ts` registrieren.
3. In `TOOL_GROUP_MAP` (`src/core/modes/builtinModes.ts`) eintragen, sonst
   ist das Tool in keinem Mode sichtbar.
4. Metadata in `src/core/tools/toolMetadata.ts` ergänzen.

Dazu gehören Contract-Tests, der Pfad-Eingabe-Guard und i18n-Parität über
`src/i18n/locales/en.ts` plus die Sprachpakete unter `locales/packs/`.

## Architektur-Eckdaten

- **AgentTask:** api, toolRegistry, callbacks, modeService,
  consecutiveMistakeLimit, rateLimitMs, condensingEnabled,
  condensingThreshold, powerSteeringFrequency
- **ToolExecutionContext:** spawnSubtask, switchMode, signalCompletion,
  askQuestion, updateTodos, onApprovalRequired
- **SemanticIndexService:** vectra LocalIndex
- **Vault Tool Groups:** read, vault, edit

## Verzeichnisse

```
src/core/           Agent-Loop, Tools, Pipeline, Kontext, Memory
src/api/            Provider-Adapter und Resilienz-Schicht
src/mcp/            VO als MCP-Server plus ausgehende Connectors
src/ui/             Sidebar, Settings, Modals
_devprocess/        Internes Wissensarchiv (nicht public)
forked-kilocode/    Referenz-Implementierung
```

<!-- DIA-WORKFLOW-START (managed by digital-innovation-agents) -->
## Digital Innovation Agents Workflow

This project uses the DIA V-Model workflow for AI-augmented innovation
and development.

- Mode: `github-sync`
- Profile: `full`
- Settings: `.dia/config.toml`
- Bootstrap skill: `skills/dia-bootstrap/SKILL.md`

For non-trivial work, `/dia-guide` (explicit command) gives an
orientation read. Phase skills (`/business-analysis`,
`/requirements-engineering`, `/architecture`, `/coding`, `/testing`,
`/security-audit`) are autonomous and own their handoffs; phase
transitions live in DIA commit trailers.

In the `lean` profile, only durable decisions and stable navigation
are binding: rules live in AGENTS.md (this file stays a pointer),
navigation in `_devprocess/SYSTEM-MAP.md`, decisions as post-hoc ADRs
behind `decisions/README.md`, status in GitHub Issues or a thin
BACKLOG. Do not document what code, tests, git, PRs, or issues
already carry.

Hotfix lane: small bug fixes (max 3 files, no breaking change, fits
an existing FEAT, under 15 minutes) may bypass the full cycle as
long as a FIX row in `BACKLOG.md` and a GitHub issue are created
afterwards.

To change mode or profile, or remove this anchor, run `/dia-setup`.
<!-- DIA-WORKFLOW-END -->
