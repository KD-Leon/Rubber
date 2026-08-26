var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/mcp/mcp-server-worker.ts
var mcp_server_worker_exports = {};
__export(mcp_server_worker_exports, {
  buildProxyErrorLine: () => buildProxyErrorLine,
  buildProxyStdoutLine: () => buildProxyStdoutLine,
  startProxy: () => startProxy
});
module.exports = __toCommonJS(mcp_server_worker_exports);
var VAULT_OPERATOR_URL = "http://127.0.0.1:27182";
var mcpToken = "";
function readMcpToken() {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    return fs.readFileSync(path.join(os.homedir(), ".obsidian-agent", "mcp-token"), "utf-8").trim();
  } catch {
    return "";
  }
}
function requestIdOf(request) {
  const id = request?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}
function extractJsonRpcError(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const error = parsed?.error;
    if (!error || typeof error.code !== "number" || typeof error.message !== "string") return null;
    return { code: error.code, message: error.message.slice(0, 400) };
  } catch {
    return null;
  }
}
function bodyDetail(rawBody) {
  const collapsed = rawBody.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return `: ${collapsed.slice(0, 200)}`;
}
function buildProxyStdoutLine(request, statusCode, rawBody, expectResponse) {
  if (!expectResponse) return null;
  if (statusCode >= 200 && statusCode < 300) {
    const trimmed = rawBody.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const error = extractJsonRpcError(rawBody) ?? {
    code: -32603,
    message: `Vault Operator returned HTTP ${statusCode}${bodyDetail(rawBody)}`
  };
  return JSON.stringify({ jsonrpc: "2.0", id: requestIdOf(request), error });
}
function buildProxyErrorLine(request, cause) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: requestIdOf(request),
    error: {
      code: -32603,
      message: `Vault Operator not reachable. Is Obsidian running with the connector enabled? (${cause instanceof Error ? cause.message : String(cause)})`
    }
  });
}
async function forwardToVaultOperator(request, expectResponse = true) {
  try {
    const http = await import("http");
    const body = JSON.stringify(request);
    const response = await new Promise((resolve, reject) => {
      const req = http.request(VAULT_OPERATOR_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...mcpToken ? { "Authorization": `Bearer ${mcpToken}` } : {}
        },
        timeout: 3e4
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.write(body);
      req.end();
    });
    const line = buildProxyStdoutLine(request, response.statusCode, response.body, expectResponse);
    if (line !== null) {
      process.stdout.write(line + "\n");
      if (response.statusCode < 200 || response.statusCode >= 300) {
        process.stderr.write(`[mcp-proxy] Vault Operator rejected the request with HTTP ${response.statusCode}
`);
      }
    }
  } catch (e) {
    process.stdout.write(buildProxyErrorLine(request, e) + "\n");
  }
}
function startProxy() {
  mcpToken = readMcpToken();
  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        void forwardToVaultOperator(request, request.id !== void 0 && request.id !== null);
      } catch {
        process.stderr.write(`[mcp-proxy] Invalid JSON: ${line.slice(0, 100)}
`);
      }
    }
  });
  process.stdin.resume();
  process.stderr.write("[mcp-proxy] Vault Operator MCP proxy started\n");
}
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  startProxy();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  buildProxyErrorLine,
  buildProxyStdoutLine,
  startProxy
});
