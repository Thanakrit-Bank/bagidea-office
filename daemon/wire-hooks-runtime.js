"use strict";
// Cross-platform runtime hook wiring for the daemon (issue #15, Bug 4).
//
// The committed workspace/.claude/settings.json is a placeholder — it carries
// no absolute path because the dev machine's path means nothing on anyone
// else's box. The installer's wire-hooks.{sh,ps1} rewrite this file at build
// and update time, but those only fire on `bagidea update` / build scripts.
// If a user clones and runs the daemon directly (dev workflow, `node
// server.js`), the placeholder is used as-is and the Security Center never
// fires.
//
// This module is the safety net: the daemon rewrites settings.json on every
// start, pointing at THIS install's perm hook via __dirname (runtime-absolute,
// same on macOS/Linux/Windows). It mirrors wire-hooks.sh's format exactly so
// nothing downstream breaks. Idempotent — only writes when the content changes.
//
// It MERGES rather than overwrites: plugins (Studio Lease, …) add their own
// PreToolUse entries to the same file, and a daemon restart must not wipe them.
// Only the entry whose command points at perm.js belongs to us; everything else
// in the file — other entries, their order, other top-level keys — is kept
// byte-for-byte. A file we cannot parse falls back to the old full rewrite,
// because a broken settings.json means no Security Center at all.
const fs = require("fs");
const path = require("path");

// The single PreToolUse entry this install owns: no matcher (fires on every
// tool), command = node "<abs path to perm.js>".
function buildPermHookEntry(permJsAbsPath) {
  return { hooks: [ { type: "command", command: `node ${JSON.stringify(permJsAbsPath)}`, timeout: 60 } ] };
}

// Does this PreToolUse entry belong to the perm hook (any install's)?
function isPermHookEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) => h && typeof h.command === "string" && /perm\.js/.test(h.command));
}

// Build the {workspace}/.claude/settings.json content for a PreToolUse hook
// pointing at perm.js. Pure function — testable without touching disk.
// This is the from-scratch shape, used when there is no readable file to merge
// into. Kept as-is for the installer scripts and the existing tests.
function buildWorkspaceSettings(permJsAbsPath) {
  return JSON.stringify({
    hooks: {
      PreToolUse: [ buildPermHookEntry(permJsAbsPath) ]
    }
  }, null, 2);
}

// Merge this install's perm hook into existing settings.json text.
// Returns the new JSON text, or null if the text is not a usable settings
// object (caller falls back to buildWorkspaceSettings).
function mergeWorkspaceSettings(existingText, permJsAbsPath) {
  let cur;
  try { cur = JSON.parse(existingText); } catch { return null; }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;

  const hooks = (cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks)) ? cur.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  // Drop every perm.js entry (a stale path, or duplicates) and re-add ours at
  // the front; keep all other entries in their original order.
  const others = pre.filter((e) => !isPermHookEntry(e));
  const nextPre = [ buildPermHookEntry(permJsAbsPath), ...others ];

  // Spreads preserve existing key order; `hooks` / `PreToolUse` keep their slot
  // when already present and are appended when not.
  return JSON.stringify({ ...cur, hooks: { ...hooks, PreToolUse: nextPre } }, null, 2);
}

// Rewrite {workspaceDir}/.claude/settings.json so it resolves to this install.
// Returns true if a write happened (or was needed and failed loudly), false if
// the file already matched.
function wireWorkspaceSettings(workspaceDir, daemonDir) {
  const permJs = path.join(daemonDir, "perm.js");
  const cfgDir = path.join(workspaceDir, ".claude");
  const cfgFile = path.join(cfgDir, "settings.json");

  let cur = null;
  try { cur = fs.readFileSync(cfgFile, "utf8"); } catch {}

  let want = cur === null ? null : mergeWorkspaceSettings(cur, permJs);
  if (want === null) want = buildWorkspaceSettings(permJs);
  want += "\n";

  if (cur === want) return false;
  try { fs.mkdirSync(cfgDir, { recursive: true }); } catch {}
  fs.writeFileSync(cfgFile, want);
  return true;
}

module.exports = { buildWorkspaceSettings, mergeWorkspaceSettings, wireWorkspaceSettings };
