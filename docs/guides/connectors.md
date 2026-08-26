---
title: Connectors
description: Connect external MCP tools to Vault Operator, expose your vault to Claude Desktop and ChatGPT, and reach it remotely via a Cloudflare relay.
---

# Connectors

Vault Operator can call tools that live in external MCP servers, expose your vault and memory layer to other AI clients, and let you reach it remotely. All of this lives under one tab: **Settings > Vault Operator > Customize > Connectors**.

The tab has three in-page sections:

- **Local connector**: turn this Obsidian instance into an MCP server for Claude Desktop and any other client that speaks MCP over Streamable HTTP.
- **Remote access**: pair the local server with a Cloudflare relay so ChatGPT, Perplexity, or another remote client can reach it.
- **External tool servers**: list of MCP servers that Vault Operator calls out to.

## External tool servers: call MCP tools from the agent

The MCP client lets Vault Operator use tools that live in external MCP servers. You can extend what the agent can do without writing a plugin.

### What you can connect

Any MCP-compatible server works. A few common examples:

- Database tools (query SQLite, PostgreSQL, or other databases)
- Web services (call APIs, fetch data)
- Local utilities exposed over HTTP (file system helpers, custom scripts)
- Third-party integrations (GitHub, Slack, calendar services)

There are two kinds of server. A **remote server** you reach over a URL (SSE or Streamable HTTP). A **local (stdio) server** is a command Vault Operator launches on your machine. The two have different setup flows and different trust models.

### Connector catalog

For common services, Vault Operator ships a curated connector catalog so you do not have to look up endpoint URLs or create API keys. Open **Settings > Vault Operator > Customize > Connectors > External tool servers > Add a connector** and search for a name or a topic. Curated connectors carry an **Official** badge. The same search also finds community servers from the official MCP registry (registry.modelcontextprotocol.io); registry listings are not audited, so review the publisher before adding one of those. Click **Details** to review a connector, then **Add**. A freshly added connector starts switched off; turning its toggle on in the server list connects it, including the browser sign-in when the connector uses OAuth.

The catalog contains:

| Connector | What it provides | Connection |
|-----------|------------------|------------|
| Notion | Search and read your Notion workspace | Remote, OAuth sign-in |
| Exa | Semantic web and research-paper search | Remote, OAuth sign-in |
| Tavily | Real-time web search and content extraction | Remote, OAuth sign-in |
| Readwise | Answer from your highlights and Reader documents | Remote, OAuth sign-in |
| Atlassian | Jira issues and Confluence pages | Remote, OAuth sign-in |
| Plaud | Your Plaud recordings, transcripts and AI notes | Remote, OAuth sign-in |
| Microsoft Learn | Microsoft and Azure documentation and training content | Remote, no sign-in |
| Icons8 | Free PNG icons and illustrations for canvas and diagrams | Remote, no sign-in |
| Azure DevOps | Work items, repositories and pipelines from your Azure DevOps organization | Local (stdio), personal access token, Desktop only |

The OAuth connectors use OAuth 2.1 with dynamic client registration: you sign in with your existing account in the browser instead of creating and pasting an API key, and the returned tokens are stored encrypted. The sign-in page opens only after an explicit action from you, such as turning the connector's toggle on or clicking its retry action; an automatic reconnect, for example when Obsidian starts, never opens a browser on its own and instead waits in the server list until you sign in.

Azure DevOps is the one local (stdio) entry. Adding it runs a guided setup that asks for your organization and a personal access token, stores both only on this device, and follows the stdio trust rules described below.

Added catalog connectors behave like any other server. They appear in the server list with the **Official** badge, and in the chat sidebar's tool picker (options menu, then **Tools & MCP servers**) under **Protocol servers**, where you can switch each one on or off per agent.

The catalog is data-driven; the current list lives in `src/core/mcp/connectorCatalog.ts`.

### Setup for a remote server

