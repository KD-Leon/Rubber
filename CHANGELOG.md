# Changelog

All notable changes to Vault Operator are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---


## [Unreleased]

## [0.0.2] - 2026-08-27

### Cloud storage (S3-compatible) / 云存储（S3 兼容）

- EN: Paste or drag images, audio and video into a note and they upload to your own S3-compatible storage automatically, inserting a public URL. Media is auto-categorized into `images/`, `audio/`, `video/` and `files/` under `obsidian/media/`.
- EN: Full-vault two-way sync under the `vault/` prefix, triggered 5 s after your last change. A tombstone mechanism propagates renames and deletions to the cloud, so stale duplicates no longer pile up. The sync notice reports upload / download / delete / skip counts.
- EN: Simplified setup with provider presets and a connection test, plus fixed Tencent Cloud COS SigV4 signing (x-amz-date / x-amz-content-sha256, real payload hash).
- 中文：粘贴或拖拽图片、音频、视频进笔记即自动上传到自己的 S3 兼容存储，并插入公开链接；媒体按类型自动归档到 `obsidian/media/` 下的 `images/`、`audio/`、`video/`、`files/`。
- 中文：全库双向同步（`vault/` 前缀），改动停止 5 秒后自动触发；引入墓碑机制，重命名与删除会同步到云端，不再残留重复文件；同步通知显示上传/下载/删除/跳过计数。
- 中文：配置简化——服务商预设 + 最少字段 + 连接测试；修复腾讯云 COS 的 SigV4 签名（x-amz-date / x-amz-content-sha256、真实负载哈希）。

### Settings & UX / 设置页与交互

- EN: Settings rebuilt into five groups — Models, Agents, Capabilities, Connections, General. Approval-mode quick switcher added to the chat toolbar (strict / balanced / auto).
- EN: Only Chinese (zh / zh-TW) and English locale packs are loaded now.
- 中文：设置页信息架构重构为五组——模型、智能体、能力、连接、通用；输入框工具栏新增批准模式快捷切换（严格 / 平衡 / 自动）。
- 中文：语言包仅加载中文（zh / zh-TW）与英文。

### AI assistant / AI 助手

- EN: Prompt caching for Anthropic and OpenAI/DeepSeek with a visible cache-hit indicator; full-text search across session history (title + body matches with snippets).
- 中文：Anthropic 与 OpenAI/DeepSeek 的 prompt 缓存，并显示缓存命中指示；历史会话支持全文搜索（标题 + 正文匹配，附片段预览）。

### Branding & release / 品牌与发布

- EN: Renamed the product to Rubber Duck (assistant: Rubber). Plugin id `vault-operator` is unchanged, so existing installs keep working. The release pipeline now builds and publishes automatically when a semver tag is pushed.
- 中文：产品更名为 Rubber Duck（橡皮鸭），AI 助手名为 Rubber（橡皮鸭）；插件 ID 保持 `vault-operator` 不变，不影响已有安装。推送语义化版本 tag 后自动打包发布。

## [3.6.1] - 2026-08-16

### Fixed

- **3.6.0 is offered as an update again.** Alongside the manifest, the plugin
  ships a `versions.json` that maps each released version to the Obsidian
  version it needs, and Obsidian reads it to decide which version an
  installation may install. The 3.6.0 release bumped the manifest but left that
  file, and `package.json`, at 3.5.1. Everything 3.6.0 carries was therefore
  published without being announced properly: the embedding failures that were
  reported as silent, the re-indexing that ran more often than it should, the
  vault data that did not travel with a vault used on several devices, and the
  Edit entry on skills that failed to open a folder. If you are reading this in
  3.6.0, nothing is wrong with your installation.

  Nothing else changed. There is no behaviour difference between 3.6.0 and
  3.6.1, and no reason to reinstall if you already run 3.6.0.

### Internal

- The five places that carry the version (manifest, `package.json`, the
  lockfile, `versions.json`, the docs landing page) are now checked against each
  other by a test, so a release that moves only some of them fails at commit
  time instead of at install time.

## [3.6.0] - 2026-08-14

### Added

- **Chat linking can now skip folders.** Chat linking stamps a reference into
  the frontmatter of every note the agent writes, which is unhelpful for notes
  whose frontmatter means something to another plugin: a Templater template
  passes the stray reference on to every note created from it. There is now an
  exclusion list under Interface settings that takes a folder path or a
  `/regex/` entry. Excluded notes stay fully editable, they are simply left
  unstamped. The default is empty, so nothing changes unless you set it.
- **Existing installations are told when their data lives outside the vault.**
  Older installations keep settings, workflows, memory and chat history in a
  folder next to the vault rather than inside it, which means none of it
  travels when the vault is synced or copied. That was only discoverable by
  finding a settings section nobody knew to look for. A one-time prompt now
  explains the consequence and offers the move; declining is remembered, and
  the decision is per vault.

### Fixed

- **LM Studio answers again.** Every chat request went to an endpoint LM Studio
  does not serve, so it replied with an empty success and the chat stayed
  silent with no error anywhere. The address is now completed the same way the
  model list and the embedding path already completed it. If you added `/v1`
  yourself as a workaround, that keeps working.
- **Skills written on Windows load.** A skill file with Windows line endings
  was rejected as having no frontmatter, while its frontmatter was plainly
  there. This also affected skills imported from a ZIP packed on Windows and
  repositories cloned with automatic line-ending conversion. Files now keep
  their own line endings when the agent edits them, and a leading byte-order
  mark is accepted too.
- **The reranker install button can be found.** The console pointed at a
  settings tab that does not exist, and the button was named so that searching
  for the term from the message found nothing. Both are corrected, and the
  documentation no longer contradicts itself about the download size.
- **Picking a slash command no longer breaks it.** Selecting an entry from the
  slash menu dropped the separator, so whatever you typed next fused into the
  command and the workflow ran as plain text without saying so. The menu also
  stayed open and swallowed Enter, which meant you could not send. Both are
  fixed, and Shift+Enter is a newline again.
- **Editing a skill opens its folder.** The menu entry rebuilt the path from an
  assumption that only holds after the storage consolidation has run, so on
  older installations it pointed at a folder that does not exist. It now asks
  the component that owns the skill where the skill actually is. iCloud paths
  were never the problem, though syncing a vault across two machines is a
  common way to end up in the affected state.
- **A broken embedding provider now says so.** Embeddings against gateways that
  do not send permissive CORS headers failed because the indexing path did not
  use the same network transport the chat path uses. Worse, every failure was
  counted per file and the build then reported success, so a completely
  unreachable provider looked like "all files skipped". The build now stops and
  names the cause, and the connection test reports its own failures instead of
  hanging.
- **Editing a note no longer re-embeds it.** The incremental index update had
  no content check, so saving a note re-sent it to the embedding model even
  when nothing relevant had changed. With a local model that kept the
  inference server resident in video memory. It also wrote back an empty
  content hash, which disabled the same check in the full index build, so notes
  were re-embedded and re-enriched there as well.
- **The Kilo Gateway works.** Requests were sent through the browser network
  stack, where they were blocked before leaving the machine; sign-in worked
  because it uses a different path, which made this look like an outage on
  their side. It now uses the same transport four other providers already use.
- **Settings can no longer be lost on an interrupted write.** Settings were
  written by truncating the file and refilling it, so a crash, a quit or two
  overlapping saves could leave an empty or half-written file behind. Writes
  are atomic now: a reader sees either the old file or the new one, and a
  failed write leaves the previous one intact. This applies to the knowledge
  database too.
- **The storage consolidation moves the data it was supposed to move.** It only
  ever looked in a folder under the name the project carried before it was
  renamed, so for most installations it moved nothing, reported success, and
  then pointed at an empty location. Files were never deleted, but the plugin
  stopped seeing them. It now covers both folder names, prefers the newer one
  when both exist, and backs up both before touching anything.

- **A clipped image is now identified by its own bytes.** The format used to
  come from the `Content-Type` the remote server sent, so a page could declare
  `image/png` and hand over something else entirely, which then sat in the
  vault under a `.png` name. The header now only decides whether a response
  claims to be an image at all; the bytes decide what it is, an image that
  arrives mislabelled is saved under the right extension, and bytes that match
  no format we accept are rejected instead of stored.
- **WEBP and AVIF images no longer break a generated presentation.** Both were
  embedded while being declared as PNG, so the slide carried a picture no
  reader could decode. They are declared correctly now, and a format the deck
  cannot carry shows a visible placeholder instead of a silently broken image.

### Security

