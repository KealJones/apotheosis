# Apotheosis

This repo is public. Never commit user, employer, or coworker specifics (names, orgs, internal URLs, documents) in code, tests, fixtures, or docs: read them from local config and use made-up placeholder data in tests. See "Public Repo: Private Data Lives Only in Local Config" in `AGENTS.md`.

## When this project is opened

Check if the capture daemon is running with `pgrep -f 'debug/Capture'`. If not, start it with `launchctl load ~/Library/LaunchAgents/com.kealjones.apotheosis.capture.plist`.

## Building apps/capture

Always build with `apps/capture/build.sh`, never `swift build` directly. `build.sh` signs the
binary with the stable local "Apotheosis Capture Signing" identity; a plain `swift build`
produces an ad-hoc-signed binary with a new hash every time, which invalidates the macOS
Screen Recording / microphone TCC grants and causes the permission dialog to reappear on
every rebuild.
