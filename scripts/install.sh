#!/usr/bin/env bash
# Install Webster as a Claude Code agent.
#
# What this does:
#   1. Registers the Webster MCP server in ~/.claude.json
#   2. Copies the agent definition to ~/.claude/agents/webster.md
#
# The MCP server is registered globally so the agent can use it from any
# project, but the agent definition scopes the tools — the raw mcp__webster__*
# tools won't appear in your main Claude session, only when the webster agent
# is invoked.
#
# Usage:
#   ./scripts/install.sh              # install using 'bun' to run the server
#   ./scripts/install.sh --check      # verify installation
#   ./scripts/install.sh --uninstall  # remove webster from Claude config
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBSTER_DIR="$(dirname "$SCRIPT_DIR")"
CLAUDE_CONFIG="$HOME/.claude.json"
AGENTS_DIR="$HOME/.claude/agents"
AGENT_SRC="$WEBSTER_DIR/.claude/agents/webster.md"
AGENT_DEST="$AGENTS_DIR/webster.md"

# ─── Helpers ──────────────────────────────────────────────────────────────────

green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

require_python() {
  if ! command -v python3 &>/dev/null; then
    red "python3 is required to update Claude config. Please install it."
    exit 1
  fi
}

# ─── Check ────────────────────────────────────────────────────────────────────

do_check() {
  bold "Webster installation status"
  echo ""

  # MCP server in Claude config
  if [ -f "$CLAUDE_CONFIG" ] && python3 -c "
import json, sys
cfg = json.load(open('$CLAUDE_CONFIG'))
servers = cfg.get('mcpServers', {})
sys.exit(0 if 'webster' in servers else 1)
" 2>/dev/null; then
    green "  ✓ MCP server registered in ~/.claude.json"
  else
    yellow "  ✗ MCP server not registered in ~/.claude.json"
  fi

  # Agent definition
  if [ -f "$AGENT_DEST" ]; then
    green "  ✓ Agent definition at ~/.claude/agents/webster.md"
  else
    yellow "  ✗ Agent definition not found at ~/.claude/agents/webster.md"
  fi

  # Extension
  echo ""
  yellow "  Extension must be loaded manually in your browser:"
  echo "    Chrome/Edge: chrome://extensions → Developer mode → Load unpacked → $WEBSTER_DIR/extension"
  echo "    Firefox:     about:debugging → Load Temporary Add-on → $WEBSTER_DIR/extension/manifest.json"
}

# ─── Uninstall ────────────────────────────────────────────────────────────────

do_uninstall() {
  bold "Uninstalling Webster..."

  require_python

  if [ -f "$CLAUDE_CONFIG" ]; then
    python3 << PYEOF
import json

with open('$CLAUDE_CONFIG') as f:
    cfg = json.load(f)

servers = cfg.get('mcpServers', {})
if 'webster' in servers:
    del servers['webster']
    cfg['mcpServers'] = servers
    with open('$CLAUDE_CONFIG', 'w') as f:
        json.dump(cfg, f, indent=2)
    print("  ✓ Removed MCP server from ~/.claude.json")
else:
    print("  - MCP server was not registered")
PYEOF
  fi

  if [ -f "$AGENT_DEST" ]; then
    rm "$AGENT_DEST"
    green "  ✓ Removed ~/.claude/agents/webster.md"
  else
    echo "  - Agent definition was not installed"
  fi

  green "Done."
}

# ─── Install ──────────────────────────────────────────────────────────────────

do_install() {
  bold "Installing Webster..."
  echo ""

  require_python

  # 1. Register MCP server in ~/.claude.json
  python3 << PYEOF
import json, os

config_path = '$CLAUDE_CONFIG'
webster_dir = '$WEBSTER_DIR'

# Load existing config or start fresh
if os.path.exists(config_path):
    with open(config_path) as f:
        cfg = json.load(f)
else:
    cfg = {}

servers = cfg.setdefault('mcpServers', {})

servers['webster'] = {
    'command': 'bun',
    'args': [webster_dir + '/src/index.ts'],
    'env': {}
}

with open(config_path, 'w') as f:
    json.dump(cfg, f, indent=2)

print("  ✓ Registered MCP server in ~/.claude.json")
print("    Command: bun " + webster_dir + "/src/index.ts")
PYEOF

  # 2. Install agent definition
  mkdir -p "$AGENTS_DIR"

  if [ -f "$AGENT_DEST" ]; then
    yellow "  ~ Updating existing agent definition at ~/.claude/agents/webster.md"
  fi

  cp "$AGENT_SRC" "$AGENT_DEST"
  green "  ✓ Installed agent definition to ~/.claude/agents/webster.md"

  # 3. Extension reminder
  echo ""
  bold "One more step — install the browser extension:"
  echo ""
  echo "  Chrome/Edge:"
  echo "    1. Open chrome://extensions"
  echo "    2. Enable Developer mode (top right)"
  echo "    3. Click 'Load unpacked'"
  echo "    4. Select: $WEBSTER_DIR/extension"
  echo ""
  echo "  Firefox:"
  echo "    1. Open about:debugging"
  echo "    2. Click 'Load Temporary Add-on'"
  echo "    3. Select: $WEBSTER_DIR/extension/manifest.json"
  echo ""
  echo "The extension connects automatically when the MCP server starts."
  echo ""
  green "Webster installed. Restart Claude Code to pick up the new MCP server."
  echo ""
  echo "Usage: ask Claude to use the 'webster' agent, e.g.:"
  echo "  'Use webster to navigate to example.com and take a screenshot'"
}

# ─── Entry point ──────────────────────────────────────────────────────────────

case "${1:-}" in
  --check)     do_check ;;
  --uninstall) do_uninstall ;;
  *)           do_install ;;
esac
