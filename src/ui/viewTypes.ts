/**
 * View-Type-Konstanten, ausgelagert aus den View-Klassen (IMP-19-01-03
 * Testing-Phase). Konsumenten wie die Vault-Health-Modals brauchen nur den
 * String; ihn aus AgentSidebarView zu importieren zog die komplette View
 * (und deren Obsidian-Laufzeitklassen) in jeden Test-Import-Graphen.
 */
export const VIEW_TYPE_AGENT_SIDEBAR = 'obsidian-agent-sidebar';
