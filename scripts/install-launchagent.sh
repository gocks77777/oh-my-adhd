#!/usr/bin/env bash
# Installs oh-my-adhd as a macOS LaunchAgent (auto-start on login)
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/scripts/com.oh-my-adhd.server.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.oh-my-adhd.server.plist"

NPM_BIN="$(which npm)"
if [ -z "$NPM_BIN" ]; then
  echo "npm not found. Please install Node.js first."
  exit 1
fi

# Build production bundle
echo "Building oh-my-adhd..."
cd "$PROJECT_DIR"
npm run build

# Write plist with actual paths
sed \
  -e "s|REPLACE_WITH_PROJECT_PATH|$PROJECT_DIR|g" \
  -e "s|/usr/local/bin/npm|$NPM_BIN|g" \
  "$PLIST_SRC" > "$PLIST_DEST"

# Load the agent
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo ""
echo "✓ oh-my-adhd will start automatically on login."
echo "  Logs: /tmp/oh-my-adhd.log"
echo ""
echo "Next: bind ⌥+ADH to:  bash $PROJECT_DIR/scripts/capture.sh"
echo "      (use Raycast, Hammerspoon, or Karabiner)"
