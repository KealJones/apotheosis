#!/bin/bash
# Build and sign the capture daemon with a stable code identity.
# This prevents macOS from re-prompting for Screen Recording permission after each rebuild.
set -e
cd "$(dirname "$0")"

# Clean stale module cache if it references a different repo path
if [ -d .build/arm64-apple-macosx/debug/ModuleCache ]; then
  CACHED_PATH=$(strings .build/arm64-apple-macosx/debug/ModuleCache/*/*pcm 2>/dev/null | grep -m1 'ModuleCache' | head -1)
  if [ -n "$CACHED_PATH" ] && ! echo "$CACHED_PATH" | grep -q "$(pwd)"; then
    echo "Stale module cache detected, cleaning..."
    rm -rf .build/arm64-apple-macosx/debug/ModuleCache
  fi
fi

swift build "$@"

# Sign with the local "Apotheosis Capture Signing" cert when present — its designated
# requirement is stable across rebuilds, so TCC grants (Screen Recording, Accessibility)
# survive. Ad-hoc fallback works but ties grants to the binary hash, which breaks on
# every rebuild and causes repeated permission prompts.
if security find-identity -v -p codesigning | grep -q "Apotheosis Capture Signing"; then
    SIGN_IDENTITY="Apotheosis Capture Signing"
else
    echo "WARNING: 'Apotheosis Capture Signing' cert not found — falling back to ad-hoc signing." >&2
    echo "         TCC permissions will need re-granting after every rebuild." >&2
    SIGN_IDENTITY="-"
fi
# Sign a copy and mv it over the original. Re-signing in place keeps the same inode, so
# the kernel's cached signature goes stale and launchd's next spawn is killed with
# OS_REASON_CODESIGNING. A fresh inode avoids that.
BIN=.build/arm64-apple-macosx/debug/Capture
cp "$BIN" "$BIN.signing"
codesign --force --sign "$SIGN_IDENTITY" --identifier "com.kealjones.apotheosis.capture" "$BIN.signing"
mv -f "$BIN.signing" "$BIN"
echo "Signed as com.kealjones.apotheosis.capture (identity: $SIGN_IDENTITY)"
