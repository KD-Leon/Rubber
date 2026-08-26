/**
 * Sandbox HTML template
 *
 * This HTML is loaded into a sandboxed iframe (sandbox="allow-scripts").
 * It has NO access to Node.js, no process, no require, no fetch.
 * The ONLY communication channel is postMessage to the parent.
 *
 * In Electron, iframe sandbox provides V8 origin isolation (not OS-level).
 * The SandboxBridge in the parent validates all operations and is the
 * primary security boundary.
 */

export const SANDBOX_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'">
</head>
<body>
<script>
// === SANDBOX-SEITE: Kein Node.js, kein Parent-Zugriff ===

// Bridge-Proxy fuer async Aufrufe zum Plugin
var pendingCalls = new Map();
var callCounter = 0;

function bridgeCall(type, payload) {
    return new Promise(function(resolve, reject) {
        var callId = 'bc_' + (++callCounter);
        var timeout = window.setTimeout(function() {
            pendingCalls.delete(callId);
            reject(new Error('Bridge call timeout'));
        }, 15000);
        pendingCalls.set(callId, { resolve: resolve, reject: reject, timeout: timeout });
        parent.postMessage(Object.assign({}, payload, { type: type, callId: callId }), '*');
    });
}

// Vault-API (Bridge)
//
// FIX-29-99-03: mkdir added 2026-06-21. SandboxBridge.vaultMkdir was
// already implemented (recursive folder creation, ignore-list check),
// but the iframe sandbox had no proxy method for it -- so the
// skill-creator skill "create folder" path threw "vault.mkdir is not
// a function" on mobile. IframeSandboxExecutor now routes the new
// vault-mkdir message type to bridge.vaultMkdir.
//
// FIX-44-43: proxies are created PER EXECUTION and stamp the execution id
// (execId) onto every bridge message, so the plugin can attribute vault
// writes to the task whose approval let THAT execution run. The previous
// script-global singleton proxies could not tell overlapping executions
// apart. Frozen so sandbox code cannot swap the methods out.
function makeVaultProxy(execId) {
    return Object.freeze({
        read: function(path) { return bridgeCall('vault-read', { path: path, execId: execId }); },
        readBinary: function(path) { return bridgeCall('vault-read-binary', { path: path, execId: execId }); },
        list: function(path) { return bridgeCall('vault-list', { path: path, execId: execId }); },
        mkdir: function(path) { return bridgeCall('vault-mkdir', { path: path, execId: execId }); },
        write: function(path, content) { return bridgeCall('vault-write', { path: path, content: content, execId: execId }); },
        writeBinary: function(path, content) { return bridgeCall('vault-write-binary', { path: path, content: content, execId: execId }); }
    });
}

// requestUrl (Bridge, URL-Allowlist auf Plugin-Seite)
function makeRequestUrlProxy(execId) {
    return Object.freeze(function(url, options) {
        return bridgeCall('request-url', { url: url, options: options, execId: execId });
    });
}

// Message-Handler fuer Bridge-Responses und Execute-Befehle
window.addEventListener('message', function(event) {
    // SBX-5: only accept bridge responses and execute commands from the parent
    // (the plugin). Without this, any context that obtains a reference to this
    // frame's window could inject an execute command or spoof a bridge response.
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg) return;

    // Bridge-Response
    if (msg.callId && pendingCalls.has(msg.callId)) {
        var p = pendingCalls.get(msg.callId);
        window.clearTimeout(p.timeout);
        pendingCalls.delete(msg.callId);
        if (msg.error) { p.reject(new Error(msg.error)); }
        else { p.resolve(msg.result); }
        return;
    }

    // Execute-Befehl vom Plugin
    if (msg.type === 'execute') {
        Promise.resolve().then(function() {
            // FIX-44-43: per-execution proxies bound to this run's id.
            var vault = makeVaultProxy(msg.id);
            var requestUrl = makeRequestUrlProxy(msg.id);
            var moduleExports = {};
            var moduleFunc = new Function('exports', 'vault', 'requestUrl', msg.code);
            moduleFunc(moduleExports, vault, requestUrl);
            return moduleExports.execute(msg.input, { vault: vault, requestUrl: requestUrl });
        }).then(function(result) {
            parent.postMessage({ type: 'result', id: msg.id, value: result }, '*');
        }).catch(function(e) {
            parent.postMessage({ type: 'error', id: msg.id, message: e.message || String(e) }, '*');
        });
    }
});

// Signal: Sandbox ist bereit
parent.postMessage({ type: 'sandbox-ready' }, '*');
</script>
</body>
</html>`;
