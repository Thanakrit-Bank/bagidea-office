"use strict";
// Plugins register their OWN Claude Code hooks (2026-09-25).
//
// Until now the only hooks that survived a fresh install were the ones the
// installer owns (daemon/perm.js, daemon/hook.ps1). The hooks that belong to a
// PLUGIN — studio-lease's PreToolUse gate, run-clock's PostToolUse ticker —
// lived nowhere but in the committed workspace/.claude/settings.json. cae15ed
// stopped tracking that file (it is per-machine config: it holds this box's
// absolute paths), so a machine that pulls now gets a settings.json rebuilt by
// wire-hooks.{ps1,sh} — which writes back only the installer's own entries, and
// hook-integrity-watchdog reports ok:false with the two plugin rails missing.
//
// The fix is for the plugin to declare its hooks in plugin.json and for the
// loader to merge them in on every load:
//
//   "hooks": [
//     { "event": "PreToolUse", "matcher": "mcp__Roblox_Studio__.*",
//       "command": "hook/pretooluse.js", "timeout": 10 }
//   ]
//
// `command` is a path RELATIVE to the plugin folder; the absolute path is
// resolved at load time against this install (same reasoning as
// wire-hooks-runtime.js — the dev machine's path means nothing here).
//
// The merge is deliberately the same shape as the installer's SetOwnedHook
// (wire-hooks.ps1 d42e602 / wire-hooks.sh b8698bc): find the entry of that
// event whose command ends with the plugin's hook path, replace it IN PLACE
// when it is stale, append it when the file has never seen it, and touch
// nothing else — no other entry, no other event, no other top-level key, no
// reordering. Idempotent: a file that already carries the entry is not
// rewritten at all.
//
// Order matters to hook-integrity-watchdog (manifest v2: perm.js → studio-lease
// PreToolUse, run-clock PostToolUse). Appending gives exactly that: the perm
// entry is either already at index 0, or wireWorkspaceSettings puts it there at
// startup (it prepends its own entry and keeps everyone else in file order).
const fs = require("fs");
const path = require("path");

// The Claude Code hook events a plugin may hang off. An event outside this list
// is REFUSED rather than quietly filed under PreToolUse: `PostToolse` would
// otherwise create an entry on a rail nothing reads, while the real hook stays
// missing and the file still looks wired.
const EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop",
  "SubagentStop", "Notification", "PreCompact", "SessionStart", "SessionEnd"];

// Compare commands on the script path only — separators differ (/ vs \), the
// office writes the command double-escaped (`C:\\Users\\…`), and quotes are
// part of the command line, not of the path. Same normalisation the watchdog
// matches with, so the loader and the checker can never disagree.
const normPath = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "/").replace(/\/+/g, "/").replace(/"/g, "").trim().toLowerCase();

// One hook entry as Claude Code expects it, in the key order the office's
// settings.json already uses: { matcher?, hooks: [ { type, command, timeout? } ] }.
function buildEntry(spec) {
  const hook = { type: "command", command: `node ${JSON.stringify(spec.file)}` };
  if (spec.timeout != null) hook.timeout = spec.timeout;
  return spec.matcher ? { matcher: spec.matcher, hooks: [hook] } : { hooks: [hook] };
}

// Every command string inside one settings.json entry.
function entryCommands(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) return [];
  return entry.hooks.filter((h) => h && typeof h.command === "string").map((h) => h.command);
}

// Read a plugin's declared hooks into resolvable specs.
//   manifest.hooks — array; anything else (missing, object, string) means "none".
// Each spec carries `marker`, the tail an existing command must end with for it
// to count as THIS hook: "<plugin folder>/<relative command>". The folder name
// is part of it so two plugins shipping hook/pretooluse.js never collide.
// Entries that cannot be used are returned in `skipped` with a reason, never
// silently dropped — a typo in plugin.json must be visible in the daemon log.
function declaredHooks(manifest, pluginDir) {
  const out = [], skipped = [];
  const list = manifest && Array.isArray(manifest.hooks) ? manifest.hooks : [];
  const id = (manifest && manifest.id) || path.basename(pluginDir || "");
  for (const h of list) {
    if (!h || typeof h !== "object") { skipped.push({ id, reason: "not an object" }); continue; }
    const event = EVENTS.find((e) => e.toLowerCase() === String(h.event == null ? "" : h.event).trim().toLowerCase());
    if (!event) { skipped.push({ id, reason: `unknown event ${JSON.stringify(h.event)}` }); continue; }
    const rel = String(h.command == null ? "" : h.command).trim();
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
      skipped.push({ id, event, reason: `command must be a path inside the plugin folder, got ${JSON.stringify(h.command)}` });
      continue;
    }
    const file = path.join(pluginDir, rel);
    // A hook pointing at a file that is not on disk is worse than no hook: the
    // watchdog would read the entry as present and then fail it with
    // hook-file-missing, and Claude Code would run a command that cannot start.
    // Leave the file alone and say why.
    if (!fs.existsSync(file)) { skipped.push({ id, event, file, reason: "hook file is not on disk" }); continue; }
    const timeout = Number.isFinite(h.timeout) && h.timeout > 0 ? h.timeout : null;
    out.push({
      id, event, file, timeout,
      matcher: h.matcher == null || String(h.matcher).trim() === "" ? null : String(h.matcher),
      marker: normPath(path.join(path.basename(pluginDir), rel)),
    });
  }
  return { hooks: out, skipped };
}

