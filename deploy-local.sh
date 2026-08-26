#!/bin/bash

# Deploy to local Obsidian vault
# Usage: ./deploy-local.sh
#
# Requires a .env file with:
#   PLUGIN_DIR=/path/to/your/obsidian/vault/.obsidian/plugins/vault-operator

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  source "$SCRIPT_DIR/.env"
fi

if [ -z "$PLUGIN_DIR" ]; then
  echo "Error: PLUGIN_DIR not set. Create a .env file with:"
  echo "  PLUGIN_DIR=/path/to/.obsidian/plugins/vault-operator"
  exit 1
fi

echo "Deploying Obsidian Agent to: $PLUGIN_DIR"

# Create plugin directory if it doesn't exist (quotes handle spaces in iCloud paths)
mkdir -p "$PLUGIN_DIR"

# Copy only essential files
cp manifest.json "$PLUGIN_DIR/"
cp main.js "$PLUGIN_DIR/"
cp styles.css "$PLUGIN_DIR/"
[ -f sandbox-worker.js ] && cp sandbox-worker.js "$PLUGIN_DIR/"
[ -f mcp-server-worker.js ] && cp mcp-server-worker.js "$PLUGIN_DIR/"
[ -f src/assets/logo.png ] && cp src/assets/logo.png "$PLUGIN_DIR/"
[ -f node_modules/sql.js/dist/sql-wasm.wasm ] && cp node_modules/sql.js/dist/sql-wasm.wasm "$PLUGIN_DIR/"
[ -f node_modules/sql.js/dist/sql-wasm-browser.wasm ] && cp node_modules/sql.js/dist/sql-wasm-browser.wasm "$PLUGIN_DIR/"

# Bundled skills are NOT copied into $PLUGIN_DIR/skills/ anymore.
#
# Since FEAT-29-11 the runtime loader (SelfAuthoredSkillLoader) scans exactly
# one location: <agent-folder>/data/skills/ (default .vault-operator/data/skills/).
# It never reads <pluginDir>/skills/. Bundled AND pro skills are inlined into
# main.js at build time (esbuild.config.mjs -> BUNDLED_SKILLS) and materialized
# into that single canonical folder by BuiltinSkillMaterializer at plugin start.
#
# The old copy-loop below wrote skill folders into $PLUGIN_DIR/skills/ that
# nothing reads. They looked like live skills, drifted stale (source: bundled
# vs the current source: builtin), and got re-created on every deploy -- so
# cleaning them out of a vault was pointless while this script existed. Removed.
# If you need to ship skills in a distributable build artifact, that is the
# esbuild inline path, not a file copy here.

echo "Deployment complete."
echo ""
echo "Next steps:"
echo "1. Reload Obsidian (Cmd/Ctrl + R)"
echo "2. Or disable/enable the plugin in Settings"
