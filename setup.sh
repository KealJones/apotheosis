#!/bin/bash
set -e

echo "=== Apotheosis Setup ==="
echo ""
echo "This script initializes Apotheosis for a new user."
echo "It creates the data directory, builds the MCP server and capture daemon,"
echo "configures mention patterns, and installs a Launch Agent."
echo ""

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Create data directory
DATA_DIR="${HOME}/Library/Application Support/apotheosis"
echo "Creating data directory: $DATA_DIR"
mkdir -p "$DATA_DIR/screenshots"

# 2. Gather user info for mention patterns
echo ""
echo "--- User Configuration ---"
echo "Mention patterns let the /mentions and /follow-ups tools find"
echo "where your name appears in captured screen text."
echo ""

GH_USER=""
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  GH_USER=$(gh api user -q .login 2>/dev/null || true)
  if [ -n "$GH_USER" ]; then
    echo "Detected GitHub username: $GH_USER"
  fi
fi

if [ -z "$GH_USER" ]; then
  read -rp "GitHub username (e.g. myuser): " GH_USER
fi

read -rp "Display name (e.g. First Last): " DISPLAY_NAME
FIRST_NAME=$(echo "$DISPLAY_NAME" | awk '{print $1}')

echo ""
echo "Before continuing, read the \"Read this first\" section of README.md."
read -rp "Days of raw captures to keep (recommended 90, blank = forever): " RETENTION_DAYS
CAPTURE_JSON=""
if [[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  CAPTURE_JSON="\"capture\": { \"retention_days\": $RETENTION_DAYS },"
fi

# Meeting recording stays off unless the user explicitly confirms both questions.
MEETINGS_ENABLED=false
read -rp "Enable meeting recording (mic + system audio)? [y/N]: " WANT_MEETINGS
if [[ "$WANT_MEETINGS" =~ ^[Yy]$ ]]; then
  echo "Some places require every participant's consent to record, and many employers only allow approved recording tools."
  read -rp "Have you confirmed recording is legal where you and the other participants are? [y/N]: " LAW_OK
  read -rp "Have you confirmed your employer (or whoever owns this machine) allows it? [y/N]: " EMPLOYER_OK
  if [[ "$LAW_OK" =~ ^[Yy]$ && "$EMPLOYER_OK" =~ ^[Yy]$ ]]; then
    MEETINGS_ENABLED=true
  else
    echo "Leaving meeting recording off. You can change it later in user-config.json."
  fi
fi

# Local Slack digests are opt-in: a local Ollama model summarizes active Slack conversations.
SLACK_JSON=""
read -rp "Enable local Slack digests (needs Ollama, runs every 20 min while plugged in)? [y/N]: " WANT_DIGEST
if [[ "$WANT_DIGEST" =~ ^[Yy]$ ]]; then
  SLACK_JSON="\"slack\": { \"local_digest\": true },"
  echo "Check that Ollama and the model (default gemma4:e4b) are allowed by your employer."
  echo "Then install the detector schedule: see \"Commitments and the scheduled detector runner\" in README.md."
fi

cat > "$DATA_DIR/user-config.json" <<EOF
{
  "github_username": "$GH_USER",
  "display_name": "$DISPLAY_NAME",
  "mention_patterns": ["@$GH_USER", "@$(echo "$FIRST_NAME" | tr '[:upper:]' '[:lower:]')", "$FIRST_NAME "],
  "work_patterns": [],
  $CAPTURE_JSON
  $SLACK_JSON
  "meetings": { "enabled": $MEETINGS_ENABLED, "mode": "ask" }
}
EOF
echo "Wrote user config to: $DATA_DIR/user-config.json"
echo "Add regexes for your company's domains/GitHub org to \"work_patterns\" there so triage counts them as work."

# 3. Build MCP server
echo ""
echo "--- Building MCP server ---"
(pnpm install && pnpm --filter @apotheosis/core build && pnpm --filter apotheosis-mcp build)
echo "MCP server built."

# 4. Create convenience symlink
mkdir -p data
if [ -L data/live ]; then
  rm data/live
fi
ln -s "$DATA_DIR" data/live
echo "Created data/live symlink -> $DATA_DIR"

# 5. Build and codesign capture daemon
echo ""
echo "--- Building capture daemon ---"
(cd apps/capture && ./build.sh)
echo "Capture daemon built and signed."

# 6. Install Launch Agent
echo ""
echo "--- Installing Launch Agent ---"
BINARY_PATH="${REPO_DIR}/apps/capture/.build/arm64-apple-macosx/debug/Capture"
PLIST_DEST="${HOME}/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist"
mkdir -p ~/Library/LaunchAgents

LOG_DIR="${HOME}/Library/Logs/apotheosis"
mkdir -p "$LOG_DIR"
sed -e "s|__BINARY_PATH__|${BINARY_PATH}|g" -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  "${REPO_DIR}/apps/capture/com.kealjones.apotheosis.capture.plist" \
  > "$PLIST_DEST"
echo "Installed Launch Agent to: $PLIST_DEST"

# MCP server runs as its own Launch Agent on http://localhost:47330/mcp.
# launchd has no shell init, so resolve the real node binary (not an asdf/nvm shim).
NODE_PATH="$(node -p 'process.execPath')"
MCP_PLIST_DEST="${HOME}/Library/LaunchAgents/com.kealjones.apotheosis.mcp.plist"
sed -e "s|__NODE_PATH__|${NODE_PATH}|g" -e "s|__REPO_DIR__|${REPO_DIR}|g" -e "s|__LOG_DIR__|${LOG_DIR}|g" \
  "${REPO_DIR}/apps/mcp/com.kealjones.apotheosis.mcp.plist" \
  > "$MCP_PLIST_DEST"
launchctl unload "$MCP_PLIST_DEST" 2>/dev/null || true
launchctl load "$MCP_PLIST_DEST"
echo "Installed and started MCP server Launch Agent: $MCP_PLIST_DEST"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Start the capture daemon:"
echo "       launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist"
echo "     A camera icon will appear in your menu bar."
echo ""
echo "  2. Grant Screen Recording permission when macOS prompts you."
echo ""
echo "  3. Open Claude Code in this directory and try:"
echo "       /capture    -- check daemon status"
echo "       /today      -- see today's activity timeline"
echo "       /standup    -- generate yesterday's standup"
echo ""
echo "  The daemon will auto-start on login. Use /capture to manage it."
