/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions, @typescript-eslint/unbound-method -- File-level disable: interacts with external SDK / JSON / Obsidian internals where untyped 'any' values are unavoidable. Inputs are validated at boundaries via type guards or schema checks where security-relevant. */
/**
 * SafeStorageService -- encrypts/decrypts API keys via Electron's safeStorage API.
 *
 * Electron's safeStorage delegates to the OS keychain:
 *   - macOS: Keychain Services
 *   - Windows: DPAPI (Data Protection API)
 *   - Linux: libsecret (GNOME Keyring / KWallet)
 *
 * Encrypted values are stored as "enc:v1:<base64>" in data.json.
 * The prefix allows detection of encrypted vs. plaintext values.
 *
 * Fallback: when safeStorage is unavailable, encrypt() returns plaintext
 * unchanged and decrypt() passes through plaintext values. The service
 * surfaces this degraded state via a one-time Obsidian Notice (see
 * notifyPlaintextFallbackOnce). ProvidersTab additionally renders a
 * persistent banner so the user can never miss the state.
 *
 * @see ADR-019-electron-safestorage.md
 * @see AUDIT-034 finding M-5 / M-15
 */

const ENCRYPTED_PREFIX = 'enc:v1:';

// Minimal type for the subset of Electron's safeStorage API we use.
interface ElectronSafeStorage {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
}

// Minimal contract for the Obsidian Notice constructor. Kept as a local
// type so the unit test can pass a fake without pulling in the obsidian
// module (the test environment does not provide it).
interface NoticeCtor {
    new (message: string | DocumentFragment, timeout?: number): unknown;
}

export class SafeStorageService {
    private available: boolean;
    private storage: ElectronSafeStorage | null = null;
    /**
     * One-shot guard so the Notice fires at most once per plugin session,
     * even if multiple callers (settings save, model save, OAuth refresh)
     * touch the fallback path.
     */
    private fallbackNoticeShown = false;

    constructor() {
        try {
            // Dynamic require for Electron — must stay as require() because
            // 'electron' is only available in the Electron renderer process
            // and cannot be statically imported in a bundled plugin.
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron can only be loaded via dynamic require in renderer
            const electron = require('electron');
            // In Obsidian's Electron renderer, safeStorage may be on the
            // module directly or behind the (deprecated) remote bridge.
            const ss: ElectronSafeStorage | undefined =
                electron.safeStorage ?? electron.remote?.safeStorage;
            if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
                this.storage = ss;
                this.available = true;
            } else {
                this.available = false;
            }
        } catch {
            this.available = false;
        }

        if (!this.available) {
            console.warn('[SafeStorage] OS keychain not available -- API keys will be stored in plaintext');
        }
    }

    /** True when the OS keychain is usable for encryption. */
    isAvailable(): boolean {
        return this.available;
    }

    /**
     * One-shot guard so the plaintext-persist warning is logged at most once
     * per session, not on every secret written during a settings save.
     */
    private plaintextPersistLogged = false;

    /**
     * Encrypt a plaintext string.
     * Returns `enc:v1:<base64>` on success, or the original plaintext on failure / unavailability.
     *
     * AUDIT 2026-07-22 SEC-L-01: when the OS keychain is unavailable there is
     * no viable alternative to plaintext on that platform (keychain-less
     * Linux); refusing to persist would silently drop the user's keys, a worse
     * failure mode. The degraded state is disclosed via the persistent
     * ProvidersTab banner + one-time Notice (see notifyPlaintextFallbackOnce)
     * and the `_encrypted=false` marker in data.json. We additionally log the
     * first actual plaintext PERSIST (not just the constructor's availability
     * warning) at error level so it is visible in any captured log, once.
     */
    encrypt(plainText: string): string {
        if (!plainText) return plainText;
        if (!this.available || !this.storage) {
            if (!this.plaintextPersistLogged) {
                this.plaintextPersistLogged = true;
                console.error(
                    '[SafeStorage] Persisting a secret in PLAINTEXT: OS keychain unavailable. '
                    + 'Install a system keyring (libsecret/GNOME Keyring/KWallet on Linux) to enable encryption.',
                );
            }
            return plainText;
        }
        try {
            const encrypted = this.storage.encryptString(plainText);
            return ENCRYPTED_PREFIX + encrypted.toString('base64');
        } catch (e) {
            console.warn('[SafeStorage] Encryption failed, storing plaintext:', e);
            return plainText;
        }
    }

    /**
     * Decrypt a value.
     * If the value has the `enc:v1:` prefix it is decrypted; otherwise returned as-is (plaintext passthrough).
     */
    decrypt(value: string): string {
        if (!value || !value.startsWith(ENCRYPTED_PREFIX)) return value;
        if (!this.available || !this.storage) {
            console.warn('[SafeStorage] Cannot decrypt: OS keychain unavailable');
            return '';
        }
        try {
            const b64 = value.slice(ENCRYPTED_PREFIX.length);
            const buffer = Buffer.from(b64, 'base64');
            return this.storage.decryptString(buffer);
        } catch (e) {
            console.warn('[SafeStorage] Decryption failed:', e);
            return '';
        }
    }

    /** Check whether a value is already encrypted (has the enc:v1: prefix). */
    isEncrypted(value: string | undefined): boolean {
        return !!value && value.startsWith(ENCRYPTED_PREFIX);
    }

    /**
     * AUDIT-034 M-5 / M-15. Surface the plaintext fallback state via a
     * single Obsidian Notice per session when the OS keychain is missing
     * AND the caller is about to (or already did) persist a secret. Caller
     * provides the Notice constructor so this file does not have to depend
     * on the obsidian module at type-check time, which keeps the existing
     * unit tests happy.
     *
     * Returns true when this call fired the Notice, false otherwise.
     */
    notifyPlaintextFallbackOnce(noticeCtor: NoticeCtor | undefined, acknowledged: boolean): boolean {
        if (this.available) return false;
        if (this.fallbackNoticeShown) return false;
        if (acknowledged) {
            // User dismissed the persistent banner; respect that and stay
            // silent for the rest of the session. The banner itself keeps
            // being rendered on subsequent settings opens so the state is
            // never lost, only the toast is suppressed.
            this.fallbackNoticeShown = true;
            return false;
        }
        this.fallbackNoticeShown = true;
        if (typeof noticeCtor !== 'function') return false;
        try {
            // Side-effect constructor call: Obsidian's Notice DOM mount
            // happens inside the constructor, no instance reference needed.
            // eslint-disable-next-line no-new -- Notice is a side-effect UI primitive
            new noticeCtor(
                'OS keychain unavailable. API keys and OAuth tokens are stored as plaintext in data.json. '
                + 'Open settings, providers tab for details.',
                12000,
            );
        } catch (e) {
            console.warn('[SafeStorage] Failed to surface plaintext-fallback notice:', e);
            return false;
        }
        return true;
    }

    /**
     * Test-only escape hatch so the Notice guard can be reset between
     * unit-test cases. Intentionally not exported through any UI path.
     */
    _resetFallbackNoticeForTests(): void {
        this.fallbackNoticeShown = false;
    }
}

/* eslint-enable -- end of file-level disable for boundary code (SDK/JSON/Obsidian internals) */
