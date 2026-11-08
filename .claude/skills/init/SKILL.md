---
name: init
# prettier-ignore
description: First-time setup for a new Apotheosis user.
---

# /init

Set up Apotheosis for a new user. Creates the data directory, configures mention patterns, builds everything, and installs a Launch Agent so the daemon auto-starts on login.

Only needs to be run once.

## Steps

1. **Check if already initialized.** Look for `~/Library/Application Support/apotheosis/user-config.json`.
   - If it exists, say: "Already initialized. Run `/capture start` to begin." and stop.

2. **Create the data directory:**
   ```bash
   mkdir -p ~/Library/Application\ Support/apotheosis/screenshots
   ```

3. **Gather user identity.** Ask:
   - "What's your GitHub username?" (try detecting it first with `gh api user -q .login` — if that works, confirm it instead of asking)
   - "What's your display name? (e.g. First Last)"

4. **Write user config.** Build mention patterns from the answers and write to `~/Library/Application Support/apotheosis/user-config.json`:
   ```json
   {
     "github_username": "<gh_user>",
     "display_name": "<display_name>",
     "mention_patterns": ["@<gh_user>", "@<first_name_lowercase>", "<FirstName> "],
     "work_patterns": []
   }
   ```
   Also ask: "Which domains or GitHub org are your work? (optional)". Turn each answer into a
   case-insensitive regex fragment in `work_patterns`, e.g. `github\\.com/my-org`,
   `\\.mycompany\\.com`. Triage treats pages that match as work.

5. **Retention, meeting recording, and local Slack digests.** Point the user at the "Read this first" section of `README.md`, then:
   - Ask: "How many days of raw captures should be kept? (recommended: 90, blank = forever)". If they give a number, set `capture.retention_days` to it.
   - Ask whether they want meeting recording. Explain it records mic and system audio, that some places require every participant's consent, and that many employers only allow approved recording tools. Default is **no**.
   - Only if they want it, ask them to confirm both, separately and explicitly:
     1. "Have you confirmed that recording meetings is legal where you and the other participants are?"
     2. "Have you confirmed your employer (or whoever owns this machine) allows it?"
   - Enable it only on a clear yes to both: write `"meetings": { "enabled": true, "mode": "ask" }`. Never set `"mode": "auto"` during setup. Anything else (no, unsure, skipped) writes `"meetings": { "enabled": false }` and tells them they can change it later in `user-config.json`.
   - Ask whether they want **local Slack digests** (default **no**). Explain: every 20 minutes a local Ollama model summarizes Slack conversations you're active in (summary, urgency, your to-dos, open items) so `/today` and `/standup` get short notes instead of raw messages. It needs Ollama and a few GB of memory while it runs; runs are skipped on battery, under memory pressure, and when there's nothing new, and the model is unloaded after each run. Remind them to check that Ollama and the model are allowed by their employer (default model: `gemma4:e4b`, override with `APOTHEOSIS_OLLAMA_MODEL`).
   - On yes: set `"slack": { "local_digest": true }`, check `ollama list` for the model and offer `ollama pull gemma4:e4b` if it's missing, and install the detector schedule after step 9 (see "Commitments and the scheduled detector runner" in `README.md`). On no: leave `slack.local_digest` unset; `/standup` keeps using raw Slack text.

6. **Build the MCP server:**
   ```bash
   pnpm install && pnpm --filter @apotheosis/core build && pnpm --filter apotheosis-mcp build
   ```
   If this fails, stop and show the error.

7. **Create the data/live convenience symlink:**
   ```bash
   mkdir -p data
   ln -sf ~/Library/Application\ Support/apotheosis data/live
   ```

8. **Build and codesign the capture daemon:**
   ```bash
   cd apps/capture && ./build.sh
   ```
   Always use `./build.sh`, never bare `swift build` — it codesigns the binary with a stable identity so macOS preserves the Screen Recording permission across rebuilds. Swift builds can take a minute on first run.

9. **Install the Launch Agent.** Generate the plist from the template and install it:
   ```bash
   BINARY_PATH="$(pwd)/apps/capture/.build/arm64-apple-macosx/debug/Capture"
   mkdir -p ~/Library/Logs/apotheosis
   sed -e "s|__BINARY_PATH__|${BINARY_PATH}|g" -e "s|__LOG_DIR__|$HOME/Library/Logs/apotheosis|g" \
     apps/capture/com.kealjones.apotheosis.capture.plist \
     > ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   ```

10. **Start the daemon:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   ```
   Verify it started with `pgrep -f 'debug/Capture'`.

11. **Report success and explain required permissions:**
    ```
    Setup complete. The capture daemon is running and will auto-start on login.

    Before it can capture anything, you need to grant three macOS permissions.
    All are in System Settings > Privacy & Security:

    1. Screen Recording — for taking screenshots of your windows.
       Toggle on the Capture app (may appear as your terminal).
       Restart the daemon after granting: /capture restart

    2. Accessibility — for reading window titles, focused elements,
       selected text, and document paths.
       Toggle on the Capture app.

    3. Automation (Apple Events) — for reading browser URLs from
       Safari and Chrome. macOS will prompt automatically the first
       time; click "Allow".

    If the daemon is running but /today shows no data, check these
    permissions. Logs are at ~/Library/Logs/apotheosis/capture.log.

    Try these commands:
      /capture    -- check daemon status
      /today      -- see today's activity
      /standup    -- generate yesterday's standup
    ```

## Notes
- The MCP server won't be available until Claude Code is restarted after the first build (it reads `.mcp.json` on startup). Mention this to the user.
- The Launch Agent plist template lives at `apps/capture/com.kealjones.apotheosis.capture.plist`. The `__BINARY_PATH__` and `__LOG_DIR__` placeholders get replaced during setup.
- If the user already has a `user-config.json` but wants to change their patterns, they can edit it directly at `~/Library/Application Support/apotheosis/user-config.json`.
- Logs go to `~/Library/Logs/apotheosis/capture.log`.
