# Privacy

Vault Operator runs locally inside your Obsidian instance. This page lists
every place where it reads system information, writes data, or talks to
the network, so you can decide what to enable.

## What stays local

Vault content, conversations, memory facts, settings, custom tools and
skills — all stored locally in your Obsidian vault or in the plugin's
local SQLite databases. Nothing leaves your machine except the specific
data you send through a provider you configured (see below).

## What is read about your system

- `os.hostname()` is read when the knowledge database lock is acquired
  on startup. It is written into a local lock file so that Obsidian Sync
  users can see which device currently holds the database write lock.
  The hostname is never transmitted off your machine.
- `process.env.PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `SYSTEMROOT`, `NODE_PATH` are read only when you enable subprocess
  features (PPTX rendering via headless renderer, custom recipe
  execution, sandboxed code evaluation). They are passed as the minimal
  environment to the spawned child process. They are never transmitted
  off your machine.

## Background activity

- The hourly Knowledge-Maintenance job (`Stufe3PeriodicJob`) may run web
  searches to flag outdated knowledge clusters. This job is opt-in via
  Settings -> Vault -> Knowledge Maintenance -> Periodic Updates. It is
  OFF by default. When enabled, it is budget-capped at $2 per week and
  uses the search provider you configured.
- Memory extraction runs in the background when a conversation passes
  the configured turn threshold. It uses the model you selected in
  Settings -> Memory -> Memory model. No external service besides this
  model is contacted.

## Third-party services

You can configure these in Settings. Each one is opt-in and the data
that goes to it is documented:

- **LLM providers** (Anthropic, OpenAI, Google AI Studio, AWS Bedrock,
  Azure OpenAI, OpenRouter, GitHub Copilot, custom OpenAI-compatible
  endpoints): receive the conversation messages, system prompt and any
  file/document context you attach. Required for the agent to work.
- **Embedding providers** (OpenAI, Google, OpenRouter, local Ollama):
  receive the text chunks they need to embed. Used for semantic search
  and memory retrieval.
- **Search providers** (Tavily, Brave, custom): receive the search
  queries the agent generates. Used by web-search tools.
- **MCP servers** that you configure: receive the requests for the
  resources or tools they expose.

## Plugin updates

Vault Operator is distributed through the Obsidian Community Plugin
directory and the BRAT beta channel. Updates are delivered through the
normal Obsidian plugin update process. The plugin never patches its own
files at runtime.

## Optional one-time downloads

Some optional features (Semantic Reranker, Self-Development Source) need
a one-time download of additional model or source files. These downloads
are triggered only by an explicit click in Settings, are fetched from
this plugin's GitHub release page and are stored inside your vault under
`.vault-operator/assets/`. You can remove them via Settings at any time.

## The skill registry

Opening the Skill Registry in Settings does nothing on its own. When you press
Load catalogue the plugin reads one file, `catalog.json`, from the public
registry repository on `raw.githubusercontent.com`. Pressing Install fetches one
more file, the skill package itself.

Both requests are plain reads of public files. No account, no token, no
identifier, and nothing about you or your vault travels with them, beyond what
any HTTP request unavoidably reveals to GitHub (your IP address and the fact
that a file was requested). Nothing is fetched when the plugin starts.

A downloaded package is checked against the checksum recorded in the catalogue
before a single file is written. If it does not match, nothing is installed.

Skills installed this way are marked `Registry` and are not privileged: the
agent asks for approval before one of them changes anything, exactly as it does
for a skill you wrote yourself. If you edit an installed skill it becomes a
`User` skill.

## Questions

Open an issue at https://github.com/pssah4/vault-operator/issues if you
notice something the plugin does that is not covered above.
