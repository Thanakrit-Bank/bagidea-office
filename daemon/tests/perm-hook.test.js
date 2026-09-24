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

test("no dev-machine path is ever committed in workspace/.claude/settings.json", () => {
  // Read the COMMITTED blob, not the working copy. The daemon rewrites the
  // working copy at startup on purpose (that is the second layer this file
  // tests), and node --test runs test files in parallel — so any test that
  // boots a daemon was racing this one for the same file on disk.
  //
  // Since cae15ed the file is not tracked at all: it is per-machine config —
  // absolute paths, plus whatever hooks the plugins registered for THIS install
  // (daemon/plugin-hooks.js). It is rebuilt by the installer's wire-hooks
  // scripts, by wire-hooks-runtime at startup and by each plugin's own hooks
  // declaration. Both shapes satisfy the rule this test exists for — nothing in
  // git may carry a path that means nothing on someone else's box. So: if the
  // blob is in HEAD it must still be the placeholder, and if it is not, it must
  // be genuinely untracked rather than merely staged for deletion.
  const repo = path.join(__dirname, "..", "..");
  const git = (args) => execFileSync("git", ["-C", repo].concat(args),
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const REL = "workspace/.claude/settings.json";

  let raw = null;
  try { raw = git(["show", "HEAD:" + REL]); }
  catch {
    let indexed;
    try { indexed = git(["ls-files", "--", REL]).trim(); }
    catch { return; }   // no git at all (tarball install) — nothing to assert
    assert.strictEqual(indexed, "",
      REL + " is back in the index — it is per-machine config since cae15ed");
    return;
  }

  const j = JSON.parse(raw);
  // The committed file must not bake in any dev-machine path; the daemon
  // (and installer's wire-hooks.{sh,ps1}) fill this in at runtime.
  const cmds = JSON.stringify(j.hooks || {});
  assert.doesNotMatch(cmds, /powershell|\.ps1|perm\.(ps1|js)/i,
    "committed settings.json must not reference a hard path: " + cmds);
});

test("perm.js passes safe read tools through with no opinion", async () => {
  const r = await runPerm({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out, "", "safe tool must emit no decision (empty stdout)");
});