Manual setup is the generic path for any MCP-compatible server, whether or not the catalog or the registry search knows it. If you already have the server's endpoint URL, add it here:

1. Open **Settings > Vault Operator > Customize > Connectors > External tool servers**
2. Click **"+ Add Server"**
3. Choose the transport type:

| Transport | When to use |
|-----------|-------------|
| Streamable HTTP | Modern remote servers (recommended) |
| SSE | Older remote servers using Server-Sent Events (fallback) |

4. Enter the server URL
5. If the server needs authentication:
   - **Token or header auth**: add the credential as a header in the **Headers** field, for example `Authorization=Bearer <token>`. Header values with a secret-looking name (authorization, token, api-key, and similar) are stored encrypted.
   - **OAuth**: servers that use OAuth show an **Authorize** button. Click it and Vault Operator opens the server's sign-in page in your browser; the returned tokens are stored encrypted and refreshed automatically, so you sign in only once.
6. Save. The agent picks up available tools automatically.

Once connected, the agent calls external tools with `use_mcp_tool` and manages remote servers with `manage_mcp_server`.

### Setup for a local (stdio) server

Some MCP servers ship only as a local command, not as a URL (Azure DevOps, Playwright, Filesystem, and others). Vault Operator can launch these directly, without a separate bridge process. This path is **Desktop only** (mobile has no Node runtime) and is deliberately narrow and fail-closed:

- **You add stdio servers, the agent cannot.** `manage_mcp_server` only accepts remote (SSE and Streamable HTTP) servers. Adding, editing, trusting, or reconnecting a stdio server happens in Settings, by you. The agent can use a stdio server's tools once you have set it up, but it can never create or launch one.
- **The config is device-local.** A stdio server you add on one machine is stored outside the vault and never syncs to another device, so a synced config can never auto-launch a process somewhere else.
- **The first launch needs your confirmation.** Before a stdio server runs the first time, Vault Operator shows a **Trust and run** prompt on that device. Until you confirm, nothing spawns. Changing the command or its arguments later prompts you again.
- **Only `node` and `npx`.** The command must be a bare `node` or `npx` (no path, no shell characters). Anything else is rejected with a clear error instead of running.
- **Secrets stay encrypted.** Environment variables you set for the server (for example an access token) are encrypted at rest and decrypted only at launch.

To add one:

1. Open **Settings > Vault Operator > Customize > Connectors > External tool servers**
2. Click **"+ Add Server"** and choose the **stdio (local program)** type (Desktop only)
3. Enter the command (`node` or `npx`) and its arguments, for example command `npx` with args `@azure-devops/mcp`
4. Add any environment variables the server needs (secret-named values are stored encrypted)
5. Save, then confirm the **Trust and run** prompt on this device

:::warning A local process runs with your permissions
A stdio server is a normal process on your machine with your user rights, and there is no OS sandbox around it. Only add servers you curate and trust. If you need OS-level isolation, run the server externally and connect to it over HTTP instead.
:::

:::tip Servers that are not node or npx
The stdio path only launches `node` and `npx`. For a server that ships another binary (Python, Go, dotnet), run it locally as an HTTP server first and add it as a Streamable HTTP server. Example: `npx @playwright/mcp@latest --port 3001`, then add `http://localhost:3001`.
:::

:::tip Discovery is automatic
You don't need to tell the agent which tools are available. It reads the tool list from each connected MCP server and uses them when they fit your request.
:::

## Local connector: expose Vault Operator to other AI clients

You can turn Vault Operator into an MCP server so Claude Desktop, ChatGPT, Perplexity, or any other MCP client can read and write your vault, memory, and history layers.

### Why this matters

Most external AI clients cannot access your Obsidian notes on their own. With Vault Operator's local connector enabled, they get structured access to:

- The vault: search and read notes, run vault operations
- Persistent memory: cross-surface facts and preferences
- Conversation history: search past chats across surfaces

