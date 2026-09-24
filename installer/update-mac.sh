#!/usr/bin/env bash
# BagIdea Office — macOS Update Script.
# Mirrors Windows update.ps1 behavior:
#   1. Stop the running suite (daemon + shell)
#   2. git pull --ff-only
#   3. Rebuild shell if source changed (and cargo exists)
#   4. Restart daemon
#
# Usage:  bagidea update  |  in-app refresh button  |  directly.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ""
echo "  ===== BagIdea Office - UPDATE ====="
echo ""

# 1) Stop the running suite (daemon + shell).
echo "  [1/4] Stopping the app..."
# Kill daemon (node server.js)
pkill -f "node.*server\.js" 2>/dev/null || true
# Kill the Godot shell / wallpaper
pkill -f "bagidea-office-shell" 2>/dev/null || true
pkill -f "BagIdeaOffice" 2>/dev/null || true
sleep 2

# No git checkout: hand off to the installer (it clones + preserves data).
if [ ! -d "$ROOT/.git" ]; then
  echo "  [2/2] Not a git checkout - running the installer..."
  chmod +x "$ROOT/installer/install-mac.sh"
  exec "$ROOT/installer/install-mac.sh"
fi

# 2) Pull the latest code.
echo "  [2/4] Pulling latest code..."
#    NOTE: do NOT 'git checkout --' the two .claude/settings.json here. HEAD only
#    holds an empty {"hooks":{}} placeholder, while the live files carry this
#    machine's wiring: the installer hooks AND every hook an office plugin
#    registered (studio-lease PreToolUse, run-clock PostToolUse). Reverting them
#    right before wiring wiped the whole set on every update. wire-hooks.sh below
#    MERGES its entries into whatever is already in the files, so there is nothing
#    to discard first. If upstream ever touches them, --ff-only stops with a clear
#    message: resolve that by hand, never by reverting the live hooks.
BEFORE=$(git rev-parse HEAD 2>/dev/null || echo "none")
git pull --ff-only || {
  echo "  ⚠ git pull failed — you may have local changes."
  echo "    Run 'git stash' then try again."
  exit 1
}
AFTER=$(git rev-parse HEAD 2>/dev/null || echo "none")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  - Already up to date"
else
  echo "  - Updated: ${BEFORE:0:7} → ${AFTER:0:7}"
  # Re-wire Claude Code hooks with the new install path
  if [ -f "$ROOT/installer/wire-hooks.sh" ]; then
    bash "$ROOT/installer/wire-hooks.sh" "$ROOT"
    echo "  ✓ Hooks re-wired"
  fi
fi

# 3) Update the shell when its source changed: prebuilt first (no toolchain), then cargo.
echo "  [3/4] Checking shell update..."
SHELL_CHANGED=$(git diff --name-only "$BEFORE" "$AFTER" 2>/dev/null | grep -c "^shell/" || true)
if [ "$SHELL_CHANGED" -gt 0 ]; then
  PLACED=0
  if [ -z "$BAGIDEA_NO_PREBUILT" ]; then
    SLUG=$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -nE 's#.*github\.com[:/]+([^/]+)/([^/.]+).*#\1/\2#p')
    VER=$(head -n1 "$ROOT/VERSION" 2>/dev/null | tr -d ' \r\n')
    if [ -n "$SLUG" ] && [ -n "$VER" ]; then
      BASE="https://github.com/$SLUG/releases/download/v$VER"
      mkdir -p "$ROOT/shell/target/release" "$ROOT/shell/macos"
      if curl -fSL --retry 3 -o "$ROOT/shell/target/release/bagidea-office-shell" "$BASE/bagidea-office-shell-macos-universal" \
         && curl -fSL --retry 3 -o "$ROOT/shell/macos/libwallpaper_shim.dylib" "$BASE/libwallpaper_shim-macos-universal.dylib"; then
        chmod +x "$ROOT/shell/target/release/bagidea-office-shell"
        codesign --force --sign - "$ROOT/shell/macos/libwallpaper_shim.dylib" 2>/dev/null || true
        codesign --force --sign - "$ROOT/shell/target/release/bagidea-office-shell" 2>/dev/null || true
        xattr -dr com.apple.quarantine "$ROOT/shell/target/release/bagidea-office-shell" "$ROOT/shell/macos/libwallpaper_shim.dylib" 2>/dev/null || true
        PLACED=1
        echo "  ✓ Downloaded prebuilt shell v$VER (no build needed)"
      fi
    fi
  fi
  if [ "$PLACED" != "1" ]; then
    if command -v cargo &>/dev/null; then
      echo "  + Building the shell from source (shell/ changed)..."
      (cd "$ROOT/shell" && cargo build --release)
      echo "  ✓ Shell rebuilt"
    else
      echo "  ⚠ shell/ changed but no prebuilt + no cargo — keeping the current binary"
    fi
  fi
else
  echo "  - Shell unchanged, skipping"
fi

# 4) Restart the daemon.
echo "  [4/4] Restarting daemon..."
if [ -f "$ROOT/cli/bagidea" ]; then
  "$ROOT/cli/bagidea" start &>/dev/null &
  echo "  ✓ Daemon restarting..."
else
  echo "  ⚠ cli/bagidea not found — start manually with: bagidea start"
fi

echo ""
echo "  ✅ Update complete!"
echo ""
