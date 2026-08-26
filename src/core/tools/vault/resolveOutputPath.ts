/**
 * resolveOutputPath -- v2.10.0
 *
 * Centralised helper for tools that produce binary files in the vault
 * (create_xlsx, create_docx, create_pptx, create_drawio, create_excalidraw).
 *
 * Behaviour:
 *   - When `requested` contains a slash, the path is used as-is. The model
 *     was explicit about where the file should land.
 *   - When `requested` is just a filename (no slash), the plugin's
 *     `defaultOutputFolder` setting is prepended. This avoids the case
 *     where the model picks an arbitrary folder (or the vault root) for
 *     every call.
 *
 * The folder itself is not created here; downstream writeBinaryToVault()
 * handles mkdir-p. This helper is pure string manipulation so tools can
 * use it without coupling to the file system.
 */

import type ObsidianAgentPlugin from '../../../main';

export function resolveOutputPath(plugin: ObsidianAgentPlugin, requested: string): string {
    const path = requested.trim();
    if (path.length === 0) return path;
    if (path.includes('/')) return path;

    const rawFolder = plugin.settings.defaultOutputFolder?.trim() ?? 'Inbox/';
    const folder = rawFolder.length === 0 ? '' : rawFolder.replace(/\/+$/, '') + '/';
    return folder + path;
}