Each external call carries a `source_interface` tag (`obsilo`, `claude-ai`, `claude-code`, `chatgpt`, `perplexity`, `unknown`) so memory and history stay separable per surface. See [Unified Chat Memory](/concepts/unified-chat-memory) for the cross-surface UX.

### Available tools (four tiers)

| Tier | Tools | What they do |
|------|-------|-------------|
| Read | `get_context`, `search_vault`, `read_notes`, `get_vault_note_metadata`, `get_vault_implicit_edges` | Vault, ontology, structural information |
| Memory | `recall_memory`, `save_to_memory`, `update_memory` (deprecated) | Persistent facts and preferences across surfaces |
| History | `save_conversation`, `close_conversation`, `search_history`, `sync_session` | Conversations as living documents, plus full-text search |
| Write | `write_vault`, `execute_vault_op` | Create, edit, delete files. Runs vault operations from the plugin's tool registry. |

`execute_vault_op` is the gateway to all vault operations. It lists the available tools at runtime, including `vault_health_check`, `semantic_search`, `create_pptx`, and others. The list is generated from the plugin's tool registry, so new tools show up automatically without any config changes.

`get_context` is meant to be called first in every conversation. It returns user profile, memory, behavioral patterns, vault statistics, available skills, and rules.

### Strict source isolation

Strict source isolation is **off by default** for all surfaces. External clients see the full memory and history layer through `get_context`, `recall_memory`, and `search_history`.

Turn it on under **Settings > Vault Operator > Customize > Connectors > Cross-Surface Sync** when you want to keep your personal memory inside Vault Operator and only share structural vault info with external clients. With strict mode on, those three tools only return items tagged `source_interface = obsilo`.

You can also enable per-surface sync to opt specific clients into shared memory after turning strict mode on.

### Setup for Claude Desktop

1. Open **Settings > Vault Operator > Customize > Connectors > Local connector**
2. Enable the local connector
3. Click **"Configure Claude Desktop"**. This writes the configuration into Claude Desktop's config file for you.
4. Restart Claude Desktop

Claude Desktop now sees the vault, memory, and history as available tool sources.

:::info How the local connection works
Claude Desktop speaks MCP over stdio, but Vault Operator's server is a local HTTP server on `127.0.0.1:27182`. "Configure Claude Desktop" wires up a small proxy (`mcp-server-worker.js`) that Claude Desktop launches; the proxy forwards each request to the local HTTP server. Both use a token stored at `~/.obsidian-agent/mcp-token`, so only clients on your machine that can read that file can connect. See [MCP architecture](/concepts/mcp-architecture) for the full picture.
:::

### Setup for any other MCP client (generic Streamable HTTP)

Any client that can add a custom MCP server over Streamable HTTP reaches the local connector directly, with no proxy and no relay. The server binds the loopback interface only, so nothing leaves the machine.

1. Open **Settings > Vault Operator > Customize > Connectors > Local connector** and enable the local connector.
2. In the client, add a custom MCP server. Transport: **Streamable HTTP**. Auth mode: none or "custom header"; Vault Operator does not speak OAuth on this path.
3. URL: `http://127.0.0.1:27182`. Plain `http` is correct here, the request never leaves the machine.
4. Authentication: one request header, `Authorization`, whose value is the word `Bearer`, a space, and the token.

Clients ask for that header in three different shapes, so the panel hands out all three:

| What the client asks for | Button | What lands in the clipboard |
|--------------------------|--------|-----------------------------|
| One full header line | **Copy header** | `Authorization: Bearer <token>` |
| Separate name and value fields | **Copy header value** | `Bearer <token>` |
| A bare token that the client wraps itself | **Copy token** | `<token>` |

The `Bearer` prefix belongs to the **value**, not to the header name. Get that wrong and the request is refused before any MCP handshake happens:

