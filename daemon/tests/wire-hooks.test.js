// Bug 4 (issue #15) — runtime hook wiring. The daemon must rewrite the
// workspace settings.json so the PreToolUse hook resolves to THIS install,
// regardless of platform, with no committed hard-coded path.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildWorkspaceSettings, mergeWorkspaceSettings, wireWorkspaceSettings } = require("../wire-hooks-runtime");

test("buildWorkspaceSettings emits node + the absolute perm.js path, no powershell/.ps1", () => {
  const json = buildWorkspaceSettings("/some/where/daemon/perm.js");
  const j = JSON.parse(json);
  const cmd = j.hooks.PreToolUse[0].hooks[0].command;
  assert.match(cmd, /^node\s+"\/some\/where\/daemon\/perm\.js"$/);
  assert.doesNotMatch(cmd, /powershell|\.ps1/i);
  assert.strictEqual(j.hooks.PreToolUse[0].hooks[0].timeout, 60);
});

test("wireWorkspaceSettings writes the resolved settings.json into a workspace dir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oep-wh-"));
  const workspaceDir = path.join(tmp, "workspace");
  const daemonDir = path.join(tmp, "daemon");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(daemonDir, { recursive: true });

  const wrote = wireWorkspaceSettings(workspaceDir, daemonDir);
  assert.strictEqual(wrote, true, "first call should write");
  const out = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8"));
  const cmd = out.hooks.PreToolUse[0].hooks[0].command;
  assert.strictEqual(cmd, `node ${JSON.stringify(path.join(daemonDir, "perm.js"))}`);

  // Idempotent — second call is a no-op (no rewrite).
  const wrote2 = wireWorkspaceSettings(workspaceDir, daemonDir);
  assert.strictEqual(wrote2, false, "second call should be a no-op");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wireWorkspaceSettings overwrites a stale placeholder (hooks: {})", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oep-wh-"));
  const workspaceDir = path.join(tmp, "workspace");
  const daemonDir = path.join(tmp, "daemon");
  fs.mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
  fs.mkdirSync(daemonDir, { recursive: true });
  // Simulate the committed placeholder.
  fs.writeFileSync(path.join(workspaceDir, ".claude", "settings.json"), JSON.stringify({ hooks: {} }, null, 2));

  const wrote = wireWorkspaceSettings(workspaceDir, daemonDir);
  assert.strictEqual(wrote, true);
  const out = JSON.parse(fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8"));
  assert.match(out.hooks.PreToolUse[0].hooks[0].command, /^node\s/);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- merge semantics (2026-09-20) -------------------------------------------
// Plugins write their own PreToolUse entries into the same settings.json (the
// Studio Lease hook, matcher mcp__Roblox_Studio__.*). A daemon restart used to
// blow the whole file away and leave only the perm entry, silently un-wiring
// the lease. wireWorkspaceSettings now merges: it owns the perm.js entry and
// nothing else.

// Build the real-world file: a stale perm path first, then the lease entry.
function seedSettings(workspaceDir, extra) {
  fs.mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
  const obj = Object.assign({
    hooks: {
      PreToolUse: [
        { hooks: [ { type: "command", command: 'node "/old/install/daemon/perm.js"', timeout: 60 } ] },
        { matcher: "mcp__Roblox_Studio__.*", hooks: [ { type: "command", command: 'node "/opt/plugins/studio-lease/hook/pretooluse.js"', timeout: 10 } ] }
      ]
    }
  }, extra || {});
  fs.writeFileSync(path.join(workspaceDir, ".claude", "settings.json"), JSON.stringify(obj, null, 2) + "\n");
  return obj;
}

function readSettings(workspaceDir) {
  return JSON.parse(fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8"));
}

function tmpDirs() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oep-wh-"));
  const workspaceDir = path.join(tmp, "workspace");
  const daemonDir = path.join(tmp, "daemon");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(daemonDir, { recursive: true });
  return { tmp, workspaceDir, daemonDir };
}

test("wireWorkspaceSettings updates a stale perm path but keeps the studio-lease entry", () => {
  const { tmp, workspaceDir, daemonDir } = tmpDirs();
  seedSettings(workspaceDir);

  const wrote = wireWorkspaceSettings(workspaceDir, daemonDir);
  assert.strictEqual(wrote, true, "stale perm path must be rewritten");

  const out = readSettings(workspaceDir);
  const pre = out.hooks.PreToolUse;
  assert.strictEqual(pre.length, 2, "exactly two entries — nothing dropped, nothing duplicated");

  // Entry 0: ours, repointed at this install, still matcher-less.
  assert.strictEqual(pre[0].hooks[0].command, `node ${JSON.stringify(path.join(daemonDir, "perm.js"))}`);
  assert.strictEqual(pre[0].hooks[0].timeout, 60);
  assert.ok(!("matcher" in pre[0]), "the perm entry carries no matcher");

  // Entry 1: the Studio Lease hook, untouched, still second.
  assert.strictEqual(pre[1].matcher, "mcp__Roblox_Studio__.*");
  assert.strictEqual(pre[1].hooks[0].command, 'node "/opt/plugins/studio-lease/hook/pretooluse.js"');
  assert.strictEqual(pre[1].hooks[0].timeout, 10);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wireWorkspaceSettings is a no-op once the merged file already matches", () => {
  const { tmp, workspaceDir, daemonDir } = tmpDirs();
  seedSettings(workspaceDir);

  assert.strictEqual(wireWorkspaceSettings(workspaceDir, daemonDir), true);
  const after = fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8");
  assert.strictEqual(wireWorkspaceSettings(workspaceDir, daemonDir), false, "second call must not write");
  assert.strictEqual(fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8"), after, "bytes unchanged");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wireWorkspaceSettings keeps other top-level keys and other hook events", () => {
  const { tmp, workspaceDir, daemonDir } = tmpDirs();
  seedSettings(workspaceDir, { permissions: { allow: ["Bash(git status:*)"] }, env: { FOO: "bar" } });
  // A second hook event must survive too.
  const cfg = path.join(workspaceDir, ".claude", "settings.json");
  const seeded = JSON.parse(fs.readFileSync(cfg, "utf8"));
  seeded.hooks.Stop = [ { hooks: [ { type: "command", command: "node /x/stop.js" } ] } ];
  fs.writeFileSync(cfg, JSON.stringify(seeded, null, 2) + "\n");

  wireWorkspaceSettings(workspaceDir, daemonDir);

  const out = readSettings(workspaceDir);
  assert.deepStrictEqual(out.permissions, { allow: ["Bash(git status:*)"] });
  assert.deepStrictEqual(out.env, { FOO: "bar" });
  assert.deepStrictEqual(out.hooks.Stop, seeded.hooks.Stop);
  assert.strictEqual(out.hooks.PreToolUse.length, 2);
  assert.strictEqual(out.hooks.PreToolUse[1].matcher, "mcp__Roblox_Studio__.*");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wireWorkspaceSettings falls back to a full rewrite when the file is not valid JSON", () => {
  const { tmp, workspaceDir, daemonDir } = tmpDirs();
  fs.mkdirSync(path.join(workspaceDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, ".claude", "settings.json"), "{ this is not json ");

  const wrote = wireWorkspaceSettings(workspaceDir, daemonDir);
  assert.strictEqual(wrote, true);
  const text = fs.readFileSync(path.join(workspaceDir, ".claude", "settings.json"), "utf8");
  assert.strictEqual(text, buildWorkspaceSettings(path.join(daemonDir, "perm.js")) + "\n");

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("mergeWorkspaceSettings returns null for non-object JSON so the caller can fall back", () => {
  assert.strictEqual(mergeWorkspaceSettings("[1,2,3]", "/d/perm.js"), null);
  assert.strictEqual(mergeWorkspaceSettings("null", "/d/perm.js"), null);
  assert.strictEqual(mergeWorkspaceSettings('"str"', "/d/perm.js"), null);
});

test("mergeWorkspaceSettings inserts the perm entry first when the file has only plugin entries", () => {
  const src = JSON.stringify({ hooks: { PreToolUse: [ { matcher: "mcp__Roblox_Studio__.*", hooks: [ { type: "command", command: "node /x/pretooluse.js", timeout: 10 } ] } ] } });
  const out = JSON.parse(mergeWorkspaceSettings(src, "/d/perm.js"));
  assert.strictEqual(out.hooks.PreToolUse.length, 2);
  assert.match(out.hooks.PreToolUse[0].hooks[0].command, /perm\.js/);
  assert.strictEqual(out.hooks.PreToolUse[1].matcher, "mcp__Roblox_Studio__.*");
});
