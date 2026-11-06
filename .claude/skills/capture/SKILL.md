---
name: capture
# prettier-ignore
description: Manage the capture daemon — start, stop, check status, or rebuild.
---

# /capture

Manage the capture daemon (start, stop, check status, or rebuild).

## Usage

`/capture` — check status
`/capture start` — start the daemon
`/capture stop` — stop the daemon
`/capture restart` — stop then start
`/capture rebuild` — rebuild, re-sign, and restart

## Steps

0. Call `log_usage` with `{ skill: "capture" }` (include the subcommand as args if provided).
1. Parse the argument (default to "status" if none given).

2. **Status**: Run `pgrep -f 'debug/Capture'` to check if the process is running.
   - If running, report: "Capture daemon is running (PID <pid>)."
   - Also check if the Launch Agent is loaded: `launchctl list | grep apotheosis`
   - If not running, report: "Capture daemon is not running." and ask if they'd like to start it.

3. **Start**: Check if already running first (same pgrep). If already running, say so.
   Otherwise, start via the Launch Agent:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   ```
   If the Launch Agent is already loaded but the process isn't running, unload and reload it.
   Report: "Capture daemon started."

4. **Stop**: Unload the Launch Agent and kill the process:
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist
   pkill -f 'debug/Capture'
   ```
   - If it was running, report: "Capture daemon stopped."
   - If it wasn't running, report: "Capture daemon was not running."

5. **Restart**: Stop then Start (steps 4 → 3).

6. **Rebuild**: Build and re-sign the binary, then restart:
   ```bash
   cd apps/capture && ./build.sh
   ```
   Then restart (step 5). Always use `./build.sh` instead of `swift build` — it re-signs the binary with a stable code identity (`com.kealjones.apotheosis.capture`) so macOS doesn't re-prompt for Screen Recording permission after each rebuild.

## Notes
- The daemon is a macOS menu bar app built with Swift in `apps/capture/`.
- It auto-starts on login via Launch Agent (`~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist`).
- Capture only runs inside the schedule in `user-config.json` under `capture` (default: weekdays, all day, every 15s). Outside it, the menu bar offers "Capture Now (until midnight)".
- The menu bar icon changes to indicate capturing vs paused state.
- The binary is at `.build/arm64-apple-macosx/debug/Capture`. Match against `debug/Capture` in pgrep/pkill to catch any architecture.
- **Always use `./build.sh`** for rebuilds — it runs `swift build` then `codesign` with a stable identifier. Using `swift build` directly will break Screen Recording permission.