- Value carries the token alone: `401`, `Unauthorized: Authorization header must use the Bearer scheme`.
- Value still carries `Authorization:`: the same `401`, because the scheme the server reads is then the field name.
- Value is right but the token is stale, for example after **Rotate token**: `401`, `Unauthorized`, with nothing further. Copy the value again.

The connector answers only while Obsidian is running, and only from the same machine.

#### Clients that run with an isolated home directory

Some clients start their tool processes in a sandbox with `HOME` pointed at a scratch directory. That breaks the stdio path, not the HTTP one:

- The proxy `mcp-server-worker.js` reads its token from `~/.obsidian-agent/mcp-token`. Under a redirected `HOME` that file is not there, the proxy never authenticates, and the client shows a hang followed by a timeout rather than an auth error. If the client offers a "use the real home directory" switch for its MCP servers, turn it on. If it does not, use the HTTP setup above: the token travels in the header and no file is read.
- A relative path in the client's config resolves against that scratch directory too. Paste the absolute paths the **Copy command** and **Copy arguments** buttons produce, unedited.

### Setup for ChatGPT (custom connector)

1. In Vault Operator, open **Settings > Vault Operator > Customize > Connectors > Remote access** and copy the relay URL (see Remote access below).
2. In ChatGPT, open **Settings > Connectors > Create custom connector**.
3. Use the relay URL as the MCP server endpoint.
4. Authorize. ChatGPT now has the same four tiers available, gated by your strict-source-isolation setting.

### Setup for Perplexity

1. Same relay URL as ChatGPT.
2. Add it as an MCP server in Perplexity's connector settings.
3. Set **Transport: Streamable HTTP** and **Auth: None**. The token is already part of the relay URL. Perplexity's OAuth and API-key auth modes do not work with the relay (it answers OAuth discovery probes with a clean 404).

#### Remote client support matrix

| Client | Status | Notes |
|--------|--------|-------|
| claude.ai | Supported | Streamable HTTP |
| Claude Desktop | Supported | Local connector (config file) or relay URL |
| ChatGPT | Supported | Custom connector with the relay URL |
| Perplexity | Supported with constraints | Transport = Streamable HTTP and Auth = None only. The SSE transport option is not supported by the relay. Perplexity enforces a hard 15 second fetch timeout, which the relay meets via long-polling. |

:::warning Redeploy the relay after plugin updates
The relay worker code ships inside the plugin and only reaches Cloudflare when you deploy it. After updating Vault Operator, redeploy the relay from **Settings > Vault Operator > Customize > Connectors > Remote access** so worker-side fixes (long-polling, error handling) take effect. An outdated worker still works with the plugin, but keeps the old latency and error behavior.
:::

#### Troubleshooting a remote connection

Check the relay's health endpoint first: open `https://<your-worker>.workers.dev/health?token=<your-relay-token>` (the same token that is embedded in your MCP URL). With the token it reports both relay and plugin liveness:

```json
{ "status": "ok", "relay": "obsilo", "plugin": { "connected": true, "lastPollAgeMs": 1250 } }
```

Without the token, `/health` answers with the static `{ "status": "ok", "relay": "obsilo" }` only. That confirms the worker is deployed but says nothing about your plugin; the token gate exists so anonymous callers cannot burn your Cloudflare free plan quota through the liveness probe.

- `plugin.connected: false` or a large `lastPollAgeMs`: the relay is up but your Obsidian instance is not polling. Make sure Obsidian is running and remote access is enabled. Clients get a fast "Vault Operator not connected" error in this state.
- `plugin.connected: true` but the client still fails: the problem is on the client side. For Perplexity, verify Transport = Streamable HTTP and Auth = None.
- HTML error page instead of JSON: your deployed worker predates the current plugin version. Redeploy the relay from plugin settings.
- Errors that appear late in the day and disappear around midnight UTC: you are hitting a Cloudflare free plan daily limit. The relay's idle long-polling keeps its Durable Object resident around the clock, which uses about 10,800 GB-s of the 13,000 GB-s daily free Durable Object duration quota. The relay alone stays under the cap, but the quota is shared with any other Durable Objects on the same Cloudflare account. If you run other Workers with Durable Objects on that account, move the relay to its own account or upgrade the plan.

