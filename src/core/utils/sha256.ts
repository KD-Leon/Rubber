/**
 * sha256Hex -- hex SHA-256 of a UTF-8 string.
 *
 * One home for the cheap, synchronous hash the plugin uses in several
 * governance and cache paths (RunSkillScriptCache, the sandbox content-hash
 * grant). Node's crypto is a runtime builtin (Electron ships it), not an
 * external dependency, so the one `require` here mirrors the same tolerated
 * exception ChatGptOAuthService and the cache already carry.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- Node crypto builtin for sha256; runtime built-in, not an external dep. */
const nodeCrypto = require('crypto') as typeof import('crypto');
/* eslint-enable @typescript-eslint/no-require-imports -- end of one-time crypto require scope */

/** Lower-case hex SHA-256 of the input, hashed as UTF-8 bytes. */
export function sha256Hex(input: string): string {
    return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
}
