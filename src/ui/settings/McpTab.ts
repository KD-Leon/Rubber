import { App, Modal, Notice, Setting, ToggleComponent, requestUrl, setIcon, Platform } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import { isWorkerOutdated } from '../../mcp/RelayClient';
import { MCP_LOCAL_PORT } from '../../mcp/McpBridge';
import { RELAY_WORKER_VERSION } from '../../mcp/relayWorkerCode';
import { getCatalogEntry, catalogConfigForAdd, isCatalogUrl } from '../../core/mcp/connectorCatalog';
import { activateMcpServerForAllModes } from '../../core/mcp/mcpActivation';
import { searchMcpRegistry, featuredNamesForTerm, fetchRegistryEntry, catalogDiscoveryResults, type RegistryDiscoveryResult, type RegistrySearchPage } from '../../core/mcp/registryDiscovery';
import { findSetupGuide, type ConnectorSetupGuide } from '../../core/mcp/connectorSetupGuides';
import * as path from 'path';
import * as os from 'os';
import * as safeFs from '../../core/security/safeFs';
import { spawnAllowedSync } from '../../core/security/spawnAllowlist';
import { ENV_APPDATA, readEnv } from '../../util/envKeys';
import { addSectionHeading, addInfoButton, openInfoPopover } from './utils';
import { confirmModal } from '../modals/PromptModal';
import { stdioTrustFingerprint } from '../../core/mcp/stdioTrustFingerprint';
import { sameCredentialScope } from '../../core/mcp/mcpCredentialScope';
import { applyDestructiveStyle } from '../buttonStyle';
import { isSecretEnvName } from '../../core/security/stdioEnvCrypto';
import { parseShellArgs, joinArgsForDisplay } from '../../core/mcp/stdioArgs';
import {
    isLocalHostname,
    isPrivateIpHostname,
    validateProviderUrl,
} from '../../api/providers/providerUrlGuard';

/** Normalized inputs for the guided/generic token-entry dialog (FEAT-04-11,
 *  extended for stdio env target in FEAT-04-13 Phase 1). */
interface TokenSetupSpec {
    serverKey: string;
    displayName: string;
    config: import('../../types/settings').McpServerConfig;
    credentialLabel: string;
    createUrl?: string;
    createLabel: string;
    scopeHint?: string;
    hintText?: string;
    /** 'header' (remote HTTP) writes the secret to a request header; 'env'
     *  (local stdio) writes it into config.env and routes through the
     *  device-local store + trust prompt. */
    target: 'header' | 'env';
    headerName: string;
    bearer: boolean;
    /** env target: the env var the secret goes into. */
    envName?: string;
    /** Non-secret inputs collected before the secret (each with its own hint). */
    fields?: import('../../core/mcp/connectorSetupGuides').ConnectorSetupField[];
    steps: string[];
}

/** Hostname of a URL, or '' for an empty/malformed URL (stdio entries have no
 *  URL; never let new URL() throw and abort a render). */
function safeHostname(url: string | undefined): string {
    if (!url) return '';
    try { return new URL(url).hostname; } catch { return ''; }
}

export class McpTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    build(containerEl: HTMLElement): void {
        // One intro banner for the page
        const intro = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const introIcon = intro.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(introIcon, 'link');
        const introText = intro.createDiv({ cls: 'vault-op-box__text' });
        introText.createEl('strong', { text: t('settings.mcp.connectionsIntroTitle') });

        introText.createDiv({ text: t('settings.mcp.connectionsIntroDesc') });

        this.buildExternalServersSection(containerEl);
        this.buildConnectorSection(containerEl);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connectors
    // ─────────────────────────────────────────────────────────────────────────