Do not judge the connection by opening the tokenized MCP URL in a browser; a browser GET does not exercise the MCP handshake and its result is misleading.

:::warning Write access
Write-class tools are disabled by default. The toggle **Allow write tools over MCP** under **Settings > Vault Operator > Customize > Connectors** enables them for all connected clients; it covers `write_vault`, `save_to_memory`, `update_memory` (deprecated), and write operations routed through `execute_vault_op`. Only enable it if you trust every connected client with file-level access. The read and history tiers are safe for everyday use.
:::

:::warning Breaking change in 3.2.4
`save_to_memory` and `update_memory` moved into the write tier and are now behind **Allow write tools over MCP** (default off). External clients that saved memory before 3.2.4 (Claude Desktop, ChatGPT, Claude Code, Perplexity) will receive an error naming the setting until you enable the toggle under **Settings > Vault Operator > Customize > Connectors**. Reading memory (`recall_memory`) is unaffected.
:::

## Remote access via Cloudflare relay

Remote access lets you talk to your vault from anywhere, as long as Obsidian is running on your machine.

### How it works

A Cloudflare Workers relay sits between your local Vault Operator instance and remote clients. Vault Operator holds a connection to the deployed worker and polls it over HTTP long-polling: it asks the relay for incoming requests, runs them locally, and posts the responses back. Long-polling is used on purpose, because Obsidian's content security policy blocks WebSocket connections while plain HTTP requests stay allowed. Authentication uses a token embedded in the URL. No vault data is stored on the relay. It is a passthrough.

You do not need Wrangler or a terminal to deploy the worker. Vault Operator ships the worker code and uploads it to Cloudflare for you through the Cloudflare REST API (via Obsidian's `requestUrl`), using a Cloudflare API token you paste into Settings.

### Setup

1. Create a free Cloudflare account and an API token with the two permissions the setup panel lists (Workers Scripts: Edit and Account Settings: Read).
2. In **Settings > Vault Operator > Customize > Connectors > Remote access**, paste the API token and click **Deploy**. Vault Operator uploads the worker for you (no Wrangler, no terminal).
3. Copy the relay URL it returns. The URL already contains the auth token, so you paste the whole URL into your remote client.
4. The relay connects automatically whenever Obsidian is running.

:::info Always-on requirement
Remote access requires Obsidian to be running on your machine. The relay forwards requests to your local instance. It does not store your vault data in the cloud.
:::

## Living documents and source-interface tagging

When you use Vault Operator through Claude Desktop, ChatGPT, or Perplexity, every persisted message carries a `source_interface` tag. The history sidebar in Obsidian groups conversations by source so you can see what came in from which surface.

Multiple `save_conversation` calls within 30 minutes from the same source interface append to a single thread instead of creating new conversations. This is the living-document model. Memory extraction runs incrementally on the new turns rather than re-processing the whole thread.

`sync_session` is the legacy bulk path: an external client sends an entire transcript at the end of a conversation. It is kept for clients that do not yet support per-turn `save_conversation`.

## Provider setup lives elsewhere

Picking and authenticating AI providers (Anthropic, OpenAI, Gemini, OpenRouter, Azure, Ollama, LM Studio, custom, GitHub Copilot, Kilo Gateway, Bedrock, ChatGPT-OAuth) is covered in [Providers and models](/reference/providers). The Connectors tab is only about MCP and the relay.

## Next steps

- [Unified Chat Memory](/concepts/unified-chat-memory): How memory and history flow across surfaces.
- [MCP architecture](/concepts/mcp-architecture): The protocol details behind the connectors.
- [Skills, Rules and Workflows](/guides/skills-rules-workflows): Customize the agent's behavior.
- [Office documents](/guides/office-documents): Create presentations and documents.