- **The inline chat no longer loads remote resources from untrusted content.**
  Everything rendered into a chat is untrusted: model output, note content
  pulled in by tools, fetched web pages. Image syntax in that content turns
  into a request the moment it is rendered, with no click and no approval. The
  sidebar has neutralised this since July; the inline chat, added afterwards,
  did not. A prepared note or a fetched snippet could therefore reach an
  attacker-chosen address with vault content attached. Both render paths are
  now covered, and a test fails the build if a third one ever bypasses it.
- **A stylesheet reference can no longer do the same thing.** The protection
  above covered image syntax and resource tags, but not a CSS `url()` in a
  style attribute, whose carrier is an ordinary element that no tag list
  catches. Remote references there are neutralised as well; local and embedded
  ones are untouched.

### Internal

- A safeguard added earlier in this cycle, meant to stop an index build once a
  provider fails repeatedly, never actually triggered: its counter was reset on
  every pass. The accompanying test only checked that the code was present, not
  that it worked. Both are corrected, and the test now exercises the behaviour.
- `pptxgenjs` is declared as a build-time dependency, which is what it has
  always been: it is excluded from the plugin bundle and compiled only into the
  optional office asset. The runtime dependency tree is now free of it and of
  the unpatched `image-size` advisory it carries, so the dependency audit gate
  passes again. The library itself is unchanged and still ships inside the
  office asset; both bundles build byte for byte identically.

## [3.4.0] -- 2026-08-11

### Added

- **The sidebar has its own design layer.** The chat panel now carries a brand
  mark and wordmark in its header, a plan panel that draws its steps along a
  timeline, tool steps threaded on a single line instead of stacked boxes, a
  composer that reads as a floating card, and one status line per turn that
  shows the current activity together with a live token count. Your theme's
  accent colour is still the accent everywhere it matters, so community themes
  keep working; only the brand mark carries fixed colours, the way an app icon
  does.
- **Obsidian's "Excluded files" list is honoured as a hard boundary.** With
  "Respect Obsidian excluded files" on (the default), anything you excluded in
  Obsidian's own settings is invisible to the agent: not listed, not searched,
  not read, not written, and skipped when the semantic index is built.
  `.obsidian-agentignore` remains the authoritative list for paths that must
  never be touched.

### Fixed

- **Reloading Obsidian no longer opens a browser sign-in page on its own.** A
  stale MCP OAuth token made the automatic reconnect escalate to a full
  authorization and open the provider's login without anyone asking for it.
  Authorization now happens only after an explicit action; an automatic
  reconnect that cannot refresh silently just reports that it is waiting for
  you.
- **The completion result no longer runs into the preceding sentence.** A
  finished task's summary was appended to the streamed narration without a
  break, producing text like "...von Wesel.Der Bürgermeister...".
- **The token and cost footer survives a reload.** It was built only while a
  message streamed, so reopening a conversation from history showed the answer
  without its usage line. Conversations from before this fix stay without a
  footer, because the numbers were never recorded.

### Documentation

- The website mirrors the new design: brand mark, wordmark, favicon, social
  preview image, and a landing demo that shows the redesigned sidebar.
- Content brought up to the current feature set: the web clipper, the connector
  catalog, the unified slash menu, the excluded-files boundary, a corrected
  settings reference, and vault health checks that match the code. Tutorials no
  longer teach slash commands that stopped shipping with 3.3.3; the same flows
  are shown as plain requests to the agent.

## [3.3.6] -- 2026-07-31

### Added

- **Clip a web page into your vault.** `clip_web_page` saves an article as a
  Markdown note and downloads its images into the vault, rewriting the links to
  the local copies. Page and images pass the same address checks as any other
  web request, images are capped in count and size, and an existing note is
  never overwritten.

### Fixed

- Timers in the web tools use the window-scoped variants so they keep working
  in popped-out windows.

## [3.3.5] -- 2026-07-31

### Internal

- Element creation uses the `createDiv` / `createSpan` shorthands required by
  the newer review-bot lint rules. No behaviour change.

## [3.3.4] -- 2026-07-31

### Fixed

- **Approving a sandbox script no longer approves a different one.** A granted
  approval is now bound to the hash of the script's bytes, so an edited script
  asks again instead of inheriting the old grant. A tampered sandbox verdict no
  longer produces a per-script grant at all.

### Internal

- Element creation moved to the `createEl` helpers throughout the UI, and the
  performance-budget job builds before it tests so the generated modules exist.

## [3.3.3] -- 2026-07-30

### Changed

- **Pro skills are no longer bundled with the plugin.** The eleven Pro workflow
  skills (ingest, ingest-deep, knowledge-ingest, knowledge-batch-ingest,
  knowledge-rename, meeting-summary, office-workflow, presentation-design,
  humanizer, skill-creator-pro, skill-translator) move to a separate catalog and
  will be delivered through the marketplace on demand. Copies you already
  installed keep working and are not removed. The four built-in skills stay:
  sandbox-environment, vault-operator-guide, skill-creator, and
  vault-health-batch. This also brings the plugin bundle back under the 5 MB
  sync limit.

### Documentation

- Rewrote the documentation site for the 3.3.x line into a single source of
  truth, and fixed dead redirects, stale version pins, and Chinese README
  parity.

### Internal

- Review-bot compliance pass over the shipped code, with no behaviour change:
  removed redundant type assertions and unused imports, routed the deprecated
  `activeMcpServers` / `mcpDisabled` migration read through a non-deprecated
  path, typed the generated-asset and `process` / `crypto` global accesses, and
  reduced a partially supported CSS `text-decoration` to its supported form.

### MCP remote relay: redeploy after updating

If you use the remote MCP relay, the Cloudflare worker is bundled inside the
plugin and does not update itself. After a plugin update that changes the
worker, you have to press **Redeploy** in Settings > Vault Operator >
Customize > Connectors for the new worker code to go live on your account. Opening the connector URL in a browser only
proves the worker is deployed, not that it runs the current code. This was the
root of the confusing retest in issue #53, where a redeploy before the fixed
build was published pushed the old worker again and reported success.

### Removed

- **`relay/` directory** -- an older standalone WebSocket-based worker with its
  own `wrangler deploy` instructions. It predates the current HTTP long-polling
  design and the plugin cannot talk to it, so following its README produced a
  relay that never connects. The worker the plugin actually deploys lives in
  `src/mcp/relayWorkerCode.ts` and is untouched.


## [3.3.2] -- 2026-07-30

### Parallel chat sessions, history-loss repair, security hardening

EPIC-55 lands: multiple chats now live side by side as tabs. Alongside it, a
drain-owner fix closes a history-loss path, and three full-codebase audits are
remediated.

### Added

- **Parallel chat sessions (EPIC-55).** Chats open as tabs in the main area
  with an in-view tab strip in the sidebar. Background runs stream into their
  own tab, and attachments plus the active mode are scoped per tab. A restart
  reopens a single fresh chat, with earlier chats reachable from history and an
  interrupted run resumable in its own conversation. Adds cross-session topic
  awareness and a per-model circuit breaker with a budget-wait indicator.
- **Native `build_meeting_note_from_sink` and `compute_plaud_delta` tools.**
  Plaud imports dedupe by id at the write point (no more duplicates) and render
  timestamps in local time.

### Changed

- **Chat tabs name themselves from the first message** at send time. A fresh
  tab reads "New chat" until then, and the title sharpens over the opening
  messages.
- **Block anchors are scoped to a single section** (`within_section`) so a
  meeting-summary anchor no longer bleeds across the note.

### Fixed

- **History-loss repair (FIX-03-20-02).** A drain-owner gate stops a running
  chat from dropping its own message history, with six follow-up fixes (F1-F6)
  and a `deleteAll` tombstone so a cleared history stays cleared after reload.
- The history index now recovers from disk, and a restart opens a fresh chat
  instead of a stale one.
- Skill reload is atomic, scans in parallel, and gives button feedback.
- Stop now aborts a running sandbox script (FIX-24-08-04).

### Security

- Three full-codebase audits (2026-07-26, 2026-07-27, 2026-07-29) remediated:
  `execute_command` runs only allowlisted commands, path governance covers
  `execute_recipe`, the meeting-sink writer and `extract_zip`, MCP credentials
  stay scoped to where they were granted, the deny zone stays out of tool
  enumerations, skill scripts run against their bytes rather than their name,
  the dormant `vm` sandbox is removed, and one settings surface now shows and
  revokes every granted permission (M-5 / M-18). `inspect_self` no longer leaks
  OAuth tokens.


## [3.3.1] -- 2026-07-24

### Sandbox and compliance hardening

Follow-up to 3.3.0 with no new features.

### Fixed

- **Skill-script sandbox recycles its iframe between calls** so repeated
  skill-script runs no longer grow the renderer heap without bound.
