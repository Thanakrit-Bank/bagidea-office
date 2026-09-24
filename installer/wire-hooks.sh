#!/usr/bin/env bash
# Point the Claude Code hook settings at THIS install, WITHOUT dropping hooks
# that anything else (office plugins) has registered.
#
# The committed .claude/settings.json carry the dev machine's absolute paths, so
# the permission hook (Security Center) and task hooks (Mission Control feed)
# would silently never fire elsewhere. The build scripts call this after a clone
# and update-linux.sh calls it after every git pull. macOS/Linux use the Node
# hooks (hook.js / perm.js); see wire-hooks.ps1 for the Windows (.ps1) variant.
#
# It used to rebuild both files with `cat > ... <<JSON`, which truncated them and
# wiped every plugin hook on each update (that is how studio-lease's PreToolUse
# and run-clock's PostToolUse were lost on Windows on 2026-09-24; the same bug
# lived here). It now MERGES: the existing file is read, every entry and every
# unrelated key it holds is kept in place, and only the entries this installer
# owns (daemon/hook.js per task type, daemon/perm.js) are added or refreshed,
# matched on the script path inside the command.
set -e
ROOT="${1:?usage: wire-hooks.sh <app-root>}"

if ! command -v node >/dev/null 2>&1; then
  echo "wire-hooks: node is required to merge the hook settings - aborting without touching them." >&2
  exit 1
fi

mkdir -p "$ROOT/.claude" "$ROOT/workspace/.claude"

# merge_hooks <settings-file> <spec-json>
#   spec-json: [ { "event": ..., "markers": [...], "entry": { ... } }, ... ]
# Each spec replaces the installer's own entry for that event IN PLACE (found by
# the markers all appearing in one of the entry's commands) or appends it when
# the file has never seen it. Everything else keeps its position.
merge_hooks() {
  SETTINGS_FILE="$1" HOOK_SPEC="$2" node <<'NODE'
const fs = require('fs');
const path = require('path');

const file = process.env.SETTINGS_FILE;
const spec = JSON.parse(process.env.HOOK_SPEC);

// Commands are compared on the script path only: separators differ (/ vs \) and
// JSON written by other tools often carries doubled backslashes.
const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
    } catch (e) {
      // Never silently throw away a file we cannot parse: keep it beside the
      // original, then fall back to writing a fresh set of hooks.
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
      const bad = file + '.broken-' + stamp;
      try { fs.copyFileSync(file, bad); } catch (_) {}
      console.warn('wire-hooks: ' + file + ' is not valid JSON - a copy was kept at ' + bad + ' and the hooks were rebuilt from scratch.');
    }
  }
}

if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
  settings.hooks = {};
}

const commandsOf = (entry) =>
  (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
    .map((h) => (h && typeof h.command === 'string' ? h.command : ''))
    .filter(Boolean);

for (const item of spec) {
  const event = item.event;
  const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const needles = item.markers.map(norm);
  const idx = list.findIndex((e) =>
    commandsOf(e).some((cmd) => needles.every((n) => norm(cmd).includes(n)))
  );
  if (idx >= 0) list[idx] = item.entry;
  else list.push(item.entry);
  settings.hooks[event] = list;
}

const out = JSON.stringify(settings, null, 2) + '\n';
let old = null;
try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
if (old !== out) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out, 'utf8');
}
NODE
}

HOOK="$ROOT/daemon/hook.js"
PERM="$ROOT/daemon/perm.js"

# Mission Control feed: one entry per task event, all of them daemon/hook.js.
merge_hooks "$ROOT/.claude/settings.json" "$(cat <<JSON
[
  { "event": "UserPromptSubmit", "markers": ["daemon/hook.js", "task.started"],
    "entry": { "hooks": [ { "type": "command", "command": "node \"$HOOK\" task.started" } ] } },
  { "event": "PostToolUse", "markers": ["daemon/hook.js", "task.progress"],
    "entry": { "hooks": [ { "type": "command", "command": "node \"$HOOK\" task.progress" } ] } },
  { "event": "Stop", "markers": ["daemon/hook.js", "task.completed"],
    "entry": { "hooks": [ { "type": "command", "command": "node \"$HOOK\" task.completed" } ] } }
]
JSON
)"

# Security Center: the PreToolUse permission hook, matcher-less by design (the
# hook-integrity-watchdog manifest expects exactly this entry).
merge_hooks "$ROOT/workspace/.claude/settings.json" "$(cat <<JSON
[
  { "event": "PreToolUse", "markers": ["daemon/perm.js"],
    "entry": { "hooks": [ { "type": "command", "command": "node \"$PERM\"", "timeout": 60 } ] } }
]
JSON
)"