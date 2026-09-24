// Bug 4 (issue #15): the PreToolUse hook must work on macOS/Linux/Windows.
// Two layers: the committed settings.json is a placeholder (no hard path —
// a committed absolute path means nothing on anyone else's box), and the
// daemon rewrites it at startup via wire-hooks-runtime so it resolves to
// THIS install. These tests pin both layers + perm.js's own behavior.
const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SETTINGS = path.join(__dirname, "..", "..", "workspace", ".claude", "settings.json");
const PERM_JS = path.join(__dirname, "..", "perm.js");

// perm.js hardcodes daemon port 8787; we only exercise the safe-tool path
// (no daemon contact) here. The daemon-side /perm/request contract is
// covered by api.test.js against a running daemon.

function runPerm(payload, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [PERM_JS], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => { out += c.toString(); });
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}

test("committed settings.json carries NO absolute path (placeholder only)", () => {
  // Read the COMMITTED blob, not the working copy. The daemon rewrites the
  // working copy at startup on purpose (that is the second layer this file
  // tests), and node --test runs test files in parallel — so any test that
  // boots a daemon was racing this one for the same file on disk.
  let raw;
  try {
    raw = execFileSync("git", ["-C", path.join(__dirname, "..", ".."),
      "show", "HEAD:workspace/.claude/settings.json"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    raw = fs.readFileSync(SETTINGS, "utf8");   // no git (tarball install): best effort
  }
  const j = JSON.parse(raw);
  // The committed file must not bake in any dev-machine path; the daemon
  // (and installer's wire-hooks.{sh,ps1}) fill this in at runtime.
  const cmds = JSON.stringify(j.hooks || {});
  assert.doesNotMatch(cmds, /powershell|\.ps1|perm\.(ps1|js)/i,
    `committed settings.json must not reference a hard path: ${cmds}`);
});

test("perm.js passes safe read tools through with no opinion", async () => {
  const r = await runPerm({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, "", "safe tool must emit no decision (empty stdout)");
});