- Hardened the pro-skills leak guard and switched onboarding to store-based
  install text.

### Security

- Cleared two CodeQL escaping alerts and a blocking review-bot sentence-case
  finding.


## [3.3.0] -- 2026-07-24

### Native stdio MCP, connector discovery, Vault Health redesign

The MCP surface grows a local transport and a discovery flow, and the vault
health / hub-backlink system is rebuilt around the edge graph.

### Added

- **Native stdio MCP client (FEAT-04-13, ADR-168).** Connect to local MCP
  servers over stdio, next to the existing remote HTTP connectors.
  `use_mcp_tool` gains a `sink_to_path` option that writes a large result to a
  file instead of flooding the chat.
- **MCP connector discovery (FEAT-04-10 / FEAT-04-11).** Browse and pin
  featured official servers from a registry, with guided token setup, encrypted
  header tokens, and trust / publisher labels. MCP activation is now per agent
  (FEAT-04-12).
- **Unified "/" menu (FEAT-02-13)** merges skills, prompts and workflows into
  one picker. Forced-workflow selection moves to a vault-local store with a
  chat-options popover (FEAT-02-12, ADR-160).
- **Self-forming hub backlinks and a rebuilt Vault Health flow (EPIC-19).**
  Notes grow an incoming-links table read from the edge graph, reciprocity is
  treated as a graph property rather than a frontmatter column, the knowledge
  review reconciles its own on-screen counts and adds freshness re-checks and
  weak-cluster batch repair, and a new "Update hubs" command runs independently
  of the health check. Hub notes get "Links" base views.
- **`write_skill` tool** to revise an existing skill by name; skill-creator-pro
  ported to the native runtime.
- **Provider switcher dropdown in the model picker** (IMP-26-05-01) and an
  `investigate` delegation tool for research-first planning (FEAT-24-10,
  ADR-159).
- Chat UX: Shift+Enter grows the composer, plus a per-message cost footer.

### Changed

- **Settings restructured (FEAT-30-07)** with editable custom recipes and
  freshness as an on-demand health subcheck.
- **Orphan repair replaced with an explicit linking flow** instead of silently
  moving notes (FIX-19-01-12).

### Fixed

- Context-overflow guardrail with three defence lines and a registry-driven
  context-window resolution chain (FIX-24-03-05 / FIX-26-02-02, ADR-157 /
  ADR-158).

### Security

- MCP-wave audit remediation (token-leak High plus defang and URL-scheme Lows),
  a security re-scan (one High plus three Lows), Dependabot alerts #73-#77, and
  subagent completions wrapped as untrusted content.


## [3.2.5] -- 2026-07-15

### Review-bot unblock

- Cleared the review-bot scan that blocked the 3.2.4 submission, including the
  popout-window compatibility warnings.
- CI installs the optional platform binaries (esbuild) so builds no longer
  break. No user-visible behaviour change.


## [3.2.4] -- 2026-07-14

### Approval governance + MCP write gate (breaking)

EPIC-44 reworks how the agent asks for permission, and the MCP memory tools
move behind the write toggle.

### Changed

- **MCP write gate (breaking change).** The memory tools `save_to_memory` and
  `update_memory` (deprecated) join `write_vault` in the MCP write tier and are
  disabled by default. External clients that saved memory before 3.2.4 (Claude
  Desktop, ChatGPT, Claude Code, Perplexity) get an error naming the setting
  until you enable **Allow write tools over MCP** under Settings > Vault
  Operator > Customize > Connectors. Reading memory (`recall_memory`) is
  unaffected.

### Added

- **Effect-based approval governance (EPIC-44).** A single batch approval gate
  with scope-preview cards, session-scope grants (allow until reload), a kill
  switch (default-deny reset plus paranoid mode), and revert modes so pre-task
  states restore.
- **Per-model reasoning-effort opt-in** with an effort slider in the chat model
  picker (IMP-54-05b).
- **Chat checkpoint markers persist and rehydrate live** across reloads; orphan
  checkpoints surface on reload (FIX-44-12).

### Fixed

- Dismissing the post-task review no longer reverts the run (FIX-44-38).
- ChatGPT OAuth gains the gpt-5.6 lineup and learns per-model reasoning-effort
  restrictions from the wire (FIX-54-10, FIX-55-03).
- The first-run wizard routes newly added models to the canonical
  `providerConfigs` store and guarantees the wizard model is reachable; freshly
  entered credentials overwrite stale ones on merge.

### Security

- Codex audit 2026-07-14 remediated (12 findings over three review rounds) plus
  skill-script safety hardening and the governance-asymmetry fix.


## [3.2.3] -- 2026-07-10

### Skill monetization + agent-loop levers

### Added

- **Skill monetization wave 1.** skill-creator splits into a free Lite tier and
  skill-creator-pro; premium skills move to a pro-skills tier with a trusted
  source flag.
- **Window-aware file reads, fuzzy block anchors and MOC lookup** in the agent
  loop, with a coalescing save path.

### Changed

- **Stop reliably halts a running task and offers Resume** with immediate
  feedback (FIX-24-08-03, IMP-24-08-04).
- Providers resolve their context window from the model registry instead of
  hardcoded caps (FIX-COMPACT-10); recipe matching only runs on analysis-intent
  tasks.
- Removed the Stigmergy integration entirely (FEAT-32-04).

### Fixed

- Meeting-summary slowness and dead block-references (plus OKF frontmatter and
  template-miss hardening).
- KnowledgeDB coalesces concurrent saves so tail writes survive a reload.
- `evaluate_expression` return payload capped at 16k characters.
- Issue #54 chat feedback: send shortcut, language, model persistence, and
  sub-agent models.


## [3.2.2] -- 2026-07-07

### Compliance

- Review-bot scan pass (46 findings across 23 files). No user-visible
  behaviour change.


## [3.2.1] -- 2026-07-07

### Localization + agent-loop hardening

EPIC-42 brings the UI to nine languages and EPIC-41 hardens the agent loop, on
top of a batch of community issue fixes.

### Added

- **Multi-language UI (EPIC-42).** Nine locales with English bundled and eight
  on-demand language packs; over 1000 UI strings localized.
- **Agent-loop hardening (EPIC-41).** Provider retry layer with error
  classification, per-provider circuit breaker, token-bucket rate limiting, a
  calibrated token estimator, task resume with a crash-recovery banner,
  hierarchical condensing, and single-slot background research tasks.