// Merge the declared hooks into existing settings.json TEXT.
// Returns { text, added, updated, unchanged } — text is null when nothing
// changed. A file that is not a usable settings object yields text:null too:
// unlike the installer (which can afford to rebuild from a backup copy) the
// daemon must never throw away a settings.json it merely failed to understand.
function mergePluginHooks(existingText, specs) {
  const added = [], updated = [], unchanged = [];
  let cur;
  if (existingText == null || String(existingText).trim() === "") cur = {};
  else {
    try { cur = JSON.parse(existingText); } catch { return { text: null, added, updated, unchanged, unparsable: true }; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return { text: null, added, updated, unchanged, unparsable: true };
  }

  const hooks = (cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks)) ? { ...cur.hooks } : {};
  let dirty = false;

  for (const spec of specs) {
    const list = Array.isArray(hooks[spec.event]) ? [...hooks[spec.event]] : [];
    const want = buildEntry(spec);
    const at = list.findIndex((e) => entryCommands(e).some((c) => normPath(c).endsWith(spec.marker)));
    const where = { id: spec.id, event: spec.event, file: spec.file };
    if (at < 0) { list.push(want); added.push(where); dirty = true; }
    else if (JSON.stringify(list[at]) !== JSON.stringify(want)) { list[at] = want; updated.push(where); dirty = true; }
    else { unchanged.push(where); continue; }
    hooks[spec.event] = list;
  }

  if (!dirty) return { text: null, added, updated, unchanged };
  // Spreads keep the existing key order; `hooks` and each event keep their slot
  // when already present and are appended when not.
  // Keep the file's own trailing-newline convention (a fresh file gets one, the
  // way wire-hooks-runtime writes them) so wiring a hook never shows up as a
  // whitespace-only diff on top of the real change.
  const blank = existingText == null || String(existingText).trim() === "";
  const nl = blank || /\n$/.test(String(existingText)) ? "\n" : "";
  return { text: JSON.stringify({ ...cur, hooks }, null, 2) + nl, added, updated, unchanged };
}

// Merge every loaded plugin's declared hooks into {workspaceDir}/.claude/settings.json.
// `entries` is [{ manifest, dir }] — what the loader already holds.
// Returns { wrote, added, updated, unchanged, skipped } and never throws for a
// reason the caller can do nothing about; a plugin's hook wiring must not be
// able to stop the daemon from coming up.
function wirePluginHooks(workspaceDir, entries) {
  const result = { wrote: false, added: [], updated: [], unchanged: [], skipped: [] };
  if (!workspaceDir) return result;

  const specs = [];
  for (const e of entries || []) {
    const d = declaredHooks(e.manifest, e.dir);
    specs.push(...d.hooks);
    result.skipped.push(...d.skipped);
  }
  if (!specs.length) return result;

  const cfgDir = path.join(workspaceDir, ".claude");
  const cfgFile = path.join(cfgDir, "settings.json");
  let cur = null;
  try { cur = fs.readFileSync(cfgFile, "utf8"); } catch {}

  const merged = mergePluginHooks(cur, specs);
  result.added = merged.added; result.updated = merged.updated; result.unchanged = merged.unchanged;
  if (merged.unparsable) {
    result.skipped.push({ reason: `${cfgFile} is not valid JSON — plugin hooks left unwired` });
    return result;
  }
  if (merged.text == null) return result;

  try {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(cfgFile, merged.text);
    result.wrote = true;
  } catch (err) {
    result.skipped.push({ reason: `cannot write ${cfgFile}: ${err && err.message}` });
  }
  return result;
}

module.exports = { EVENTS, declaredHooks, mergePluginHooks, wirePluginHooks, buildEntry, normPath };