    private buildConnectorSection(containerEl: HTMLElement): void {
        // ── Local MCP servers ─────────────────────────────────────────────
        addSectionHeading(
            containerEl,
            t('settings.mcp.headingLocalServers'),
            { body: t('settings.mcp.localServersInfo') },
        );

        const mcpBridge = this.plugin.mcpBridge;
        const isEnabled = this.plugin.settings.enableMcpServer ?? false;

        new Setting(containerEl)
            .setName(t('settings.mcp.enableLocalConnector'))
            .setDesc(t('settings.mcp.enableLocalConnectorDesc'))
            .addToggle((toggle) =>
                toggle.setValue(isEnabled).onChange(async (v) => {
                    // Generate the auth token eagerly on enable. McpBridge.start()
                    // also does this, but it is void-ed (not awaited) below, so the
                    // rerender() that paints the connection details would race an
                    // empty token on first enable without this.
                    if (v && !this.plugin.settings.mcpServerToken) {
                        this.plugin.settings.mcpServerToken = crypto.randomUUID();
                    }
                    this.plugin.settings.enableMcpServer = v;
                    await this.plugin.saveSettings();
                    if (v && !this.plugin.mcpBridge) {
                        const { McpBridge } = await import('../../mcp/McpBridge');
                        this.plugin.mcpBridge = new McpBridge(this.plugin);
                        void this.plugin.mcpBridge.start().catch((e: unknown) =>
                            console.warn('[McpTab] Start failed:', e)
                        );
                    } else if (!v && this.plugin.mcpBridge) {
                        this.plugin.mcpBridge.stop();
                        this.plugin.mcpBridge = null;
                    }
                    this.rerender();
                }),
            );

        if (isEnabled) {
            this.buildLocalConnectionDetails(containerEl);
            // Desktop-only: clients that can't use the HTTP option (e.g. OAuth-only
            // connectors) reach this vault over a local stdio proxy instead. stdio
            // needs child_process, so it never applies on mobile/web.
            if (Platform.isDesktopApp) this.buildStdioConnectionDetails(containerEl);

            new Setting(containerEl)
                .setName(t('settings.mcp.configureDesktopClient'))
                .setDesc(t('settings.mcp.configureDesktopClientDesc'))
                .addButton((btn) => {
                    btn.setButtonText(t('settings.mcp.configureButton')).onClick(() => {
                        void this.writeClaudeDesktopConfig();
                    });
                });
        }

        // FIX-44-48: the write gate (MCP-2 / FIX-44-26) had no UI. The wire
        // errors name this exact toggle and path, so it must exist here.
        // Applies to the local connector AND the remote relay: both dispatch
        // through the same gate in handleToolCall / execute_vault_op.
        const allowWriteSetting = new Setting(containerEl)
            .setName(t('settings.mcp.allowWriteTools'))
            .setDesc(t('settings.mcp.allowWriteToolsDesc'))
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.mcpAllowWriteTools ?? false).onChange(async (v) => {
                    this.plugin.settings.mcpAllowWriteTools = v;
                    await this.plugin.saveSettings();
                }),
            );
        addInfoButton(allowWriteSetting, t('settings.mcp.allowWriteTools'), t('settings.mcp.allowWriteToolsTooltip'));

        // ── Remote access (sub-concept of "Vault Operator as an MCP server") ──
        addSectionHeading(
            containerEl,
            t('settings.mcp.headingRemoteAccess'),
            { body: t('settings.mcp.remoteAccessInfo') },
            { level: 'h4' },
        );

        const remoteEnabled = this.plugin.settings.enableRemoteRelay ?? false;
        const remoteConnected = (mcpBridge as { remoteConnected?: boolean })?.remoteConnected ?? false;

        new Setting(containerEl)
            .setName(t('settings.mcp.enableRemoteAccess'))
            .setDesc(t('settings.mcp.enableRemoteAccessDesc'))
            .addToggle((toggle) =>
                toggle.setValue(remoteEnabled).onChange(async (v) => {
                    this.plugin.settings.enableRemoteRelay = v;
                    await this.plugin.saveSettings();
                    if (v && this.plugin.mcpBridge && this.plugin.settings.relayUrl) {
                        void this.plugin.mcpBridge.connectRelay();
                    } else if (!v) {
                        this.plugin.mcpBridge?.disconnectRelay();
                    }
                    this.rerender();
                }),
            );

        if (remoteEnabled) {
            const hasRelay = !!this.plugin.settings.relayUrl;

            if (!hasRelay) {
                // ── Info banner: setup flow ───────────────────────────────
                const remoteInfo = containerEl.createDiv('vault-op-box vault-op-box--intro');
                const remoteInfoIcon = remoteInfo.createSpan({ cls: 'vault-op-box__icon' });
                setIcon(remoteInfoIcon, 'globe');
                const remoteInfoText = remoteInfo.createDiv({ cls: 'vault-op-box__text' });
                remoteInfoText.createDiv({ text: t('settings.mcp.relayIntro') });
                const steps = remoteInfoText.createEl('ol');

                steps.createEl('li').createEl('a', {
                    text: t('settings.mcp.relayStep1'),
                    href: 'https://dash.cloudflare.com/sign-up',
                });
                const step2 = steps.createEl('li');
                step2.appendText(t('settings.mcp.relayStep2Prefix'));

                step2.createEl('a', {
                    text: t('settings.mcp.relayStep2Link'),
                    href: 'https://dash.cloudflare.com/profile/api-tokens',
                });
                step2.appendText(t('settings.mcp.relayStep2Suffix'));
                const step3 = steps.createEl('li');

                step3.appendText(t('settings.mcp.relayStep3'));
                steps.createEl('li', { text: t('settings.mcp.relayStep4') });

                // ── API Token + Deploy ────────────────────────────────────
                new Setting(containerEl)

                    .setName(t('settings.mcp.cloudflareApiToken'))
                    .setDesc(t('settings.mcp.cloudflareApiTokenDesc'))
                    .addText((text) => {
                        text.setValue(this.plugin.settings.cloudflareApiToken ?? '');
                        text.setPlaceholder(t('settings.mcp.cloudflareApiTokenPlaceholder'));
                        text.inputEl.type = 'password';
                        text.onChange(async (v) => {
                            this.plugin.settings.cloudflareApiToken = v.trim();
                            await this.plugin.saveSettings();
                        });
                    });

                // Deploy button
                const deploySetting = new Setting(containerEl)
                    .setName(t('settings.mcp.deployRelay'))
                    .setDesc(t('settings.mcp.deployRelayDesc'));

                const deployStatusEl = containerEl.createDiv('setting-item-description');

                deploySetting.addButton((btn) => {
                    btn.setButtonText(t('settings.mcp.deployButton')).onClick(async () => {
                        const apiToken = this.plugin.settings.cloudflareApiToken;
                        if (!apiToken) {
                            new Notice(t('notice.mcp.apiTokenMissing'));
                            return;
                        }

                        btn.setDisabled(true);
                        btn.setButtonText(t('settings.mcp.deployingButton'));

                        try {
                            const { CloudflareDeployer } = await import('../../mcp/CloudflareDeployer');
                            const deployer = new CloudflareDeployer(apiToken);

                            // Reuse existing token if available, otherwise generate new one
                            // AUDIT-007 L-1: Use relay_ prefix instead of sk- to avoid confusion with API keys
                            const relayToken = this.plugin.settings.relayToken
                                || ('relay_' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
                                    .map(b => b.toString(16).padStart(2, '0')).join(''));

                            const result = await deployer.deploy(relayToken, (step) => {
                                deployStatusEl.setText(step);
                            });

                            // Save results
                            this.plugin.settings.relayUrl = result.url;
                            this.plugin.settings.relayToken = relayToken;
                            this.plugin.settings.cloudflareAccountId = result.accountId;
                            await this.plugin.saveSettings();

                            // Connect immediately
                            if (this.plugin.mcpBridge) {
                                void this.plugin.mcpBridge.connectRelay();
                            }

                            new Notice(t('notice.mcp.relayDeployed'));
                            this.rerender();
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            deployStatusEl.setText(t('notice.mcp.deployFailed', { message: msg }));
                            new Notice(t('notice.mcp.deployFailed', { message: msg }));
                            btn.setDisabled(false);
                            btn.setButtonText(t('settings.mcp.deployButton'));
                        }
                    });
                });
            } else {
                // ── Already deployed ────────────────────────────────────────
                const baseUrl = this.plugin.settings.relayUrl.replace(/\/$/, '');
                const token = this.plugin.settings.relayToken;
                const mcpUrl = `${baseUrl}/${token}/mcp`;

                const connectorUrlSetting = new Setting(containerEl)
                    .setName(t('settings.mcp.connectorUrl'))
                    .setDesc(t('settings.mcp.connectorUrlDesc'))
                    .addButton((btn) => {
                        btn.setButtonText(t('settings.mcp.copyUrlButton')).onClick(() => {
                            void navigator.clipboard.writeText(mcpUrl);
                            new Notice(t('notice.mcp.urlCopied'));
                        });
                    });
                // Point 2: the verbose "add the URL as a connector in ..." steps
                // move into a tooltip to keep the settings surface minimal.
                addInfoButton(connectorUrlSetting, t('settings.mcp.connectorUrl'), t('settings.mcp.usageTooltip'));

                new Setting(containerEl)
                    .setName(remoteConnected ? t('settings.mcp.statusConnected') : t('settings.mcp.statusConnection'))
                    .setDesc(remoteConnected
                        ? t('settings.mcp.statusConnectedDesc')
                        : t('settings.mcp.statusConnectionDesc'))
                    .addButton((btn) => {
                        btn.setButtonText(remoteConnected ? t('settings.mcp.disconnect') : t('settings.mcp.connect')).onClick(() => {
                            if (remoteConnected) {
                                this.plugin.mcpBridge?.disconnectRelay();
                            } else if (this.plugin.mcpBridge) {
                                void this.plugin.mcpBridge.connectRelay();
                            }
                            window.setTimeout(() => this.rerender(), 1000);
                        });
                    });

                // Troubleshooting hint
                const troubleshoot = containerEl.createDiv('setting-item-description');
                troubleshoot.appendText(t('settings.mcp.troubleshootHint'));
                troubleshoot.createEl('a', {
                    text: t('settings.mcp.troubleshootLink'),
                    href: 'https://github.com/KD-Leon/Rubber/blob/main/docs/guides/connectors.md',
                });

                // Redeploy + Reset
                const redeployStatusEl = containerEl.createDiv('setting-item-description');

                // IMP-14-03-01: warn when the worker live on the account is
                // older than the one bundled in this plugin, so the user knows a
                // redeploy is needed. Only shown once a /poll has revealed the
                // live version; an unknown version stays silent to avoid false
                // alarms (e.g. tab opened before the relay connected).
                const seenWorkerVersion = mcpBridge?.deployedWorkerVersion ?? null;
                if (seenWorkerVersion !== null && isWorkerOutdated(seenWorkerVersion, RELAY_WORKER_VERSION)) {
                    containerEl.createDiv({
                        cls: 'setting-item-description mcp-worker-outdated',
                        text: t('settings.mcp.workerOutdatedWarning'),
                    });
                }

                new Setting(containerEl)
                    .setName(t('settings.mcp.updateRelay'))
                    .setDesc(t('settings.mcp.updateRelayDesc'))
                    .addButton((btn) => {
                        btn.setButtonText(t('settings.mcp.redeployButton')).onClick(async () => {
                            const apiToken = this.plugin.settings.cloudflareApiToken;
                            const accountId = this.plugin.settings.cloudflareAccountId;
                            const relayToken = this.plugin.settings.relayToken;
                            if (!apiToken || !accountId) {
                                new Notice(t('notice.mcp.redeployMissingConfig'));
                                return;
                            }
                            btn.setDisabled(true);
                            btn.setButtonText(t('settings.mcp.updatingButton'));
                            try {
                                const { CloudflareDeployer } = await import('../../mcp/CloudflareDeployer');
                                const deployer = new CloudflareDeployer(apiToken);
                                await deployer.redeploy(accountId, relayToken, (step) => {
                                    redeployStatusEl.setText(step);
                                });
                                new Notice(t('notice.mcp.relayUpdated'));
                                btn.setDisabled(false);
                                btn.setButtonText(t('settings.mcp.redeployButton'));
                            } catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                redeployStatusEl.setText(t('notice.mcp.updateFailed', { message: msg }));
                                new Notice(t('notice.mcp.updateFailed', { message: msg }));
                                btn.setDisabled(false);
                                btn.setButtonText(t('settings.mcp.redeployButton'));
                            }
                        });
                    });

                new Setting(containerEl)
                    .setName(t('settings.mcp.resetRelay'))
                    .setDesc(t('settings.mcp.resetRelayDesc'))
                    .addButton((btn) => {
                        btn.setButtonText(t('settings.mcp.resetButton')).onClick(async () => {
                            this.plugin.mcpBridge?.disconnectRelay();
                            this.plugin.settings.relayUrl = '';
                            this.plugin.settings.relayToken = '';
                            this.plugin.settings.cloudflareAccountId = '';
                            await this.plugin.saveSettings();
                            this.rerender();
                        });
                    });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External tool servers
    // ─────────────────────────────────────────────────────────────────────────

    private buildExternalServersSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.mcp.headingExternalServers'),
            { body: t('settings.mcp.sectionExternalServersInfo') },
        );

        // FEAT-04-10 (point 7): short trust warning near the authorize actions.
        const warn = containerEl.createDiv('vault-op-box vault-op-box--warning');
        const warnIcon = warn.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(warnIcon, 'shield-alert');
        warn.createDiv({ cls: 'vault-op-box__text', text: t('settings.mcp.externalTrustWarning') });

        const mcpClient = this.plugin.mcpClient;
        // DOM order mirrors the trust order: your servers first, discovery
        // second, manual-by-URL last, each its own labelled sub-section so the
        // "Add server" button never looks like it adds a search result (#1/#2).
        const listEl = containerEl.createDiv();
        const discoverEl = containerEl.createDiv();
        const manualEl = containerEl.createDiv();
        addSectionHeading(manualEl, t('settings.mcp.addManual'), { body: t('settings.mcp.addManualInfo') }, { level: 'h4' });
        // Same footer/button shape as the Models and Providers tabs.
        const manualFooter = manualEl.createDiv('model-table-footer');
        const addBtn = manualFooter.createEl('button', { text: '+ ' + t('settings.mcp.addServer'), cls: 'mod-cta model-add-btn' });

        const renderList = () => {
            listEl.empty();
            // FEAT-04-13: stdio servers live in the device-local store (never
            // synced), remote servers in settings.mcpServers. The list shows both.
            const stdioServers = this.plugin.deviceLocalStore?.listStdioServers() ?? {};
            const servers = { ...(this.plugin.settings.mcpServers ?? {}), ...stdioServers };
            const names = Object.keys(servers);
            if (names.length === 0) {
                listEl.createEl('p', { cls: 'agent-settings-desc', text: t('settings.mcp.empty') });
                return;
            }

            // Same table layout as the Skills tab: status | name+desc | source | actions.
            const table = listEl.createDiv('agent-table-box').createEl('table', { cls: 'agent-skill-table agent-mcp-table' });
            const thead = table.createEl('thead');
            const hr = thead.createEl('tr');
            hr.createEl('th', { text: '', cls: 'agent-skill-th-status' });
            hr.createEl('th', { text: t('settings.mcp.headerServer') });
            hr.createEl('th', { text: t('settings.mcp.headerSource'), cls: 'agent-skill-th-cmds' });
            hr.createEl('th', { text: '', cls: 'agent-mcp-th-actions' });
            hr.createEl('th', { text: t('settings.mcp.headerActive'), cls: 'agent-skill-th-toggle' });
            const tbody = table.createEl('tbody');

            for (const name of names) {
                const config = servers[name];
                const conn = mcpClient?.getConnection(name);
                const status = conn?.status ?? 'disconnected';
                const catalogEntry = getCatalogEntry(name);

                const tr = tbody.createEl('tr');

                const statusTd = tr.createEl('td', { cls: 'agent-skill-status-cell' });
                const dot = statusTd.createSpan({ cls: `agent-mcp-status-dot ${status}` });
                dot.setAttribute('title', status);

                // Name + one-line description (live status or catalog blurb).
                let desc: string;
                if (status === 'connected') desc = t('settings.mcp.toolCount', { count: conn?.tools.length ?? 0 });
                else if (status === 'awaiting-auth') desc = t('settings.mcp.awaitingAuth');
                else if (!config.disabled && status === 'error' && conn?.error) desc = conn.error;
                else if (config.authType === 'oauth' && !config.disabled) desc = catalogEntry?.description ?? t('settings.mcp.oauthRequiredHint');
                else desc = catalogEntry?.description ?? config.type;
                const nameTd = tr.createEl('td', { cls: 'agent-skill-name-cell' });
                nameTd.createDiv({ text: catalogEntry?.displayName ?? config.displayName ?? name, cls: 'agent-skill-name' });
                const descEl = nameTd.createDiv({ text: desc, cls: 'agent-skill-desc' });
                if (status === 'error') descEl.addClass('agent-mcp-desc-error');
                // Connected servers: make the tool count a button that opens a
                // scrollable list of the server's tools with their descriptions.
                if (status === 'connected' && (conn?.tools.length ?? 0) > 0) {
                    descEl.addClass('agent-mcp-toolcount-link');
                    descEl.setAttribute('role', 'button');
                    descEl.setAttribute('tabindex', '0');
                    const open = () => this.openToolListModal(catalogEntry?.displayName ?? config.displayName ?? name, conn?.tools ?? []);
                    descEl.addEventListener('click', open);
                    descEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
                }

                // Source column: curated first-party servers read "Official"
                // (same meaning as in the discovery search); everything the user
                // added reads "User". The old "Built-in" distinction is gone --
                // built-ins now live behind the search (hidden-catalog model).
                const sourceTd = tr.createEl('td', { cls: 'agent-skill-cmd-cell' });
                const isOfficial = config.official === true || !!catalogEntry || isCatalogUrl(config.url);
                const badge = sourceTd.createSpan({ cls: 'agent-skill-source-badge' });
                if (isOfficial) {
                    badge.setText(t('settings.mcp.discover.trustOfficial'));
                    badge.addClass('agent-skill-source-builtin');
                    badge.setAttribute('title', t('settings.mcp.discover.trustOfficialTip'));
                } else {
                    badge.setText(t('settings.mcp.userBadge'));
                    badge.addClass('agent-skill-source-user');
                }

                // Action icons (Prompts recipe): retry when a live attempt
                // failed or awaits the browser, then edit, then delete (user
                // servers only).
                const actionsTd = tr.createEl('td', { cls: 'agent-mcp-actions-cell' });
                if (!config.disabled && (status === 'error' || status === 'awaiting-auth')) {
                    const retryBtn = actionsTd.createEl('button', { cls: 'agent-rules-edit-btn' });
                    setIcon(retryBtn, 'rotate-ccw');
                    retryBtn.setAttribute('aria-label', config.authType === 'oauth' ? t('settings.mcp.retryAuthorize') : t('settings.mcp.retry'));
                    retryBtn.addEventListener('click', () => { void (async () => {
                        if (!mcpClient) return;
                        if (config.authType === 'oauth') await mcpClient.authorize(name, config);
                        else await mcpClient.connect(name, config);
                        renderList();
                    })(); });
                }
                const editBtn = actionsTd.createEl('button', { cls: 'agent-rules-edit-btn' });
                setIcon(editBtn, 'pencil');
                editBtn.setAttribute('aria-label', t('settings.mcp.edit'));
                editBtn.addEventListener('click', () => openAddModal(name, config, true));
                // Every server is user-owned now (nothing is force-seeded), so
                // all are deletable. A deleted curated connector stays findable
                // via the discovery search.
                const delBtn = actionsTd.createEl('button', { cls: 'agent-rules-delete-btn' });
                setIcon(delBtn, 'trash-2');
                delBtn.setAttribute('aria-label', t('settings.mcp.delete'));
                delBtn.addEventListener('click', () => { void (async () => {
                    if (mcpClient) await mcpClient.disconnect(name);
                    if (config.type === 'stdio') {
                        // FEAT-04-13: stdio servers (+ their trust) live in the device-local store.
                        this.plugin.deviceLocalStore?.removeStdioServer(name);
                    } else {
                        delete this.plugin.settings.mcpServers[name];
                    }
                    await this.plugin.saveSettings();
                    renderList();
                })(); });

                // Enable toggle: ON connects (running the OAuth flow when
                // needed), OFF disconnects. Both states persist to settings so
                // a manual disconnect survives reloads (config.disabled gates
                // connectAll on boot).
                const toggleTd = tr.createEl('td', { cls: 'agent-skill-toggle-cell' });
                const toggle = new ToggleComponent(toggleTd);
                toggle.toggleEl.addClass('agent-skill-toggle');
                toggle.setValue(!config.disabled);
                const isStdioRow = config.type === 'stdio';
                toggle.onChange((on) => { void (async () => {
                    if (on) {
                        config.disabled = false;
                        this.ensureServerActive(name);
                        // FEAT-04-13: persist stdio state to the device-local store
                        // (not synced settings); remote servers to settings.
                        if (isStdioRow) this.plugin.deviceLocalStore?.upsertStdioServer(name, config);
                        else await this.plugin.saveSettings();
                        if (mcpClient) {
                            // authorize() covers both cases: with stored tokens the
                            // SDK connects (refreshing as needed) without a browser
                            // round-trip; without tokens it opens the sign-in.
                            if (config.authType === 'oauth') await mcpClient.authorize(name, config);
                            else await mcpClient.connect(name, config);
                        }
                    } else {
                        if (mcpClient) await mcpClient.disconnect(name);
                        config.disabled = true;
                        if (isStdioRow) this.plugin.deviceLocalStore?.upsertStdioServer(name, config);
                        else await this.plugin.saveSettings();
                    }
                    renderList();
                })(); });
            }
        };

        const openAddModal = (editName?: string, editConfig?: import('../../types/settings').McpServerConfig, isEdit = false) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(editName ? t('settings.mcp.editServer', { name: editName }) : t('settings.mcp.addServerTitle'));
            const { contentEl } = modal;

            const nameInput = contentEl.createEl('input', { type: 'text', placeholder: t('settings.mcp.namePlaceholder'), cls: 'agent-mcp-modal-input' });
            nameInput.value = editName ?? '';
            if (editName) nameInput.disabled = true;

            // Secret values (header tokens, stdio env secrets) are never rendered
            // in clear text -- they show a fixed mask and are preserved on save
            // unless the user types a replacement. Length-independent, leaks nothing.
            const SECRET_MASK = '••••••';

            contentEl.createEl('label', { text: t('settings.mcp.labelType') });
            const typeSelect = contentEl.createEl('select', { cls: 'agent-mcp-modal-input' });
            // Intent-first labels instead of wire jargon (FEAT-04-13 Phase 0).
            // Values stay the protocol enum; only the visible text is plain.
            const typeOpts: Array<{ value: string; labelKey: string }> = [
                { value: 'streamable-http', labelKey: 'settings.mcp.typeRemoteHttp' },
                { value: 'sse', labelKey: 'settings.mcp.typeRemoteSse' },
            ];
            // FEAT-04-13 / ADR-168: stdio is Desktop-only (Node child_process).
            if (Platform.isDesktopApp) typeOpts.unshift({ value: 'stdio', labelKey: 'settings.mcp.typeLocal' });
            // Default to local on Desktop (the common case for a new connector),
            // else the remote HTTP transport. An edit keeps the stored type.
            const defaultType = editConfig?.type ?? (Platform.isDesktopApp ? 'stdio' : 'streamable-http');
            for (const opt of typeOpts) {
                const o = typeSelect.createEl('option', { text: t(opt.labelKey), value: opt.value });
                if (opt.value === defaultType) o.selected = true;
            }

            // ── Remote (sse/streamable-http): URL ────────────────────────────
            const urlLabel = contentEl.createEl('label', { text: t('settings.mcp.labelUrl') });
            const urlInput = contentEl.createEl('input', { type: 'text', placeholder: t('settings.mcp.urlPlaceholder'), cls: 'agent-mcp-modal-input' });
            urlInput.value = editConfig?.url ?? '';
            const urlHelp = contentEl.createDiv({ cls: 'agent-settings-desc', text: t('settings.mcp.urlHelp') });

            // ── Local (stdio): command + args + warning (FEAT-04-13) ─────────
            const cmdLabel = contentEl.createEl('label', { text: t('settings.mcp.labelCommand') });
            const commandInput = contentEl.createEl('input', { type: 'text', placeholder: t('settings.mcp.commandPlaceholder'), cls: 'agent-mcp-modal-input' });
            commandInput.value = editConfig?.command ?? '';
            const cmdHelp = contentEl.createDiv({ cls: 'agent-settings-desc', text: t('settings.mcp.commandHelp') });
            const argsLabel = contentEl.createEl('label', { text: t('settings.mcp.labelArgs') });
            const argsInput = contentEl.createEl('textarea', { cls: 'agent-mcp-modal-input' });
            argsInput.rows = 2;
            argsInput.placeholder = t('settings.mcp.argsPlaceholder');
            argsInput.value = joinArgsForDisplay(editConfig?.args ?? []);
            const argsHelp = contentEl.createDiv({ cls: 'agent-settings-desc', text: t('settings.mcp.argsHelp') });
            // Env vars, with secret values masked (FEAT-04-13). Secret-named
            // vars are stored encrypted and never re-rendered in cleartext,
            // mirroring the header-secret handling above.
            const envLabel = contentEl.createEl('label', { text: t('settings.mcp.labelEnv') });
            const envInput = contentEl.createEl('textarea', { cls: 'agent-mcp-modal-input' });
            envInput.rows = 3;
            envInput.placeholder = t('settings.mcp.envPlaceholder');
            const originalEnv = editConfig?.env ?? {};
            envInput.value = Object.entries(originalEnv)
                .map(([k, v]) => `${k}=${isSecretEnvName(k) && v ? SECRET_MASK : v}`)
                .join('\n');
            // Warning box: local process, no sandbox.
            const stdioWarn = contentEl.createDiv('vault-op-box vault-op-box--intro');
            const stdioWarnIcon = stdioWarn.createSpan({ cls: 'vault-op-box__icon' });
            setIcon(stdioWarnIcon, 'alert-triangle');
            const stdioWarnText = stdioWarn.createDiv({ cls: 'vault-op-box__text' });
            stdioWarnText.createEl('strong', { text: t('settings.mcp.stdioWarnTitle') });
            stdioWarnText.createDiv({ text: t('settings.mcp.stdioWarnBody') });
            stdioWarnText.createDiv({ cls: 'agent-settings-desc', text: t('settings.mcp.stdioSecretInEnvHint') });
            stdioWarnText.createDiv({ cls: 'agent-settings-desc', text: t('settings.mcp.stdioMvpBinaryHint') });

            // Secret header values are masked and preserved on save (same as
            // stdio env above; SECRET_MASK defined near the top of the modal).
            const isSecretHeaderName = (n: string): boolean =>
                /authorization|token|api[-_ ]?key|secret|bearer|cookie|password/i.test(n);
            const originalHeaders = editConfig?.headers ?? {};
            const headersLabel = contentEl.createEl('label', { text: t('settings.mcp.labelHeaders') });
            const headersInput = contentEl.createEl('textarea', { cls: 'agent-mcp-modal-input' });
            headersInput.rows = 3;
            headersInput.value = Object.entries(originalHeaders)
                .map(([k, v]) => `${k}=${isSecretHeaderName(k) && v ? SECRET_MASK : v}`)
                .join('\n');

            // Toggle which fields show, driven by the transport type. Remote
            // fields (URL/Headers) hide under a local server; local fields
            // (Command/Args/Env/warning) hide under a remote server. Declared
            // after Headers so its refs exist. Timeout stays for both.
            const applyTypeVisibility = () => {
                const isStdio = typeSelect.value === 'stdio';
                for (const el of [urlLabel, urlInput, urlHelp, headersLabel, headersInput]) {
                    el.toggleClass('agent-u-hidden', isStdio);
                }
                for (const el of [cmdLabel, commandInput, cmdHelp, argsLabel, argsInput, argsHelp, envLabel, envInput, stdioWarn]) {
                    el.toggleClass('agent-u-hidden', !isStdio);
                }
            };
            typeSelect.addEventListener('change', applyTypeVisibility);
            applyTypeVisibility();

            contentEl.createEl('label', { text: t('settings.mcp.labelTimeout') });
            const timeoutInput = contentEl.createEl('input', { type: 'number', placeholder: t('settings.mcp.timeoutPlaceholder'), cls: 'agent-mcp-modal-input' });
            timeoutInput.value = String(editConfig?.timeout ?? 60);

            // Advanced: the SSRF opt-in is only relevant for private-network
            // endpoints and confuses most users, so it hides behind a disclosure
            // (AUDIT-034 M-14 behaviour unchanged, #6a).
            let allowLocalUrls = editConfig?.allowLocalUrls === true;
            const adv = contentEl.createEl('details', { cls: 'agent-mcp-advanced' });
            adv.createEl('summary', { text: t('settings.mcp.advanced') });
            if (allowLocalUrls) adv.setAttribute('open', '');
            new Setting(adv)
                .setName(t('settings.mcp.allowLocalUrls'))
                .setDesc(t('settings.mcp.allowLocalUrlsDesc'))
                .addToggle((toggle) =>
                    toggle.setValue(allowLocalUrls).onChange((v) => {
                        allowLocalUrls = v;
                    }),
                );

            const saveBtn = contentEl.createEl('button', { text: t('settings.mcp.saveConnect'), cls: 'mod-cta agent-mcp-modal-save' });
            saveBtn.addEventListener('click', () => { void (async () => {
                const serverName = (editName ?? nameInput.value.trim());
                if (!serverName) return;

                // ── stdio path (FEAT-04-13 / ADR-168) ────────────────────────
                // Persisted to the device-local store (never synced), gated by a
                // per-device trust prompt before the first spawn.
                if (typeSelect.value === 'stdio') {
                    const store = this.plugin.deviceLocalStore;
                    if (!store) { new Notice(t('settings.mcp.stdioDesktopOnly')); return; }
                    const command = commandInput.value.trim();
                    if (!command) { new Notice(t('settings.mcp.labelCommand')); return; }
                    const args = parseShellArgs(argsInput.value);
                    // Parse KEY=value env. A masked secret keeps the stored
                    // (encrypted) value; a masked secret whose key was renamed
                    // can't be matched back, so abort rather than wipe it.
                    const env: Record<string, string> = {};
                    const originalEnvStored = editConfig?.env ?? {};
                    for (const line of envInput.value.split('\n')) {
                        const eq = line.indexOf('=');
                        if (eq <= 0) continue;
                        const k = line.slice(0, eq).trim();
                        const v = line.slice(eq + 1).trim();
                        if (!k) continue;
                        if (v === SECRET_MASK) {
                            if (k in originalEnvStored) { env[k] = originalEnvStored[k]; }
                            else { new Notice(t('notice.mcp.secretKeyRenamed')); return; }
                        } else {
                            env[k] = v;
                        }
                    }
                    const stdioConfig: import('../../types/settings').McpServerConfig = {
                        type: 'stdio', command, args,
                        ...(Object.keys(env).length ? { env } : {}),
                        timeout: parseInt(timeoutInput.value) || 60,
                        disabled: false,
                    };
                    // Warn once if a secret was typed while the keychain is down.
                    const hasSecretEnv = Object.keys(env).some((k) => isSecretEnvName(k));
                    if (hasSecretEnv && !this.plugin.safeStorage.isAvailable()) {
                        this.plugin.safeStorage.notifyPlaintextFallbackOnce(Notice, false);
                    }
                    store.upsertStdioServer(serverName, stdioConfig);
                    // Trust prompt: only a confirmation on THIS device permits spawning.
                    const trusted = await confirmModal(this.app, {
                        title: t('settings.mcp.stdioTrustTitle'),
                        message: t('settings.mcp.stdioTrustBody', { command }),
                        confirmLabel: t('settings.mcp.stdioTrustConfirm'),
                        cancelLabel: t('settings.mcp.cancel'),
                    });
                    if (trusted) {
                        // AUDIT 2026-07-26 M-16: bind the trust to the command
                        // line the user just confirmed, so a later edit re-asks.
                        store.grantTrust(serverName, stdioTrustFingerprint(stdioConfig));
                        this.ensureServerActive(serverName);
                        if (mcpClient) { await mcpClient.disconnect(serverName); await mcpClient.connect(serverName, stdioConfig); }
                    } else {
                        store.revokeTrust(serverName);
                        new Notice(t('notice.mcp.stdioTrustDenied'));
                    }
                    modal.close();
                    renderList();
                    return;
                }

                const type = typeSelect.value as 'sse' | 'streamable-http';
                const trimmedUrl = urlInput.value.trim();

                // AUDIT-034 M-14: validate the URL against the SSRF guard
                // before persisting. The per-server allowLocalUrls toggle opts
                // out for loopback / RFC 1918 hosts; everything else stays
                // protected by validateProviderUrl + the explicit local check.
                if (trimmedUrl) {
                    try {
                        const parsed = validateProviderUrl('custom', trimmedUrl, {
                            allowLocalhost: allowLocalUrls,
                        });
                        if (parsed && !allowLocalUrls) {
                            const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
                            if (isLocalHostname(host) || isPrivateIpHostname(host)) {
                                new Notice(t('notice.mcp.localUrlBlocked', { host: parsed.host }));
                                return;
                            }
                        }
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        new Notice(t('notice.mcp.invalidUrl', { message: msg }));
                        return;
                    }
                }

                const parseKV = (text: string): Record<string, string> => {
                    const result: Record<string, string> = {};
                    for (const line of text.split('\n')) { const eqIdx = line.indexOf('='); if (eqIdx > 0) result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim(); }
                    return result;
                };
                // Unmask: a value left at the mask keeps the stored secret; a
                // typed value replaces it. The secret never round-trips the DOM.
                // A masked value under a renamed key can't be matched back, so
                // abort rather than silently wipe the token to '' (data loss).
                const headers = parseKV(headersInput.value);
                for (const [k, v] of Object.entries(headers)) {
                    if (v !== SECRET_MASK) continue;
                    if (k in originalHeaders) { headers[k] = originalHeaders[k]; }
                    else { new Notice(t('notice.mcp.secretKeyRenamed')); return; }
                }
                // AUDIT 2026-07-26 M-4: does the edited URL stay in the scope the
                // stored credential was granted for? Same predicate the tool uses.
                const keepsCredentialScope = editConfig === undefined
                    || trimmedUrl === editConfig.url
                    || sameCredentialScope(editConfig.url, trimmedUrl);
                const newConfig: import('../../types/settings').McpServerConfig = {
                    type,
                    url: trimmedUrl,
                    headers,
                    timeout: parseInt(timeoutInput.value) || 60,
                    disabled: false,
                    ...(allowLocalUrls ? { allowLocalUrls: true } : {}),
                    ...(editConfig?.isBuiltIn ? { isBuiltIn: true } : {}),
                    // Preserve trust + identity + auth carried on the existing
                    // config. Official only survives if the endpoint is unchanged
                    // (editing the URL away from the vouched-for host drops it).
                    ...(editConfig?.official && trimmedUrl === editConfig.url ? { official: true } : {}),
                    ...(editConfig?.displayName ? { displayName: editConfig.displayName } : {}),
                    // AUDIT 2026-07-26 M-4: authType and oauth used to survive ANY
                    // edit, including one that moved the server to a different
                    // host. The `official` flag one line up already applies this
                    // reasoning to the trust badge; the actual session is worth
                    // more than the badge. Same scope rule as the tool path, so a
                    // person editing in settings and an agent calling update get
                    // the same answer.
                    ...(editConfig?.authType && keepsCredentialScope ? { authType: editConfig.authType } : {}),
                    ...(editConfig?.oauth && keepsCredentialScope ? { oauth: editConfig.oauth } : {}),
                };
                this.plugin.settings.mcpServers ??= {};
                this.plugin.settings.mcpServers[serverName] = newConfig;
                // Only a genuine add activates the server; a pure config edit
                // must not silently re-arm a user who turned MCP off or narrowed
                // the active set (IMP-04-10-02 remediation).
                if (!isEdit) this.ensureServerActive(serverName);
                await this.plugin.saveSettings();
                if (mcpClient) { await mcpClient.disconnect(serverName); await mcpClient.connect(serverName, newConfig); }
                modal.close();
                renderList();
            })(); });

            modal.open();
        };

        addBtn.addEventListener('click', () => openAddModal());
        if (mcpClient) {
            // FEAT-04-10: refresh the list when an OAuth flow completes async
            // (the obsidian:// redirect lands outside this render pass).
            mcpClient.setOAuthCallbacks({ onStatusChange: () => { if (listEl.isConnected) renderList(); } });
        }
        this.buildDiscoverSection(discoverEl, openAddModal, renderList);
        renderList();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Registry discovery (FEAT-04-11)
    // ─────────────────────────────────────────────────────────────────────────

    /** Session cache: search term -> accumulated pages. */
    private discoverCache = new Map<string, RegistrySearchPage[]>();
    /** Session cache: search term -> pinned featured official results. */
    private discoverFeatured = new Map<string, RegistryDiscoveryResult[]>();

    /**
     * Carry the discovery result's trust + friendly-name onto the persisted
     * config so the server list keeps showing "Official" and "GitHub" after the
     * add, instead of "User" and the reverse-DNS key (IMP-04-10-02 #3/#5).
     */
    private stampDiscoveryMeta(
        config: import('../../types/settings').McpServerConfig,
        r: RegistryDiscoveryResult,
    ): void {
        if (r.official) config.official = true;
        if (r.displayName && r.displayName !== r.key) config.displayName = r.displayName;
    }

    /**
     * Make a freshly added/enabled server usable at once (single source of
     * truth: mcpActivation). No-op when all-active; appends to a narrowed
     * list; and if MCP was globally off, activates just this server so the
     * add does not silently re-enable the rest (IMP-04-10-02 #4).
     */
    private ensureServerActive(name: string): void {
        // FEAT-04-12: enabling a server in settings makes it usable in every
        // agent (explicit user expectation), including agents that narrowed
        // their list; agents on the all-active default cover it already.
        activateMcpServerForAllModes(this.plugin.settings, name);
    }

    private buildDiscoverSection(
        root: HTMLElement,
        openAddModal: (name?: string, config?: import('../../types/settings').McpServerConfig) => void,
        renderServerList: () => void,
    ): void {
        addSectionHeading(root, t('settings.mcp.discover.title'), { body: t('settings.mcp.discover.info') }, { level: 'h4' });

        const row = root.createDiv({ cls: 'agent-mcp-discover-row' });
        const input = row.createEl('input', {
            type: 'text',
            placeholder: t('settings.mcp.discover.placeholder'),
            cls: 'agent-mcp-discover-input',
        });
        const searchBtn = row.createEl('button', { text: t('settings.mcp.discover.search'), cls: 'mod-cta' });
        const statusEl = root.createDiv({ cls: 'agent-settings-desc' });
        const resultsEl = root.createDiv();

        const existingKeys = (): Set<string> => new Set(Object.keys(this.plugin.settings.mcpServers ?? {}));

        // Obsidian transport injected here: registryDiscovery must stay free of
        // obsidian imports (a dynamic import('obsidian') survives the CJS
        // bundle as a native dynamic import and fails in the renderer).
        const registryFetcher = async (url: string): Promise<unknown> => {
            const res = await requestUrl({ url, throw: false });
            if (res.status >= 400) throw new Error(`Registry request failed (HTTP ${res.status})`);
            return res.json as unknown;
        };

        const norm = (u: string): string => u.toLowerCase().replace(/\/+$/, '');
        const existingUrlSet = (): Set<string> => new Set(
            Object.values(this.plugin.settings.mcpServers ?? {})
                .map((s) => (s.url ? norm(s.url) : ''))
                .filter(Boolean),
        );

        // Curated catalog (Official) first, then pinned featured servers, then
        // paged registry results. Deduped by key AND endpoint so a registry
        // entry that duplicates a catalog server (e.g. Notion) is folded away.
        // An empty term yields the full catalog -- the "popular" default.
        const mergedResults = (term: string): RegistryDiscoveryResult[] => {
            const existingUrls = existingUrlSet();
            const catalog = catalogDiscoveryResults(term, existingUrls);
            const featured = this.discoverFeatured.get(term) ?? [];
            const paged = (this.discoverCache.get(term) ?? []).flatMap((p) => p.results);
            const seen = new Set<string>();
            const seenUrls = new Set<string>();
            const out: RegistryDiscoveryResult[] = [];
            for (const r of [...catalog, ...featured, ...paged]) {
                const u = norm(r.url);
                if (seen.has(r.key) || seenUrls.has(u)) continue;
                seen.add(r.key);
                seenUrls.add(u);
                out.push(r);
            }
            return out;
        };

        const fetchFeatured = async (term: string): Promise<RegistryDiscoveryResult[]> => {
            const names = featuredNamesForTerm(term);
            const fetched = await Promise.all(names.map((nm) =>
                fetchRegistryEntry(nm, { existingKeys: existingKeys(), fetcher: registryFetcher }).catch(() => null),
            ));
            return fetched.filter((r): r is RegistryDiscoveryResult => r !== null);
        };

        const renderResults = (term: string): void => {
            resultsEl.empty();
            // No search term: keep the area clean. Curated connectors are found
            // by searching, not shown as a default list (they only appear in the
            // server list above once added).
            if (!term.trim()) { statusEl.setText(''); return; }
            const pages = this.discoverCache.get(term) ?? [];
            const results = mergedResults(term);
            const lastCursor = pages.at(-1)?.nextCursor;
            if (results.length === 0) {
                // Still offer paging: a page can be 100% package-only entries.
                if (lastCursor) {
                    const moreBtn = resultsEl.createEl('button', { text: t('settings.mcp.discover.loadMore'), cls: 'agent-mcp-discover-more' });
                    moreBtn.addEventListener('click', () => { void runSearch(term, lastCursor); });
                }
                return;
            }

            const table = resultsEl.createDiv('agent-table-box').createEl('table', { cls: 'agent-skill-table agent-mcp-table agent-mcp-discover-table' });
            const thead = table.createEl('thead');
            const hr = thead.createEl('tr');
            hr.createEl('th', { text: t('settings.mcp.headerServer') });
            const pubTh = hr.createEl('th', { cls: 'agent-mcp-th-publisher' });
            pubTh.appendText(t('settings.mcp.discover.headerPublisher'));
            const pubInfo = pubTh.createEl('button', {
                cls: 'agent-info-btn',
                attr: { type: 'button', 'aria-label': t('settings.mcp.discover.headerPublisher') },
            });
            setIcon(pubInfo, 'info');
            pubInfo.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openInfoPopover(t('settings.mcp.discover.headerPublisher'), t('settings.mcp.discover.publisherHeaderInfo'));
            });
            hr.createEl('th', { text: '', cls: 'agent-mcp-th-actions' });
            const tbody = table.createEl('tbody');

            const configured = existingKeys();
            const existingUrls = existingUrlSet();
            for (const r of results) {
                const tr = tbody.createEl('tr');
                const nameTd = tr.createEl('td', { cls: 'agent-skill-name-cell' });
                nameTd.createDiv({ text: r.displayName, cls: 'agent-skill-name' });
                if (r.description) nameTd.createDiv({ text: r.description, cls: 'agent-skill-desc agent-skill-desc-clamped' });
                // stdio catalog entries have no endpoint URL; show that they run
                // locally instead of crashing on new URL('') (FEAT-04-13).
                nameTd.createDiv({ text: r.catalogKind === 'stdio' ? t('settings.mcp.typeLocal') : safeHostname(r.url), cls: 'agent-skill-desc' });

                // Publisher column communicates the TRUST TIER, not the host:
                // domain-verified > account-verified > unverified. The identity
                // (domain / @handle) lives in the tooltip and the details view.
                const sourceTd = tr.createEl('td', { cls: 'agent-skill-cmd-cell' });
                const pill = sourceTd.createSpan({ cls: 'agent-skill-source-badge' });
                if (r.official) {
                    pill.setText(t('settings.mcp.discover.trustOfficial'));
                    pill.addClass('agent-skill-source-builtin');
                    pill.setAttribute('title', t('settings.mcp.discover.trustOfficialTip'));
                } else if (r.verification === 'domain') {
                    pill.setText(t('settings.mcp.discover.trustDomain'));
                    pill.addClass('agent-skill-source-agent');
                    pill.setAttribute('title', `${r.publisher ?? ''}: ${t('settings.mcp.discover.publisherDomainTip')}`);
                } else if (r.verification === 'github') {
                    pill.setText(t('settings.mcp.discover.trustGithub'));
                    pill.addClass('agent-skill-source-user');
                    pill.setAttribute('title', `${r.publisher ?? ''}: ${t('settings.mcp.discover.publisherGithubTip')}`);
                } else {
                    pill.setText(t('settings.mcp.discover.unverified'));
                    pill.addClass('agent-mcp-trust-none');
                    pill.setAttribute('title', t('settings.mcp.discover.trustNoneTip'));
                }

                const actionTd = tr.createEl('td', { cls: 'agent-mcp-discover-action' });
                if (r.alreadyAdded || configured.has(r.key) || existingUrls.has(norm(r.url))) {
                    actionTd.createSpan({ cls: 'agent-skill-desc', text: t('settings.mcp.discover.added') });
                } else {
                    // Details first: the modal shows everything (publisher, links,
                    // warnings) and carries the actual Add action.
                    const detailsBtn = actionTd.createEl('button', { text: t('settings.mcp.discover.details') });
                    detailsBtn.addEventListener('click', () => this.openDiscoverConfirm(r, openAddModal, () => {
                        renderServerList();
                        renderResults(term);
                    }));
                }
            }

            if (lastCursor) {
                const moreBtn = resultsEl.createEl('button', { text: t('settings.mcp.discover.loadMore'), cls: 'agent-mcp-discover-more' });
                moreBtn.addEventListener('click', () => { void runSearch(term, lastCursor); });
            }
        };

        let inFlight = false;
        const runSearch = async (term: string, cursor?: string): Promise<void> => {
            if (inFlight) return;
            const trimmed = term.trim();
            if (trimmed.length < 2) return;
            if (!cursor && this.discoverCache.has(trimmed)) {
                statusEl.setText('');
                renderResults(trimmed);
                return;
            }
            inFlight = true;
            searchBtn.disabled = true;
            statusEl.setText(t('settings.mcp.discover.searching'));
            try {
                // On a fresh search, fetch the pinned featured servers in
                // parallel with the paged search (both hit the slow registry).
                const [page, featured] = await Promise.all([
                    searchMcpRegistry(trimmed, { existingKeys: existingKeys(), cursor, fetcher: registryFetcher }),
                    cursor ? Promise.resolve(this.discoverFeatured.get(trimmed) ?? []) : fetchFeatured(trimmed),
                ]);
                if (!cursor) this.discoverFeatured.set(trimmed, featured);
                const pages = cursor ? (this.discoverCache.get(trimmed) ?? []) : [];
                pages.push(page);
                this.discoverCache.set(trimmed, pages);
                const found = mergedResults(trimmed).length;
                const seen = pages.reduce((n, p) => n + p.totalSeen, 0);
                const hasMore = !!pages.at(-1)?.nextCursor;
                if (found === 0 && !hasMore) {
                    statusEl.setText(t('settings.mcp.discover.empty', { term: trimmed }));
                } else {
                    // Honest yield report: the registry search matches by name
                    // and most entries are package-only, so say what was hidden.
                    statusEl.setText(t('settings.mcp.discover.stats', {
                        found: String(found),
                        hidden: String(Math.max(0, seen - found)),
                    }));
                }
                renderResults(trimmed);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                statusEl.setText(t('settings.mcp.discover.error', { message: msg }));
            } finally {
                inFlight = false;
                searchBtn.disabled = false;
            }
        };

        searchBtn.addEventListener('click', () => { void runSearch(input.value); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); void runSearch(input.value); }
        });
        // Clearing the box clears the results (curated connectors are found by
        // searching, not shown as a default list).
        input.addEventListener('input', () => { if (!input.value.trim()) renderResults(''); });
    }

    /** Trust confirmation before a discovery result becomes a user server. */
    private openDiscoverConfirm(
        r: RegistryDiscoveryResult,
        openAddModal: (name?: string, config?: import('../../types/settings').McpServerConfig) => void,
        onAdded: () => void,
    ): void {
        const isStdioEntry = r.catalogKind === 'stdio';
        // stdio entries always run the guided setup (they need a PAT + org).
        const needsSecret = isStdioEntry || r.requiredSecretHeaders.length > 0;
        const guide = needsSecret ? findSetupGuide({ registryName: r.registryName, url: r.url }) : undefined;

        const modal = new Modal(this.app);
        modal.titleEl.setText(t('settings.mcp.discover.confirmTitle', { name: r.displayName }));
        const c = modal.contentEl;

        if (r.description) c.createEl('p', { cls: 'agent-mcp-detail-desc', text: r.description });

        // One consistent label/value grid (single type size, aligned columns).
        const grid = c.createDiv({ cls: 'agent-mcp-detail-grid' });
        const fact = (label: string, value: string): void => {
            grid.createDiv({ cls: 'agent-mcp-detail-label', text: label });
            grid.createDiv({ cls: 'agent-mcp-detail-value', text: value });
        };
        // The registry name is a reverse-DNS identifier only meaningful for
        // registry entries; a curated catalog id ("plaud") reads as noise.
        if (!getCatalogEntry(r.key)) fact(t('settings.mcp.discover.confirmName'), r.registryName);
        // stdio entries have no endpoint host; show that it runs locally.
        fact(t('settings.mcp.discover.confirmEndpoint'),
            isStdioEntry ? t('settings.mcp.typeLocal') : safeHostname(r.url));
        fact(t('settings.mcp.discover.confirmPublisher'),
            r.official
                ? t('settings.mcp.discover.trustOfficial')
                : r.verification === 'domain'
                    ? `${r.publisher} (${t('settings.mcp.discover.verifiedDomain')})`
                    : r.verification === 'github'
                        ? `${r.publisher} (${t('settings.mcp.discover.verifiedGithub')})`
                        : t('settings.mcp.discover.unverified'));

        if (r.brandWarning) {
            c.createEl('p', { cls: 'agent-mcp-discover-warn', text: t('settings.mcp.discover.brandWarn', { brand: r.brandWarning }) });
        }
        if (r.hostMismatch) {
            c.createEl('p', { cls: 'agent-mcp-discover-warn', text: t('settings.mcp.discover.hostWarn') });
        }

        // Multi-step clarity: say what the NEXT step will be after adding.
        c.createEl('p', {
            cls: 'agent-mcp-detail-next',
            text: needsSecret ? t('settings.mcp.discover.nextToken') : t('settings.mcp.discover.nextConnect'),
        });

        // Secondary reference links at the bottom, documentation first (helpful
        // to non-technical users), source code second and de-emphasised.
        if (r.websiteUrl || r.repositoryUrl) {
            const links = c.createDiv({ cls: 'agent-mcp-discover-links' });
            if (r.websiteUrl) links.createEl('a', { text: t('settings.mcp.discover.linkWebsite'), href: r.websiteUrl });
            if (r.repositoryUrl) links.createEl('a', { cls: 'agent-mcp-link-secondary', text: t('settings.mcp.discover.linkRepository'), href: r.repositoryUrl });
        }

        const btns = c.createDiv({ cls: 'agent-prompt-form-btns' });
        const addBtn = btns.createEl('button', {
            text: needsSecret ? t('settings.mcp.discover.continue') : t('settings.mcp.discover.add'),
            cls: 'mod-cta',
        });
        const cancelBtn = btns.createEl('button', { text: t('settings.mcp.discover.cancel') });
        cancelBtn.addEventListener('click', () => modal.close());
        addBtn.addEventListener('click', () => {
            // stdio catalog entry: run the guided stdio setup (org + PAT ->
            // device-local store + trust), never the url add.
            if (isStdioEntry && guide) {
                const spec = this.buildStdioTokenSpec(r.key, r.displayName, guide);
                modal.close();
                if (spec) { this.openTokenSetup(spec, onAdded); return; }
                new Notice(t('settings.mcp.stdioDesktopOnly'));
                return;
            }
            if (needsSecret) {
                const spec = this.buildTokenSpec(r, guide);
                modal.close();
                if (spec) { this.openTokenSetup(spec, onAdded); return; }
                // Multi-secret server: fall back to the raw header editor.
                void (async () => {
                    const config: import('../../types/settings').McpServerConfig = {
                        type: r.transport, url: r.url, timeout: 60, disabled: true,
                        headers: Object.fromEntries(r.requiredSecretHeaders.map((h) => [h, ''])),
                    };
                    this.stampDiscoveryMeta(config, r);
                    this.plugin.settings.mcpServers ??= {};
                    this.plugin.settings.mcpServers[r.key] = config;
                    await this.plugin.saveSettings();
                    openAddModal(r.key, config);
                    onAdded();
                })();
                return;
            }
            // No secret header. Catalog connectors materialize with their known
            // auth class (no-auth stays open, OAuth-DCR gets authType oauth);
            // registry entries default to oauth so the toggle runs the browser
            // flow when the endpoint demands it (open servers just connect).
            void (async () => {
                const config: import('../../types/settings').McpServerConfig =
                    catalogConfigForAdd(r.key) ?? {
                        type: r.transport, url: r.url, timeout: 60, disabled: true, authType: 'oauth' as const,
                    };
                this.stampDiscoveryMeta(config, r);
                this.plugin.settings.mcpServers ??= {};
                this.plugin.settings.mcpServers[r.key] = config;
                this.ensureServerActive(r.key);
                await this.plugin.saveSettings();
                modal.close();
                onAdded();
            })();
        });

        modal.open();
    }

    /**
     * Build the token-setup spec for a server that needs a secret header. Uses
     * a curated guide (pre-scoped link + steps) when available; otherwise a
     * generic spec built from the registry's own header description + website.
     * Returns null only for multi-secret servers (rare) -> raw editor fallback.
     */
    private buildTokenSpec(r: RegistryDiscoveryResult, guide: ConnectorSetupGuide | undefined): TokenSetupSpec | null {
        const base = {
            serverKey: r.key,
            displayName: r.displayName,
            config: (() => {
                const cfg: import('../../types/settings').McpServerConfig = { type: r.transport, url: r.url, timeout: 60, disabled: true };
                this.stampDiscoveryMeta(cfg, r);
                return cfg;
            })(),
        };
        if (guide) {
            return {
                ...base,
                credentialLabel: guide.credentialName,
                createUrl: guide.createUrl,
                createLabel: t('settings.mcp.setup.getToken'),
                scopeHint: guide.scopeHint,
                target: guide.target ?? 'header',
                headerName: guide.headerName ?? 'Authorization',
                bearer: guide.bearer ?? true,
                envName: guide.envName,
                fields: guide.fields,
                steps: guide.steps,
            };
        }
        const sh = r.secretHeaders[0];
        if (!sh || r.requiredSecretHeaders.length > 1) return null;
        return {
            ...base,
            credentialLabel: t('settings.mcp.setup.genericCredential'),
            createUrl: r.websiteUrl ?? r.repositoryUrl ?? undefined,
            createLabel: t('settings.mcp.setup.openProvider'),
            hintText: sh.description || undefined,
            target: 'header',
            headerName: sh.name,
            // Authorization headers conventionally carry a Bearer token; other
            // header names (X-Api-Key, ...) take the raw value.
            bearer: sh.name.toLowerCase() === 'authorization',
            steps: [],
        };
    }

    /**
     * Build a stdio setup spec directly from a curated guide (FEAT-04-13
     * Phase 2 entry point). The config is a stdio shell; command/args come from
     * the guide, positional field values are appended at save, the secret goes
     * into config.env[envName]. displayName/serverKey are the catalog id.
     */
    private buildStdioTokenSpec(serverKey: string, displayName: string, guide: ConnectorSetupGuide): TokenSetupSpec | null {
        if (guide.target !== 'env' || !guide.command || !guide.envName) return null;
        return {
            serverKey,
            displayName,
            config: { type: 'stdio', command: guide.command, args: [...(guide.args ?? [])], timeout: 60, disabled: true },
            credentialLabel: guide.credentialName,
            createUrl: guide.createUrl,
            createLabel: t('settings.mcp.setup.getToken'),
            scopeHint: guide.scopeHint,
            target: 'env',
            headerName: '',
            bearer: false,
            envName: guide.envName,
            fields: guide.fields,
            steps: guide.steps,
        };
    }

    /**
     * Guided credential setup for a token-based connector (FEAT-04-11). Tells a
     * non-technical user which credential is needed, links to where to get it,
     * and takes a single paste. The value lands in the configured header
     * (encrypted at rest) and the server connects.
     */
    private openTokenSetup(spec: TokenSetupSpec, onDone: () => void): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('settings.mcp.setup.title', { name: spec.displayName }));
        const c = modal.contentEl;
        c.createEl('p', { cls: 'agent-mcp-detail-desc', text: t('settings.mcp.setup.intro', { credential: spec.credentialLabel }) });
        if (spec.scopeHint) c.createEl('p', { cls: 'agent-settings-desc', text: t('settings.mcp.setup.scope', { scope: spec.scopeHint }) });
        if (spec.hintText) c.createEl('p', { cls: 'agent-settings-desc', text: spec.hintText });
        if (spec.steps.length) {
            const ol = c.createEl('ol', { cls: 'agent-mcp-setup-steps' });
            for (const step of spec.steps) ol.createEl('li', { text: step });
        }
        // Non-secret inputs first (e.g. the org), each with its own hint line.
        const fieldInputs: Array<{ key: string; appendToArgs: boolean; el: HTMLInputElement }> = [];
        for (const f of spec.fields ?? []) {
            c.createEl('label', { text: f.label });
            const fi = c.createEl('input', { type: 'text', cls: 'agent-mcp-modal-input', placeholder: f.placeholder ?? '' });
            c.createDiv({ cls: 'agent-settings-desc', text: f.hint });
            fieldInputs.push({ key: f.key, appendToArgs: f.appendToArgs === true, el: fi });
        }

        // External anchor: Obsidian opens https links in the system browser.
        if (spec.createUrl) c.createEl('a', { cls: 'mod-cta agent-mcp-setup-get', text: spec.createLabel, href: spec.createUrl });

        const input = c.createEl('input', {
            type: 'password',
            cls: 'agent-mcp-modal-input',
            placeholder: t('settings.mcp.setup.placeholder'),
        });

        const btns = c.createDiv({ cls: 'agent-prompt-form-btns' });
        const saveBtn = btns.createEl('button', { cls: 'mod-cta', text: t('settings.mcp.setup.saveConnect') });
        const cancelBtn = btns.createEl('button', { text: t('settings.mcp.discover.cancel') });
        cancelBtn.addEventListener('click', () => modal.close());
        saveBtn.addEventListener('click', () => { void (async () => {
            const token = input.value.trim();
            if (!token) { new Notice(t('settings.mcp.setup.tokenMissing')); return; }
            // Require every declared non-secret field.
            for (const fi of fieldInputs) {
                if (!fi.el.value.trim()) { new Notice(t('settings.mcp.setup.fieldMissing')); return; }
            }
            const config = spec.config;

            if (spec.target === 'env') {
                // Local stdio: append positional field values (e.g. org) to
                // args, put the secret in env, persist to the device-local
                // store, and gate the spawn behind the per-device trust prompt.
                const store = this.plugin.deviceLocalStore;
                if (!store) { new Notice(t('settings.mcp.stdioDesktopOnly')); return; }
                config.args = [...(config.args ?? [])];
                for (const fi of fieldInputs) {
                    if (fi.appendToArgs) config.args.push(fi.el.value.trim());
                }
                config.env = { ...(config.env ?? {}), [spec.envName ?? 'TOKEN']: token };
                config.disabled = false;
                store.upsertStdioServer(spec.serverKey, config);
                const trusted = await confirmModal(this.app, {
                    title: t('settings.mcp.stdioTrustTitle'),
                    message: t('settings.mcp.stdioTrustBody', { command: config.command ?? '' }),
                    confirmLabel: t('settings.mcp.stdioTrustConfirm'),
                    cancelLabel: t('settings.mcp.cancel'),
                });
                if (trusted) {
                    store.grantTrust(spec.serverKey, stdioTrustFingerprint(config));
                    this.ensureServerActive(spec.serverKey);
                    if (this.plugin.mcpClient) { await this.plugin.mcpClient.disconnect(spec.serverKey); await this.plugin.mcpClient.connect(spec.serverKey, config); }
                } else {
                    store.revokeTrust(spec.serverKey);
                    new Notice(t('notice.mcp.stdioTrustDenied'));
                }
                modal.close();
                onDone();
                return;
            }

            // Remote HTTP: secret into a request header, persist to synced settings.
            config.headers = { ...(config.headers ?? {}), [spec.headerName]: spec.bearer ? `Bearer ${token}` : token };
            config.disabled = false;
            this.plugin.settings.mcpServers ??= {};
            this.plugin.settings.mcpServers[spec.serverKey] = config;
            this.ensureServerActive(spec.serverKey);
            await this.plugin.saveSettings();
            if (this.plugin.mcpClient) await this.plugin.mcpClient.connect(spec.serverKey, config);
            modal.close();
            onDone();
        })(); });

        modal.open();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Local connection details (copy-paste config for HTTP MCP clients)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Scrollable list of a connected server's tools with their descriptions.
     * Opened by clicking the tool count in the server list.
     */
    private openToolListModal(serverName: string, tools: Array<{ name: string; description?: string }>): void {
        const modal = new Modal(this.app);
        modal.titleEl.setText(t('settings.mcp.toolListTitle', { name: serverName, count: tools.length }));
        const list = modal.contentEl.createDiv({ cls: 'agent-mcp-tool-list' });
        for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
            const row = list.createDiv({ cls: 'agent-mcp-tool-row' });
            row.createDiv({ text: tool.name, cls: 'agent-mcp-tool-name' });
            if (tool.description) row.createDiv({ text: tool.description, cls: 'agent-mcp-tool-desc' });
        }
        modal.open();
    }

    /**
     * Renders the copy-paste values a local MCP client (e.g. Cursor) needs to
     * reach this vault over loopback HTTP: the URL, the auth token, and the
     * ready-made Authorization header. No relay, no Cloudflare.
     */
    private buildLocalConnectionDetails(containerEl: HTMLElement): void {
        const url = `http://127.0.0.1:${MCP_LOCAL_PORT}`;
        const token = this.plugin.settings.mcpServerToken ?? '';

        // Intro banner
        const box = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const boxIcon = box.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(boxIcon, 'plug');
        const boxText = box.createDiv({ cls: 'vault-op-box__text' });
        boxText.createEl('strong', { text: t('settings.mcp.localConnDetailsTitle') });
        boxText.createDiv({ text: t('settings.mcp.localConnDetailsIntro') });

        // URL (not secret)
        new Setting(containerEl)
            .setName(t('settings.mcp.localUrlLabel'))
            .setDesc(t('settings.mcp.localUrlDesc'))
            .addText((text) => {
                text.setValue(url);
                text.inputEl.readOnly = true;
                text.inputEl.addClass('agent-mono-input');
            })
            .addButton((btn) => {
                btn.setButtonText(t('settings.mcp.copyUrlButton')).onClick(() => {
                    void navigator.clipboard.writeText(url);
                    new Notice(t('notice.mcp.urlCopied'));
                });
            });

        // Auth token (secret, masked with reveal toggle)
        const tokenSetting = new Setting(containerEl)
            .setName(t('settings.mcp.localTokenLabel'))
            .setDesc(t('settings.mcp.localTokenDesc'));
        let tokenInput: HTMLInputElement | null = null;
        tokenSetting.addText((text) => {
            text.setValue(token);
            text.inputEl.readOnly = true;
            text.inputEl.type = 'password';
            text.inputEl.addClass('agent-mono-input');
            tokenInput = text.inputEl;
        });
        tokenSetting.addExtraButton((btn) => {
            btn.setIcon('eye').setTooltip(t('settings.mcp.revealSecret')).onClick(() => {
                if (!tokenInput) return;
                const revealed = tokenInput.type === 'text';
                tokenInput.type = revealed ? 'password' : 'text';
                btn.setIcon(revealed ? 'eye' : 'eye-off');
                btn.setTooltip(revealed ? t('settings.mcp.revealSecret') : t('settings.mcp.hideSecret'));
            });
        });
        tokenSetting.addButton((btn) => {
            btn.setButtonText(t('settings.mcp.copyTokenButton')).onClick(() => {
                void navigator.clipboard.writeText(this.plugin.settings.mcpServerToken ?? '');
                new Notice(t('notice.mcp.tokenCopied'));
            });
        });

        // Ready-made Authorization header (secret; convenience for clients that
        // take a full header line, or a header value, instead of a bare token)
        new Setting(containerEl)
            .setName(t('settings.mcp.localAuthHeaderLabel'))
            .setDesc(t('settings.mcp.localAuthHeaderDesc'))
            // IMP-14-04-01: a client that splits a custom header into a name
            // field and a value field needs the middle piece. The two existing
            // buttons hand out the ends only: the naked token loses the scheme
            // (the bridge answers 401, wrong-scheme), the full line carries
            // "Authorization:" into the value field. Neither is pasteable
            // there, and the value was reachable only by editing the clipboard
            // by hand.
            .addButton((btn) => {
                btn.setButtonText(t('settings.mcp.copyHeaderValueButton')).onClick(() => {
                    void navigator.clipboard.writeText(`Bearer ${this.plugin.settings.mcpServerToken ?? ''}`);
                    new Notice(t('notice.mcp.headerValueCopied'));
                });
            })
            .addButton((btn) => {
                btn.setButtonText(t('settings.mcp.copyHeaderButton')).onClick(() => {
                    void navigator.clipboard.writeText(`Authorization: Bearer ${this.plugin.settings.mcpServerToken ?? ''}`);
                    new Notice(t('notice.mcp.headerCopied'));
                });
            });

        // IMP-14-04-01: which of the three values goes where. The Bearer prefix
        // sitting in the value and not in the name is the part that gets typed
        // wrong, and the 401 that follows names the scheme, not the field.
        const headerValueHint = containerEl.createDiv('setting-item-description');
        headerValueHint.appendText(t('settings.mcp.localAuthHeaderValueHint'));

        // Client hint (header allowlist gotcha)
        const hint = containerEl.createDiv('setting-item-description');
        hint.appendText(t('settings.mcp.localClientHint'));

        // Rotate token
        new Setting(containerEl)
            .setName(t('settings.mcp.rotateTokenButton'))
            .addButton((btn) => {
                applyDestructiveStyle(btn);
                btn.setButtonText(t('settings.mcp.rotateTokenButton')).onClick(async () => {
                    const ok = await confirmModal(this.app, {
                        title: t('settings.mcp.rotateTokenConfirmTitle'),
                        message: t('settings.mcp.rotateTokenConfirm'),
                        confirmLabel: t('settings.mcp.rotateTokenButton'),
                        cancelLabel: t('settings.mcp.cancel'),
                    });
                    if (!ok) return;
                    this.plugin.settings.mcpServerToken = crypto.randomUUID();
                    await this.plugin.saveSettings();
                    // Restart the bridge so the new token is written to the
                    // well-known file and enforced on the listener immediately.
                    if (this.plugin.mcpBridge) {
                        this.plugin.mcpBridge.stop();
                        void this.plugin.mcpBridge.start().catch((e: unknown) =>
                            console.warn('[McpTab] Restart after rotate failed:', e)
                        );
                    }
                    new Notice(t('notice.mcp.tokenRotated'));
                    this.rerender();
                });
            });
    }

    /**
     * Renders the copy-paste values a local MCP client needs to reach this
     * vault over a stdio proxy: the Node.js command and the single argument
     * (the bundled proxy script path). This is the fallback for clients whose
     * HTTP connector only offers OAuth (Vault Operator speaks a static Bearer
     * token, not OAuth), so the HTTP path above is a dead end for them.
     *
     * The two values are exactly what writeClaudeDesktopConfig() writes into a
     * client config file, surfaced here so a user can paste them by hand into a
     * client that has no config file to write.
     */
    private buildStdioConnectionDetails(containerEl: HTMLElement): void {
        // findNodePath()/getWorkerPath() can throw (no FileSystemAdapter, worker
        // materialisation failure). Resolve first; on failure show a short notice
        // instead of crashing the whole settings render.
        let command: string;
        let argument: string;
        try {
            command = this.findNodePath();
            argument = this.getWorkerPath();
        } catch {
            const box = containerEl.createDiv('vault-op-box vault-op-box--warning');
            const boxIcon = box.createSpan({ cls: 'vault-op-box__icon' });
            setIcon(boxIcon, 'alert-triangle');
            box.createDiv({ cls: 'vault-op-box__text', text: t('settings.mcp.stdioConnUnavailable') });
            return;
        }

        // Intro banner
        const box = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const boxIcon = box.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(boxIcon, 'terminal');
        const boxText = box.createDiv({ cls: 'vault-op-box__text' });
        boxText.createEl('strong', { text: t('settings.mcp.stdioConnDetailsTitle') });
        boxText.createDiv({ text: t('settings.mcp.stdioConnDetailsIntro') });

        // Command (node binary path; not secret)
        new Setting(containerEl)
            .setName(t('settings.mcp.stdioCommandLabel'))
            .setDesc(t('settings.mcp.stdioCommandDesc'))
            .addText((text) => {
                text.setValue(command);
                text.inputEl.readOnly = true;
                text.inputEl.addClass('agent-mono-input');
            })
            .addButton((btn) => {
                btn.setButtonText(t('settings.mcp.copyCommandButton')).onClick(() => {
                    void navigator.clipboard.writeText(command);
                    new Notice(t('notice.mcp.commandCopied'));
                });
            });

        // Arguments (proxy script path; not secret)
        new Setting(containerEl)
            .setName(t('settings.mcp.stdioArgsLabel'))
            .setDesc(t('settings.mcp.stdioArgsDesc'))
            .addText((text) => {
                text.setValue(argument);
                text.inputEl.readOnly = true;
                text.inputEl.addClass('agent-mono-input');
            })
            .addButton((btn) => {
                btn.setButtonText(t('settings.mcp.copyArgsButton')).onClick(() => {
                    void navigator.clipboard.writeText(argument);
                    new Notice(t('notice.mcp.argsCopied'));
                });
            });

        // Client hint (the sandboxed-HOME timeout gotcha)
        const hint = containerEl.createDiv('setting-item-description');
        hint.appendText(t('settings.mcp.stdioConnClientHint'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Claude Desktop Config
    // ─────────────────────────────────────────────────────────────────────────

    private writeClaudeDesktopConfig(): void {
        try {
            const platform = os.platform();
            let configDir: string;
            if (platform === 'darwin') configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
            else if (platform === 'win32') configDir = path.join(readEnv(ENV_APPDATA) ?? os.homedir(), 'Claude');
            else configDir = path.join(os.homedir(), '.config', 'Claude');

            const configPath = path.join(configDir, 'claude_desktop_config.json');
            let config: Record<string, unknown> = {};
            try { config = JSON.parse(safeFs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>; } catch { /* new file */ }

            const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
            servers['Vault Operator'] = { command: this.findNodePath(), args: [this.getWorkerPath()] };
            config['mcpServers'] = servers;

            safeFs.mkdirSync(configDir, { recursive: true });
            safeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
            new Notice(t('notice.mcp.desktopConfigSaved'));
        } catch (e) {
            new Notice(t('notice.mcp.desktopConfigFailed', { message: e instanceof Error ? e.message : String(e) }));
        }
    }

    private getWorkerPath(): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- runtimeWorker uses fs which is only available via dynamic require in Electron renderer
        const runtimeWorkerMod = require('../../core/utils/runtimeWorker') as { ensureRuntimeWorker: (plugin: unknown, name: string, code: string) => string };
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- inlined bundle file generated by esbuild
        const bundledWorkers = require('../../_generated/bundled-workers') as { MCP_WORKER_CODE: string };
        return runtimeWorkerMod.ensureRuntimeWorker(this.plugin, 'mcp-server-worker.js', bundledWorkers.MCP_WORKER_CODE);
    }

    private findNodePath(): string {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const candidates: string[] = [];
        try {
            const result = spawnAllowedSync(which, ['node'], { encoding: 'utf-8', timeout: 3000 });
            if (result.status === 0 && result.stdout) {
                candidates.push(String(result.stdout).trim().split('\n')[0].trim());
            }
        } catch { /* fallback */ }
        if (process.platform === 'win32') {
            candidates.push('C:\\Program Files\\nodejs\\node.exe');
            candidates.push(`${readEnv(ENV_APPDATA) ?? ''}\\nvm\\current\\node.exe`);
        } else {
            candidates.push('/usr/local/bin/node', '/opt/homebrew/bin/node', `${os.homedir()}/.nvm/current/bin/node`);
        }
        for (const c of candidates) {
            // Candidate paths live outside the safeFs allowlist (system bin dirs).
            // probeBinaryExists is the documented bypass for that exact case
            // and returns a boolean only.
            if (!c || !safeFs.probeBinaryExists(c)) continue;
            try {
                const versionResult = spawnAllowedSync(c, ['--version'], { encoding: 'utf-8', timeout: 3000 });
                const version = String(versionResult.stdout ?? '').trim();
                if (version.startsWith('v')) return c;
            } catch { /* not a valid node binary */ }
        }
        return 'node';
    }
}
