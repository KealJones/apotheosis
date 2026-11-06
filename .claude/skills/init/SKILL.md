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

5. **Build the MCP server:**
   ```bash
   pnpm install && pnpm --filter @apotheosis/core build && pnpm --filter apotheosis-mcp build
   ```
   If this fails, stop and show the error.

6. **Create the data/live convenience symlink:**
   ```bash
   mkdir -p data
   ln -sf ~/Library/Application\ Support/apotheosis data/live
   ```

7. **Build and codesign the capture daemon:**
   ```bash
   cd apps/capture && ./build.sh
   ```
   Always use `./build.sh`, never bare `swift build` — it codesigns the binary with a stable identity so macOS preserves the Screen Recording permission across rebuilds. Swift builds can take a minute on first run.

8. **Install the Launch Agent.** Generate the plist from the template and install it:
   ```bash
   BINARY_PATH="$(pwd)/apps/capture/.build/arm64-apple-macosx/debug/Capture"
   mkdir -p ~/Library/Logs/apotheosis
   sed -e "s|__BINARY_PATH__|${BINARY_PATH}|g" -e "s|__LOG_DIR__|$HOME/Library/Logs/apotheosis|g" \
     apps/capture/com.kealjones.apotheosis.capture.plist \
     > ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   ```

9. **Start the daemon:**
   ```bash
   launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   ```
   Verify it started with `pgrep -f 'debug/Capture'`.

10. **Report success and explain required permissions:**
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