- Switch the active provider directly from the chat model picker (issue #48).
- Browser-triggered skill runs via the `obsidian://vault-operator-run` deeplink
  (FEAT-43-01).
- Deploy-free model metadata (ADR-148) and Claude Sonnet 5 in the model
  registry.

### Changed

- Reranker moved to an on-demand bundle so `main.js` drops under 5 MB, and
  language packs no longer auto-deploy to the vault.
- Incremental markdown rendering during Q&A streaming (issue #48), parallelized
  background semantic enrichment (issue #35), and one shared sql.js compile at
  boot (issue #32).

### Fixed

- **P0 data loss:** the post-task review zeroed dot-path files (FIX-01-07-04).
- `write_file` is now atomic with an empty-content guard against 0-byte data
  loss.
- Boot-race chat loss on startup (FIX-22-07-02 / FIX-03-20-01).
- German UI strings leaking for non-German users (FIX-42-01-02, issue #48).

### Security

- Resolved the 2026-07-05 audit (SBX-1 High plus four Medium) and the
  2026-07-07 delta audit.


## [3.2.0] -- 2026-07-02

### Startup and agent-loop performance + condensing robustness

A large performance pass across boot and the agent loop, plus a hardening round
on context condensing.

### Added

- **Frontmatter Operator over MCP (FEAT-14-07).** External clients can read and
  edit note frontmatter through the MCP surface, with input hardening.

### Changed

- **Startup and agent-loop performance pass.** Lazy-load the AWS SDK and
  isomorphic-git, split shell-ready from services-ready at boot, cache the
  tool-group map and skill discovery, render history lazily with per-group "Show
  more", and run semantic enrichment with bounded concurrency. The result is a
  faster first paint and a send button that shows a preparing state until
  services are ready.
- **Context condensing is more robust.** Failures surface instead of being
  swallowed, the retry loop keeps an adaptive tail, and the ledger records
  tool-aware result summaries with forensic telemetry.

### Fixed

- Double-toggle render in the model-config toggle pill.

### Security

- Audit sweep (AUDIT-038 plus AUDIT-039 hotfix) and wikilink shortest-path
  resolution.


## [3.1.1] -- 2026-06-24

### Inline chat polish round 3 + selection-pill scope-fix

Follow-up to v3.1.0 driven by user feedback on the inline chat surface
and the editor-selection pill. No new features; the existing flows are
sharper and more reliable.

### Added

- **Editor-menu: "Send selection to sidebar chat"** -- second item in
  the editor right-click menu (next to "Inline AI chat") that hands the
  current editor selection to the sidebar composer as a
  `<context>...</context>` block. Sidebar opens on demand if it was
  collapsed.
- **`Ctrl+ii` hotkey** (Ctrl held, `i` pressed twice within 280 ms)
  routes the editor selection directly to the sidebar chat without
  opening the inline panel first. Single `Ctrl+i` still opens the
  inline chat (220 ms defer window enables the double-press detection
  without visible delay at typing speed).
- `AgentSidebarView.prepopulateComposerWithContext({text, notePath})`
  public entry point used by both the editor-menu and the `Ctrl+ii`
  hotkey. Idempotent: re-invoking with the same args does not double-
  insert the context block.

### Fixed

- **Inline chat frame visibility.** Border bumped to `2 px solid
  var(--text-faint)` so the panel reads as a distinct enclosure
  against busy note backgrounds in both light and dark mode (earlier
  `--background-modifier-border-hover` was still too subtle). Block-
  widget variant also gets a stronger drop shadow.
- **Inline chat bottom corners now round.** The composer's square
  background was painting over the panel's rounded bottom corners
  because the panel needs `overflow: visible` (so the autocomplete
  dropdown can escape). Rounded the composer's bottom corners
  explicitly so the frame curve is continuous.
- **Inline chat close button (X) now sits in the top-right corner.**
  Previously `position: static` on the inline-block variant let the
  absolutely-positioned close button fall through to a far-away
  ancestor; the variant now uses `position: relative`.
- **Inline chat margin to surrounding note text.** Bumped from 0.75 em
  to 1.5 em above + below so the panel visually detaches from prose.
- **Composer text input is responsive again** and selection in
  response bubbles no longer collapses on mousedown. Earlier "let
  mouse events through CM6" tweak handed mousedown to CodeMirror,
  which moved its own cursor into the editor line behind the widget
  and stole focus from the composer. `WidgetType.ignoreEvent`
  reverted to unconditionally true; the copy-from-bubble fix is
  carried by the CSS `user-select: text` rule on
  `.agent-inline-panel__bubble *`.
- **Copy across multiple response paragraphs works.** Cause: `copy`
  and `cut` events bubbled to the surrounding CM6 EditorView and the
  CodeMirror clipboard handler serialised its own (often empty)
  selection instead of the DOM selection inside the widget. Fix:
  `stopPropagation` on `copy` / `cut` at the panel root in
  `InlineChatPanel.open()` -- the browser default (copy DOM selection
  to clipboard) is preserved, only the CM6 layer is decoupled.
- **Selection-affordance pill no longer appears in the sidebar chat
  bubbles.** New `isRangeInsideMarkdownView()` guard in
  `InlineActionPill.show()` suppresses the pill unless the selection's
  end container has an ancestor matching `.markdown-source-view`,
  `.markdown-reading-view`, `.markdown-preview-view`, or `.cm-editor`.
  Chat-in-chat made no sense; the pill is now exclusive to editor
  text.

### Internal

- `manifest.minAppVersion` aligned with main (`1.8.7`); the feature
  branch had drifted back to `1.13.0` and would have re-broken the
  v3.0.3 reachability fix on merge.
- `versions.json` brought current: added `3.0.3 -> 1.8.7`,
  `3.1.0 -> 1.8.7`, and the new `3.1.1 -> 1.8.7`.
- 7 new tests (HotkeyHint Ctrl+ii display + InlineActionPill
  outside-markdown-view guard); full suite stays green at 3517/3517.


## [3.1.0] -- 2026-06-24

### Inline chat polish + selection pill + security hardening

EPIC-33 follow-on: the inline chat panel grew several rounds of polish on
top of the v3.0 base, plus a full-codebase security audit (AUDIT-034) that
landed High-severity path-guard, allowlist, prompt-injection and credential-
redaction fixes alongside the new affordance.

### Added

- **Selection-affordance pill.** A small `wand-sparkles` icon in the
  accent colour appears at the top-right corner of the visually rightmost
  word of a finished selection. Click opens the inline chat without
  blocking native copy / format actions. Opt-in via Settings ->
  Inline editor AI actions -> "Show inline AI action icon on selection".
- **`Ctrl + i` opens the inline chat.** Registered on every platform
  (Control, not Cmd on Mac, per user spec).
- **Send-to-sidebar button** next to the composer Send button. Hands the
  live conversation off to the sidebar chat without the previous
  Memory-save / Memory-resume detour. Disabled while the agent is
  running so an in-flight stream cannot leak a partial conversation.
- **Inline chat display setting** ("Block widget in editor" default vs.
  "Floating popover" opt-in). Block widget is a real CM6 decoration that
  pushes following text down; popover keeps the legacy overlay surface
  and stays available in reading view.
- **Persistent selection highlight** while the inline chat is open so the
  user always sees which selection the chat is operating on (CM6
  decoration; survives focus changes).
- **Sidebar auto-open toggle** in Settings -> Interface so users who
  mostly work inline can keep the sidebar closed on startup; the
  ribbon, command palette and send-to-sidebar still open it on demand.
- **Sidebar `importConversation()`** entry point; sidebar busy-state
  exposed as `isBusy` for the transfer-service handshake.

### Fixed

- **AUDIT-034 H-1 / H-2 / M-1..M-3:** shared `assertSafeVaultPath` guard
  rejects path traversal across `writeBinaryToVault`, `MoveFileTool`,
  `DeleteFileTool`, `AppendToFileTool`, `CreateFolderTool` (NUL bytes,
  Unix / Windows / UNC absolute paths, segment-level `..` and `.`).
- **AUDIT-034 H-3:** runtime allowlist gate in `ToolExecutionPipeline`
  rejects model-driven calls to tools outside the subtask's
  `allowedTools`, in addition to the existing mode gate.
- **AUDIT-034 H-4:** MCP `use_mcp_tool` no longer treats an empty
  `activeMcpServers[]` as "allow all"; an empty list now denies.
- **AUDIT-034 H-6:** `ResolveConflictModal` no longer logs the full
  chat prompt (note path / verdict / URLs) to the renderer console;
  only the prompt length stays.
- **AUDIT-034 H-7:** vault-search results wrap matched lines in the
  `<vault-search>` untrusted-content boundary so the system-prompt
  SECURITY BOUNDARY clause covers them, not just `read_file` content.
- **AUDIT-034 H-8:** system-prompt memory section scrubs
  credential-shaped substrings (sk_, AKIA/ASIA, JWTs, named
  `api_key`/`token`/`secret`/`bearer`) before injecting persisted
  memory facts.
- **AUDIT-034 H-9:** `InspectSelfTool.SENSITIVE_KEY_REGEX` extended to
  catch `bearer`, `authorization`, `oauth`, `jwt`, `aws_*`, `azure_*`,
  `refresh_token`, `client_secret`, `gateway_header`, ...
- **AUDIT-034 M-4 / M-5:** `SandboxBridge` blocks reads (not just
  writes) from `configDir`, and rejects Windows drive-letter and UNC
  absolute paths.
- **AUDIT-034 M-22:** package-name validation regex tightened to npm
  shape rules + explicit `..` reject.
- **AUDIT-034 M-25 / M-26:** `testToolExecution` truncates dumps to
  200 chars; the active-model debug log no longer prints the model id.
- **AUDIT-034 M-29:** `obsidianFetch` SSRF guard normalises IPv6
  brackets once and uses only the cleaned hostname for the blocklist.
- **AUDIT-034 M-37:** subtask approval callback wrapped against
  parent-side throws; fails closed (rejected) instead of crashing.
- **AUDIT-034 M-40:** `InlineActionPill.closest()` walk constrained to
  markdown view / cm-editor roots so a stray selection in a settings
  modal cannot return a bogus line right edge.
- Inline-chat autocomplete dropdown (`@` mention picker) **portaled to
  the workspace root** so it escapes the CM6 block-widget clip and now
  shows the full 7-row sidebar-style list with scrollbar.
- Inline action pill **no longer steals focus** (`tabindex=-1`) and
  **hides on editor scroll** (capture-phase listener on the workspace
  container).
- Send-to-sidebar transfer **re-validates** `inlineRunning` AFTER the
  async `activateView()`; a steering message that started a new turn
  in the gap window cannot leak a stale snapshot.

### Removed

- `Ctrl + s` send-to-sidebar shortcut withdrawn after the textarea
  fallback proved unreliable; the composer button remains as the
  canonical trigger.
- `FEAT-33-10` per-action model pin (UI, type field `actionPins`,
  resolver entries, `PerActionPin` class, audit-test M-01) was never
  wired into the orchestrator. Spec marked WITHDRAWN.

### Deferred to backlog (AUDIT-034)

29 Medium-severity findings (CDN SRI, sandbox cache re-verify, plain
MCP schema validation, conversation-history-at-rest encryption, ...)
plus 26 Low/Info items are tracked as `SEC-034-*` rows under
Standalone Items in `_devprocess/context/BACKLOG.md`.


## [3.0.3] -- 2026-06-23

### Reachability fix -- restore install on Obsidian 1.8.7+

The 2.13.2 Plugin Reviewer Bot pass pinned `minAppVersion` to `1.13.0`,
which caused the in-app community plugin browser to silently fall back
to `2.13.1` for every user on Obsidian below 1.13. This release lowers
the floor back to `1.8.7` so the current build installs everywhere the
code actually supports.

- `manifest.minAppVersion` `1.13.0` -> `1.8.7`. The true API floor of
  the current codebase is `Notice.messageEl` (1.8.7); everything else
  in use sits at or below that line (`Workspace.revealLeaf` 1.7.2,
  `FileManager.trashFile` 1.6.6, `Vault.getAllFolders` 1.6.6,
  `Vault.getFileByPath` 1.5.7, `AbstractInputSuggest` 1.4.10,
  `processFrontMatter` 1.4.4, `setCssStyles` 1.4.0).
- `PromptModal.ts` confirm-button styling now prefers the 1.13 API
  `setDestructive()` when present and falls back to the legacy
  `setWarning()` on older Obsidian builds. Same visual result on both,
  no user-facing change.

No feature change. No data migration.

---


## [3.0.2] -- 2026-06-23

### Obsidian Community Plugin Review Bot pass

Clears the Tier-3 popout-window-compat warnings the bot raised against
the EPIC-33 inline modules, removes five dead imports the bot's
linter flagged, declares the codemirror + dompurify packages the bot
expects to see in `package.json`, and converts the three `!important`
blocks the EPIC-33 styles added.

- `setTimeout` / `clearTimeout` -> `window.setTimeout` / `window.clearTimeout`
  in `SelectionWatcher.ts` and `InlineWebLookup.ts` for popout-window
  compatibility. The Node-shadowed timer type is replaced with plain
  `number` so the DOM `window.setTimeout` return type matches.
- `document.createElement` -> `activeDocument.createElement` in
  `CodeMirrorDiffAdapter.ts` so the inline diff hunk-actions widget
  renders into the popped-out window's document when the editor lives
  in a separate window.
- `@codemirror/state`, `@codemirror/view`, `dompurify` added to
  `devDependencies` so the bot's "should be listed in dependencies"
  warning clears. The packages still come from Obsidian at runtime
  (esbuild externalises them) -- the dev declaration is a metadata
  fix only.
- Removed five unused imports / type aliases the bot's lint flagged:
  `AgentTask` in `AgentSidebarView.ts`, `DynamicToolFactory` in
  `DynamicToolLoader.ts`, `ObsidianAgentPlugin` in `ExtractZipTool.ts`,
  `_edgesPass1` destructure in `LookupAction.ts`, `_UnusedTr` /
  `Transaction` type-only import in `CodeMirrorDiffAdapter.ts`.
- CSS Pattern M (class repetition) replaces `!important` across the
  fifteen lines the bot flagged: the inline panel anchor-toggle and
  close-button frameless rules, and the edit-review modal
  width/height/min-width/max-width rules. The repeated class lifts
  specificity to (0,2,0) or (0,4,0) where needed, so the rules still
  win against Obsidian's default modal sizing.

No user-visible behaviour change.

---


## [3.0.1] -- 2026-06-23

### Security

Six Dependabot alerts on transitive dependencies cleared by bumping
the `overrides` block in `package.json`. Neither package is reachable
from the desktop-only plugin runtime (Hono's AWS adapters and CORS
middleware never load in Obsidian, and DOMPurify is used through
Mermaid for diagram sanitisation only), but the project's policy is
to keep the dependency tree on patched releases regardless of reach.

- **hono 4.12.23 -> 4.12.27** clears five advisories:
  GHSA-j6c9-x7qj-28xf (CVE-2026-54287, AWS Lambda Set-Cookie merge),
  GHSA-wwfh-h76j-fc44 (CVE-2026-54286, `serve-static` Windows path
  traversal via `%5C`),
  GHSA-88fw-hqm2-52qc (CVE-2026-54290, CORS reflects any Origin with
  credentials -- the only High in the set),
  GHSA-wgpf-jwqj-8h8p (CVE-2026-54289, Lambda@Edge repeated header
  loss),
  GHSA-rv63-4mwf-qqc2 (CVE-2026-54288, body-limit bypass via
  understated `Content-Length`).
- **dompurify 3.4.10 -> 3.4.11** clears GHSA-cmwh-pvxp-8882
  (permanent `ALLOWED_ATTR` pollution via `setConfig()` -- incomplete
  fix of the 3.4.7 hook-pollution patch).

`overrides.hono` is now pinned to `>=4.12.25`, `overrides.dompurify`
to `>=3.4.11`. Full test suite 3480/3481 green plus 1 expected fail,
tsc clean, build clean.

---


## [3.0.0] -- 2026-06-23

### Inline-Editor AI surface (EPIC-33)

A new way to work with the agent: every selection in the editor is now a
direct entry point for the same agent loop the sidebar drives. The chat
moves into the note. Eleven curated actions plus a free-form chat panel
share one settings layer with the sidebar; nothing about the existing
sidebar workflow changes.

The inline surface is purely additive. There are no breaking changes for
existing users -- the sidebar, providers, vault tools, semantic index,
memory, MCP servers, skills, and history work exactly as before. The
major version reflects the change in interaction paradigm, not a SemVer
break.

### Added

- **Selection-triggered floating menu.** Highlighting text in the editor
  opens a compact menu over the selection with eleven actions: Lookup
  with vault-knowledge integration, Rewrite with inline diff and
  per-hunk Accept/Reject, Send-to-Main-Chat, Translate, Summarize,
  Find-Action-Items, Inline-Chat, Skills-from-the-floating-menu,
  optional Per-Action-Model-Pin. Default chord Mod+Shift+I, registered
  via the app scope so the user can also bind the underlying command
  through Settings -> Hotkeys.
- **Inline chat panel.** A full agent chat surface anchored to the
  selection. Drag the top grip to move the panel; drag the bottom-right
  corner to resize it. The panel runs the same `AgentTask` loop the
  sidebar uses -- skills, rules, memory, MCP servers, mode routing,
  steering messages, attachments, all of it.
- **Live checkpoint markers in the panel.** Every write tool the agent
  runs during an inline chat (`write_file`, `edit_file`, `append_to_file`)
  surfaces as a sidebar-parity checkpoint marker with four actions: show
  diff, undo this, undo from here, more menu. The Rewrite quick-action
  surfaces an explicit pre-apply review via the new `EditReviewModal`.
- **Inline conversations land in the main history.** The panel writes
  its turns to the same `ConversationStore` the sidebar uses, with a
  stable session task id so re-opening an inline conversation from the
  history surfaces the same checkpoint markers as a native sidebar
  conversation.
- **Vault-knowledge integration for Lookup.** Semantic search over the
  vault (10,783-vector default index) augments Lookup answers when at
  least one chunk clears the confidence threshold (`0.7` default, weak
  tier floor `0.6`). The augmentation is wrapped in `<vault_context>`
  tags inside the system prompt so a malicious note cannot escape the
  untrusted block.
- **Optional web fallback for Lookup.** When the vault has no strong
  coverage and a search provider (Brave or Tavily) is configured, one
  capped web search runs with a five-second timeout. Snippets are
  defanged before they reach the prompt and rendered as a deterministic
  appendix after the answer.
- **Skills appear in the floating menu.** Skills with the new
  `inline-action-eligible` capability flag show up next to the built-in
  actions. Output mode (`preview-block` / `inline-diff` / `side-panel`
  / `tooltip`) and `max_selection_chars` come from the skill manifest.

### Security

- Full per-item security audit
  ([AUDIT-EPIC-33-2026-06-23](_devprocess/analysis/AUDIT-EPIC-33-2026-06-23.md)).
  Three High and five Medium findings resolved before release: prompt
  injection hardening across all five actions (XML tagging of selection
  / vault / web contexts, defang of in-band closing tags), 5-second
  timeout plus title/url/snippet clamps on `InlineWebLookup`, allow-list
  guard for `PerActionPin`, hash-collision guard on `EmbeddingCache`,
  wikilink + Markdown-link sanitisation in `LookupAppendix`, enforced
  20-turn cap per inline conversation, capability re-check inside
  `InlineSkillAction`. Twelve regression tests pin the fixes in
  `src/core/inline/__tests__/audit-hardening.test.ts`.
- Vault-RAG weak-tier floor raised from `0.5` to `0.6` so the prompt
  augmentation never quotes a chunk that barely cleared random-baseline
  similarity.
- Embedding cache is cleared on plugin unload so per-session text never
  outlives the session in RAM.

### Deferred to backlog

- `FIX-33-AUDIT-03` Vault-folder filter for sensitive folders in the
  RAG pipeline.
- `FIX-33-AUDIT-04` `OperationLogger` live wiring for the inline action
  telemetry events (ADR-144).

---


## [2.8.1] -- 2026-05-14

### Security (AUDIT-024 fix-loop)

Bundle fix for the four AUDIT-024 findings (1 Medium plus 3 Lows, all
Defense-in-Depth). No user-visible behaviour change.

- **runtimeWorker SHA-cache (M-1).** The materialised worker file
  now stores a SHA-256 sidecar and verifies the hash before reuse.
  Replaces the byte-length-only check that allowed a forged file of
  identical size to survive.
- **runtimeWorker path-traversal hardening (L-1).** Hard whitelist
  for worker filenames (`sandbox-worker.js`, `mcp-server-worker.js`)
  plus explicit slash, backslash and double-dot rejection, plus a
  `startsWith` defense on the resolved path.
- **OptionalAssetManager path-traversal hardening (L-2).** New
  `assertSafeFilename` helper runs before every `filePath` and
  `shaSidecarPath` call. Rejects empty, slash, backslash, double-dot
  and leading dot.
- **OptionalAssetManager size cap (L-3).** `install()` and
  `installFromBuffer()` reject payloads over 50 MB before spending
  memory on a full SHA-256 digest. Catches both an oversized GitHub
  download and a wrong-file local pick.

Audit report: [`_devprocess/analysis/AUDIT-024-v2.8.0-2026-05-13.md`].

---

## [2.8.0] -- 2026-05-13

### Community-plugin-directory readiness

This release reshapes the plugin around Obsidian's community-plugin
review-bot rules so the plugin can be submitted to the directory. The
visible UX stays the same for existing users; the work is mostly under
the hood.

### Added

- **FirstRun setup wizard.** Seven-step modal that walks new users
  through provider setup (LLM, embedding model, role models, search
  provider, optional downloads). Auto-opens for the first three
  sessions, then stops nagging. Skipped steps surface as inline
  hint banners in the matching settings tabs.
- **Optional asset downloads.** Two large assets (ONNX reranker
  ~12 MB, self-development source bundle ~5 MB) no longer ship inside
  `main.js`. They live as separate GitHub-release assets, are
  downloaded once with explicit user consent, SHA256-verified, and
  stored under `<vault>/.vault-operator/assets/`. File-picker
  fallback for users without GitHub access.
- **Help tab in Settings** opens the docs site in the external
  default browser.
- **PluginPatchModal** replaces the agent's `manage_source` reload
  path. Compiled patches are offered as a `main.js` download with a
  step-by-step apply checklist instead of being written into the
  plugin folder automatically.
- **PRIVACY.md** at the repo root documents every system-identity
  read, background network call, and third-party service.

### Changed

- **main.js shrunk from 37 MB to 14 MB.** No `pluginDir` writes at
  runtime; workers, sql.js WASM, bundled skills and templates are
  inlined as TypeScript constants; ONNX and source bundle moved to
  the optional-download flow.
- **Vault folder defaults** for fresh installs are now
  `<vault>/.vault-operator/` (local data) and
  `<vault-parent>/vault-operator-shared/` (cross-vault data).
  Existing installs keep their legacy `.obsilo-vault/` and
  `obsilo-shared/` folders through a lazy fallback in
  `GlobalFileService`. No data migration needed.
- **Deep-link protocols** added `obsidian://vault-operator-chat` and
  `obsidian://vault-operator-settings`. Legacy `obsilo-chat` and
  `obsilo-settings` aliases keep existing frontmatter links working.
- **Backup format** new files use `vault-operator-backup`; legacy
  `obsilo-backup` files can still be imported.
- **VaultHealthRepairModal** stopped looking up a dead view-type
  string.
- **Memory + Soul chat** kicks off exactly once after wizard
  completion instead of on every plugin reload.

### Removed

- `AssetProvisioner` removed. Was the main "self-update via archive
  extraction" pattern the review bot rejected.
- `PluginReloader.deployAndReload`, `writeBundle`, `createBackup`,
  `rollback`, `hasBackup` removed. `PluginReloader.reload()` stays
  for post-manual-replace re-init.
- `vault-operator-assets.tar.gz` no longer produced by the release
  workflow.

### Internal

- Release workflow now generates GitHub artifact-build-provenance
  attestations for `main.js`, `styles.css`, the reranker WASM, and
  the source bundle.
- `esbuild.config.mjs` restructured: source-bundle generation moved
  out of `onEnd` so the bake-in SHA in `main.js` matches the
  generated `plugin-source.json` on every build.
- `package.json` version aligned with `manifest.json`.

---

## [2.7.4] -- 2026-05-13

### Added

- **EPIC-24 Wave 2+3: Agent-Loop Cost & Robustness.** Four new agent-loop
  features that reduce cost and improve subagent ergonomics, complementing
  Wave 1 (cache prefix, microcompaction, tool-output discipline) shipped in
  2.7.3.
  - **FEAT-24-09 (Active Skills, on-demand).** The skill directory now lives
    inside the cached prompt prefix and the model loads a single skill body
    on demand via the new `read_skill` tool. Replaces the per-message
    keyword classifier so cache stays warm across turns. (ADR-116.)
  - **FEAT-24-06 (MCP-Listing-Cap + on-demand detail).** MCP tool
    descriptions in the system prompt are capped at 200 characters; the new
    `read_mcp_tool({server, name})` tool fetches the full description and
    input-schema summary when the model needs it. Also defers `inspect_self`
    and `update_settings` to the deferred-tool set so they only land in the
    schema after `find_tool` activation. (ADR-118 supersedes ADR-117.)
  - **FEAT-24-04 (Subagent profile).** `new_task({profile: 'research'})`
    spawns a lean subagent with a read-only tool allowlist (10 schemas vs.
    34 in main) and a tight role definition. Parent context stays flat
    after the subtask returns. Per-call token budget (default 8000) bounds
    spawn messages. (ADR-113.)
  - **FEAT-24-07 (Helper-Model-Routing).** New top-level setting
    `helperModelKey` routes four internal LLM calls (context condensing,
    fast-path planning, plan_presentation, recipe promotion) to a cheaper
    helper model when set. Settable via the new "Helper model" dropdown in
    Settings -> Vault Operator -> Agent behaviour -> Loop. Fail-closed:
    invalid setting falls back to the main model. (ADR-115.)

- **IMP-24-06-02: `list_pinned_conversations` tool.** Lists chat
  conversations the user pinned to memory via the Star button or
  `mark_for_memory`. Complementary to `list_memory_source_notes` (which
  lists vault notes registered as memory-source). Reads
  `facts.source_session_id` from the FactStore.

### Changed

- **IMP-24-04-01: research subagent completion discipline.** The
  RESEARCH_PROFILE role definition now requires the subagent to put the
  concrete output the parent asked for into `attempt_completion.result`
  (with an explicit anti-pattern example), instead of a meta-acknowledgement
  like "5 relevant notes identified". Reduces parent followup work and
  cost when a subagent is spawned for structured research.

### Fixed

- **FIX-04-03-02 (P0, issue #34).** Claude Opus 4.7 and OpenAI GPT-5.x
  reject any `temperature` parameter with a 400 ("temperature is
  deprecated", "only default value 1 is supported"). The plugin sent
  `temperature` unconditionally from five providers (anthropic, openai,
  bedrock, kilo-gateway, chatgpt-oauth); only the OpenAI o-series was
  skipped. New shared `modelSupportsTemperature()` helper in
  `model-registry.ts` returns false for `claude-opus-4-7*` and `gpt-5*`
  (normalises OpenRouter / Bedrock aliases) and all five providers now
  omit the parameter when false. Live-reported by @edding333 on the
  public repo.
- **FIX-04-03-03 (P0, issue #33).** Custom OpenAI-compatible providers
  like `opencode go` hit CORS in the Obsidian renderer. The
  `createNodeFetch()` bypass that uses Node.js `https` to skip
  CORS-enforcement was hardcoded to `type === 'gemini'` only, and even
  if enabled it was hardcoded to HTTPS port 443. Makes `createNodeFetch`
  protocol-aware (http vs https module, port 80 vs 443) and activates
  the bypass for `custom`, `ollama`, and `lmstudio` as well as the
  existing `gemini`. Reported by @hfr38.
- **FIX-24-09-01 (P1).** `skill-directory` prompt section stayed hidden
  for users who started but never finished the onboarding wizard but used
  the plugin productively afterwards. New `isActiveOnboardingFlow()`
  helper distinguishes "wizard currently active" from "wizard abandoned
  but plugin is in use" by also checking `activeModels.length`.
- **FIX-24-07-01 (P1).** `update_settings` could not write five EPIC-24
  settings (`helperModelKey`, `subtaskTokenBudget`,
  `microcompactionEnabled`, `rollingSummaryThreshold`,
  `costWarnThresholdEur`) because `WRITABLE_PATHS` was not updated when
  the settings shipped. All five paths added to the allowlist and pinned
  by a regression test.
- **FIX-24-07-02 (P1).** `helperModelKey` had no settings UI; only
  settable via the `update_settings` tool or `data.json` edit. New
  "Helper model" dropdown at the bottom of the Loop settings tab.
- **FIX-24-06-01 (P1).** The deferred-tool filter only removed deferred
  tools from the prompt schema; the model could still hallucinate the
  call from training and the execution path ran the tool with hallucinated
  arguments, wasting cost on wrong-path retries. Adds an execution-side
  guard in `AgentTask.runTool` that returns a tool_error pointing the
  model at `find_tool` when a deferred tool is called without activation.
- **FIX-24-06-02 (P1).** `MemorySourceStore` was never initialised
  because the init at `main.ts:600` checked `memoryDB?.isOpen()` before
  `memoryDB` itself was opened ~500 lines later. All three memory-source
  tools (list/mark/unmark) returned "MemorySourceStore not available".
  Adds a second-pass init right after `memoryDB.open()`.
- **FIX-24-06-03 (P1).** `read_mcp_tool` was registered in `ToolRegistry`
  but missing from `TOOL_GROUP_MAP.mcp`, so the schema filter removed it
  from every mode. The model tried to route the call via `use_mcp_tool`
  to the MCP server (which rejected it as "unknown tool"). Same drift
  pattern as BUG-021 / FIX-19-28. Adds the tool to the `mcp` group plus
  a coverage test.

### Compliance

- 1490 tests passing (+23 from 2.7.3). lint clean for all touched files.
  tsc clean. Build + deploy green.

---

## [2.7.3] -- 2026-05-13

### Changed

- **Rebrand to Vault Operator.** Plugin id and display name changed from
  `obsilo` / "Obsilo" to `vault-operator` / "Vault Operator". Apache-2.0
  LICENSE is now canonical. First release under the new plugin id.
- **EPIC-24 Wave 1: Agent-Loop Cost (cache prefix + microcompaction).**
  The system prompt is split at an explicit cache breakpoint so stable
  sections stay cache-warm across turns. Microcompaction prunes consumed
  tool_result blocks from the live history, freeing tokens without losing
  task continuity. Bedrock provider added cache-point markers. Tool-output
  externalization stays out of the cached prefix.

### Fixed

- Versions.json backfill: 2.7.2 was missed at release time and is now
  included alongside 2.7.3.

---

## [2.7.2] -- 2026-05-12

### Compliance

- Lint cleanup and review-bot prep ahead of the rebrand release.

---

## [2.7.1] -- 2026-05-05

### Fixed

- **FIX-14-03-01 (P1).** Relay poll interval raised from 2 s to 10 s. Cloudflare
  Workers Free Plan caps requests at 100k/day per account; the 2 s polling
  alone produced 43.200 requests/day per open Obsidian instance, independent of
  actual MCP usage. With BRAT hot reloads and multi-device setups the cap was
  hit even on idle days, surfacing as HTTP 429 + worker code 1027 (quota
  exhausted). Poll interval and reconnect delays moved into named constants in
  `src/mcp/RelayClient.ts` so the cost story is explicit. (FEAT-14-03,
  EPIC-14, ADR-55.)
- **FIX-14-03-02 (P2).** Relay `pollLoop` bare `catch {}` hid HTTP status,
  body, and stack. Replaced with a `describeRequestError` helper that builds a
  one-line diagnostic and a `redactToken` helper that strips the relay token
  before logging. After 3 consecutive failures a single Notice surfaces the
  outage without devtools. AUDIT-005 H-2 / H-3 still hold: every logged string
  runs through token redaction. (FEAT-14-03, EPIC-14, ADR-55, AUDIT-005.)

### Compliance

- **Review-bot pass on PR #11394.** 29 findings flagged on the public mirror
  commit `c17f37d` cleared. Mix of TypeScript hygiene rules and the
  `obsidianmd/ui/sentence-case*` family.
  - Stringification (`@typescript-eslint/no-base-to-string`): type guards
    instead of `String(unknown)` in `AutoTriggerObserver.matchesValue`,
    `SemanticIndexService` tag lookup, and `validateNewTaskInput` (4 fields).
  - Unbound method: `DeepIngestPipeline` wraps `TensionDetector.markerWorthy`
    in an arrow function so `this` stays bound.
  - Floating promise: `updateMemory` legacy telemetry call prefixed with
    `void`.
  - Redundant union: `string | unknown` -> `unknown` in `executeVaultOp`
    (`string` is already a subtype).
  - `obsidianmd/no-static-styles-assignment` disable in `main.ts` line 927
    replaced by a new `.agent-u-cursor-pointer` utility CSS class.
  - Sentence case (29 strings): `Vault Operator` brand removed from settings, error
    and onboarding copy ("the agent" instead). ChatGPT account block reworded
    to avoid `ChatGPT` / `OS` / `Plus` / `Pro` tokens. Eleven BA-25 commands
    and notices in `main.ts` translated from German to English. `MOC` replaced
    with `map-of-content` / `hub` in vault settings.
- **Plugin store submission ready.** Local ESLint with bot-style rules
  reports 0 errors on the entire codebase.

---

## [2.7.0] -- 2026-05-04

### Added

- **Cross-Surface AI Workflow (EPIC-23, BA-26).** Externe Surfaces wie
  Claude Desktop, ChatGPT und Perplexity koennen Vault Operators Memory- und
  History-Layer ueber MCP ansprechen. Neue Remote-MCP-Tools:
  - `save_to_memory` -- Fact-Persistierung mit Source-Tagging
  - `save_conversation` -- Konversation als Living Document
  - `recall_memory` -- Cross-Source Memory-Retrieval
  - `search_history` -- Cross-Source History-Suche
  - V1 `update_memory` deprecated, Migration-Helper im Settings-Tab
- **Source-Interface-Tagging (ADR-108, FEAT-23-04).** Jede Conversation
  traegt eine Origin-Surface (claude / chatgpt / perplexity / obsilo /
  other / unknown). History-Sidebar hat Source-Tabs zum Filtern. Per
  Provider konfigurierbarer Sync-Mode (Auto / Manual) gegen
  Privacy-Trade-Off.
- **Living Documents + Cross-Interface-Threads (ADR-110, FIX-23-01-01..05).**
  Mehrere `save_conversation`-Calls werden in einen Thread mit ID
  `thread-YYYY-MM-DD-{6-hex}` gebuendelt. Living-Documents append-only.
- **Vault-zu-Memory-Bruecke (FEAT-03-25, ADR-109).** Vault-Notizen lassen
  sich als Memory-Source markieren. FrontmatterIndexer beobachtet
  Aenderungen und triggert SingleCallProcessor. Hooks
  `addNoteAsMemorySource` / `removeNoteAsMemorySource`.
- **Karpathy-Wiki-Pattern fuer Vault-Summary-Pflege (BA-25).**
  Vollstaendige Implementation in fuenf Phasen:
  - Phase 1 Foundation: knowledge.db Schema v9 -> v10 Bundle (4 neue
    Tabellen), Auto-Summary-Pipeline
  - Phase 2 Lint-Foundation: Tension-Detection (Hybrid)
  - Phase 3 Ingest-Foundation: Pre-Triage-Tool, Auto-Trigger-Detection
  - Phase 4 Power-User Backend: Frontmatter-Conflict-Detection
  - Phase 5 Erweiterte Schichten: Stufe-3 Job-Runner mit
    Token-Budget-Enforcement, Top-Hub-Block mit
    KV-Cache-Block-Lifecycle
- **Memory v2 Stabilisierungs-Pass (Track 3).** Drei IMPs:
  - IMP-03-17-01 recall_memory cosine NaN-Guard
  - IMP-03-18-01 AgingService daily-scheduler
  - IMP-03-18-02 DriftBus throttle-bypass
- **21 neue Architekturentscheidungen.** ADR-90 bis ADR-110, alle
  Accepted und in arc42 Section 9 verlinkt. Schwerpunkte:
  Cost-Aware Heuristics, KnowledgeDB v10, Source-Identitaet,
  Cluster-Halbwertszeit, Frontmatter-Conflicts, MOC-Marker, KV-Cache,
  Pre-Triage, Tension-Detection, Output-Modus, Web-Search, Stufe-3
  Runner, MCP-Memory-Versionierung, Source-Interface-Tagging,
  Vault-zu-Memory-Bruecke (supersedes ADR-87), Living-Documents.

### Changed

- **arc42 v5.1 (2026-05-04).** Section 1 Status um EPIC-23, BA-25,
  AUDIT-014/015/016 erweitert. Section 5.5 Schema-Version von v5 auf
  v10. Section 5.9.1 Memory v2 von "in Vorbereitung" auf "Cross-Surface
  MCP released". Section 8.14 MCP-Tools-Block aktualisiert. Section 9
  ADR-Tabelle um 21 neue Eintraege ergaenzt.
- **`/coding`, `/testing`, `/security-audit` Skills.** Pre-Commit
  Backlog-First Sync-Chain, Wayfinder-Maintenance, Plan-Coverage-Gate
  binding (siehe `.claude/skills/`).

### Fixed

- **FIX-22-07-01 (P0).** Sidebar view crash beim BRAT-Hot-Reload, weil
  `onOpen()` lief bevor `doLoad()` die Settings geladen hatte.
  `plugin.readyPromise` synchron in `onload()` erstellt, View `await`s
  vor jedem Settings-Zugriff.
- **FIX-04-09-01 (P1).** OpenAI-Provider-Streaming verschluckte
  Tool-Calls, wenn `finish_reason === "stop"` (statt `"tool_calls"`)
  nach gefuellten `delta.tool_calls` kam. Post-Loop-Flush fuer den
  Accumulator addiert. Gleicher Fix auf github-copilot, kilo-gateway,
  chatgpt-oauth uebertragen.
- **FIX-05-02-02 (P1).** SandboxBridge-Circuit-Breaker blieb nach 20
  Fehlschlaegen permanent offen und blockierte selbst triviale
  `evaluate_expression`-Aufrufe. `CIRCUIT_COOLDOWN_MS = 30_000` plus
  `lastErrorAt` Timestamp; Auto-Reset nach Cooldown-Ablauf.
- **FIX-15-00-01 (P1).** KnowledgeDB-Korruption durch nicht-atomare
  Writes plus Cloud-Sync. Atomic-Write (tmp -> rename), Multi-File-
  Coordination via Journal, integrity_check + Auto-Recovery beim Open,
  Lock-File gegen parallele Plugin-Instanzen, Daily-Snapshots mit
  7-Tage-Retention (PLAN-003).
- **FIX-18-03-02 (P1).** `read_file` konnte externalisierte Tool-Results
  unter `.obsidian-agent/tmp/task-*/` nicht oeffnen. Externalizer
  schreibt jetzt unter `{vault}/.obsidian-agent/tmp/...` (vault-
  resident, von vault.adapter aufloesbar, weiterhin
  Obsidian-Index-ignoriert).
- **FIX-18-04-01 (P1).** Streaming-Tool-Error in vier Providern
  (github-copilot, openai, kilo-gateway, chatgpt-oauth) emittierten
  einen `text`-Chunk statt `tool_error`. AgentTask-Mistake-Counter
  griff nicht, der Loop lief endlos. Alle vier auf `tool_error`-Chunk
  umgestellt. EditFileTool-Error-Message gibt Tool-Routing-Hint bei
  grossen `new_str`.
- **FIX-01-12-01 (P1).** Drag-and-drop aus dem Obsidian-File-Explorer
  oeffnete einen neuen Tab statt die Datei an den Chat zu attachen.
  `app.dragManager.draggable` plus `stopPropagation` im drop-Handler.
- **FIX-03-26-02.** Top-Hub-Block-Toggle (und andere Settings-Sub-Toggles)
  reagierten nach Privacy-Acknowledge nicht. `loadSettings()` nutzte
  shallow `Object.assign` statt deep-merge -- neue Sub-Keys wurden
  durch persistierte Eltern-Objekte ueberschrieben. `deepMergeSettings`
  Helper rekursiv fuer Sub-Objekte.
- **FIX-03-23-01.** Onboarding-Memory-Step (BA-25 SC-02) fehlte im
  OnboardingService. Hauptdeliverable nachgereicht.
- **FIX-23-04-01 (Pass 1-7).** Perplexity-MCP-Streamable-HTTP-Compliance:
  Accept-Header-Negotiation (JSON vs SSE), Mcp-Session-Id Echo,
  body-pre-parse plus default content-type, notification 202 mit
  leerem Body und ohne Content-Type, protocolVersion-Echo,
  Living-Document Append-Logik relax.
- **FIX-23-01-01..05.** Living Documents + Cross-Interface-Threads:
  Thread-Pill UI, sync_session source_interface tagging,
  Auto-Tracking-Doppel-Suppression, ensureSession lazy,
  save_conversation per-message-cap (AUDIT-015 H-1).
- **FIX-03-18-01 (P2).** SingleCallProcessor budget-exhausted Test-Setup
  benutzte UTC-Date-Key, TokenBudgetGuard intern Local-Date-Key.
  Around-Midnight-UTC mismatched -> snapshot fiel auf Zero-Bucket
  zurueck, blockReason() = null, Mock throw. Day-Key gepinnt via
  `today` seam.

### Security

- **AUDIT-014 (BA-25 Pre-Release).** Medium-Risk, alle 4 Findings
  resolved. URL-Sanitizer in IngestTriageLogStore, Rate-Limit fuer
  AutoTriggerObserver, Settings-UI Privacy-Hinweis fuer Top-Hub-Block,
  Stufe3PeriodicJob state-Persistierung in DB.
- **AUDIT-015 (EPIC-23 Pre-Release).** 1 H + 3 M Findings, alle resolved
  und 50 neue Eval-Tests:
  - H-1 save_conversation per-message + per-call cap
  - M-1 McpRateLimiter (sliding-window, 3 Klassen)
  - M-2 sanitizeVaultContentForLLM gegen Prompt-Injection
  - M-3 strictSourceIsolation Setting fuer recall_memory + search_history
- **AUDIT-016 (Full-Codebase, periodic).** 0 C / 1 H / 4 M / 5 L / 3 I,
  9/10 Findings resolved, 1 deferred (IMP-23-04-05 relay /poll
  Partitionierung):
  - H-1 sync_session Cap-Vererbung von save_conversation
  - M-1 write_vault content-cap (4 MB / 16 MB)
  - M-2 search_history LIKE-wildcard escape
  - M-3 get_context strictSourceIsolation gating
  - M-4 ConversationStore.generateId crypto.randomUUID
  - L-1 ActiveMcpSessions ohne djb2-Hash
  - L-2 cosine NaN-Guard (`Number.isFinite(sim)`)
  - L-3 OutputModeGenerator instanceof TFolder statt cast
  - L-5 validateVaultRelativePath Helper (3 Tools deduped)

---

## [2.6.0] -- 2026-04-26

Wave-4 Community-Feedback Release. Detailliert im git-Log
(`ae7d041 chore: release v2.6.0`) und unter
[Vault Operator Releases](https://github.com/pssah4/vault-operator/releases).

Highlights:
- BUG-019..022 fixes (drag-and-drop, OpenAI tool-call flush, BUG-020
  read_file tmp, BUG-021 find_tool multi-word)
- BUG-023..025 (vault-health icon stethoscope)
- BUG-026 BRAT hot-reload sidebar crash (initial fix, vor FIX-22-07-01)
- BUG-027 sandbox circuit auto-reset, BUG-028 trailing-slash paths
- AUDIT-012 Pre-Release Audit GREEN

---

## [2.5.1] -- 2026-04-21

Wave 2 Community-Feedback. Hard tool-filter, create_excalidraw arrows,
session-disable on permanent provider errors.

---

## [2.5.0] -- 2026-04-17

Wave 1 Community-Feedback (BA-013 + IMPL-007). FIX-Bundle:
FEATURE-0409 (Tool-Call Flush, BUG-013), FEATURE-1206 (Copilot
max_completion_tokens), FEATURE-1803 (Cross-Platform TMP),
FEATURE-0507 (konfigurierbarer Agent-Folder, ADR-072), neue Tools
(create_drawio), MCP Type-Safety, npm overrides fuer transitive
Vulnerabilities.

---

Older releases see git tags `v2.4.x` and earlier.
