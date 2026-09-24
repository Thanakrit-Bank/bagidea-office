// Plugins register their own Claude Code hooks (2026-09-25).
//
// cae15ed stopped tracking the two .claude/settings.json (they hold this box's
// absolute paths — per-machine config). A machine that pulls after it therefore
// has no settings.json until wire-hooks.{ps1,sh} rebuilds one, and the installer
// writes back only the entries IT owns: the plugin rails (studio-lease's
// PreToolUse gate, run-clock's PostToolUse ticker) would stay gone and
// hook-integrity-watchdog would report ok:false for good.
//
// daemon/plugin-hooks.js closes that: the plugin declares its hooks in
// plugin.json and the loader merges them in on every load. These tests pin the
// four cases that matter — no settings.json at all, a file holding only the
// installer's perm entry, a file that is already complete (must not be touched),
// and a hook whose .js is not on disk — plus the cross-check that what the
// loader produces is exactly what the watchdog's manifest v2 asks for.
//
// Nothing here touches the real workspace/.claude/settings.json: every write
// goes to a throwaway tree under the OS temp dir.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { declaredHooks, mergePluginHooks, wirePluginHooks } = require("../plugin-hooks");
const { wireWorkspaceSettings } = require("../wire-hooks-runtime");
const initPlugins = require("../plugins");

const APP = path.join(__dirname, "..", "..");

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "bagidea-plughooks-")); }

// A throwaway plugin folder that declares hooks the way the real ones do.
// `withFile:false` writes the manifest but NOT the .js it points at.
function fixture(root, id, hooks, { withFile = true, index = null } = {}) {
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", hooks }, null, 2));
  if (withFile) {
    for (const h of hooks || []) {
      if (!h || typeof h.command !== "string") continue;
      const f = path.join(dir, h.command);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "// test hook\n");
    }
  }
  if (index) fs.writeFileSync(path.join(dir, "index.js"), index);
  return { manifest: JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")), dir };
}

const LEASE_HOOKS = [{ event: "PreToolUse", matcher: "mcp__Roblox_Studio__.*", command: "hook/pretooluse.js", timeout: 10 }];
const CLOCK_HOOKS = [{ event: "PostToolUse", command: "hook/posttooluse.js", timeout: 5 }];

const cfgPath = (ws) => path.join(ws, ".claude", "settings.json");
const readCfg = (ws) => JSON.parse(fs.readFileSync(cfgPath(ws), "utf8"));
const rawCfg = (ws) => fs.readFileSync(cfgPath(ws), "utf8");

// The file wire-hooks.ps1 leaves behind on a machine that pulled cae15ed: the
// installer's perm entry and nothing else.
function seedPermOnly(ws, permJs) {
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.writeFileSync(cfgPath(ws), JSON.stringify({
    hooks: { PreToolUse: [ { hooks: [ { type: "command", command: `node ${JSON.stringify(permJs)}`, timeout: 60 } ] } ] },
  }, null, 2) + "\n");
}

const commandsOf = (entry) => (entry.hooks || []).map((h) => h.command);

// ---- declaredHooks: what a manifest is allowed to ask for ---------------------

test("declaredHooks resolves the relative command against the plugin folder", () => {
  const root = tmpRoot();
  const { manifest, dir } = fixture(root, "studio-lease", LEASE_HOOKS);
  const { hooks, skipped } = declaredHooks(manifest, dir);

  assert.deepStrictEqual(skipped, []);
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0].event, "PreToolUse");
  assert.strictEqual(hooks[0].matcher, "mcp__Roblox_Studio__.*");
  assert.strictEqual(hooks[0].timeout, 10);
  assert.strictEqual(hooks[0].file, path.join(dir, "hook", "pretooluse.js"));
  assert.strictEqual(hooks[0].marker, "studio-lease/hook/pretooluse.js");

  fs.rmSync(root, { recursive: true, force: true });
});

test("declaredHooks refuses an unknown event, an absolute command and a path escaping the plugin", () => {
  const root = tmpRoot();
  const { manifest, dir } = fixture(root, "odd", [
    { event: "PostToolse", command: "hook/a.js" },                 // typo — must not be filed under PreToolUse
    { event: "PreToolUse", command: "/etc/evil.js" },
    { event: "PreToolUse", command: "../../elsewhere.js" },
    "not-an-object",
  ], { withFile: false });
  const { hooks, skipped } = declaredHooks(manifest, dir);

  assert.deepStrictEqual(hooks, [], "nothing usable was declared");
  assert.strictEqual(skipped.length, 4);
  assert.match(skipped[0].reason, /unknown event/);
  assert.match(skipped[1].reason, /inside the plugin folder/);
  assert.match(skipped[2].reason, /inside the plugin folder/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a plugin with no hooks field declares nothing", () => {
  const root = tmpRoot();
  const dir = path.join(root, "plugins", "plain");
  fs.mkdirSync(dir, { recursive: true });
  assert.deepStrictEqual(declaredHooks({ id: "plain" }, dir), { hooks: [], skipped: [] });
  assert.deepStrictEqual(declaredHooks({ id: "plain", hooks: "nope" }, dir), { hooks: [], skipped: [] });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- case 1: no settings.json at all -----------------------------------------

test("no settings.json at all — the file is created with every declared hook", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  const lease = fixture(root, "studio-lease", LEASE_HOOKS);
  const clock = fixture(root, "run-clock", CLOCK_HOOKS);

  const r = wirePluginHooks(ws, [clock, lease]);
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(r.added.length, 2);
  assert.deepStrictEqual(r.updated, []);

  const out = readCfg(ws);
  assert.strictEqual(out.hooks.PreToolUse.length, 1);
  assert.strictEqual(out.hooks.PreToolUse[0].matcher, "mcp__Roblox_Studio__.*");
  assert.strictEqual(out.hooks.PreToolUse[0].hooks[0].command,
    `node ${JSON.stringify(path.join(lease.dir, "hook", "pretooluse.js"))}`);
  assert.strictEqual(out.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.strictEqual(out.hooks.PostToolUse.length, 1);
  assert.ok(!("matcher" in out.hooks.PostToolUse[0]), "run-clock's entry carries no matcher");
  assert.strictEqual(out.hooks.PostToolUse[0].hooks[0].timeout, 5);
  assert.match(rawCfg(ws), /\n$/, "a fresh file ends with a newline");

  fs.rmSync(root, { recursive: true, force: true });
});

// ---- case 2: only the installer's perm entry ---------------------------------

test("only perm.js present — the plugin entries are appended, perm keeps index 0 untouched", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  const daemonDir = path.join(root, "daemon");
  fs.mkdirSync(daemonDir, { recursive: true });
  const permJs = path.join(daemonDir, "perm.js");
  fs.writeFileSync(permJs, "// perm\n");
  seedPermOnly(ws, permJs);
  const before = readCfg(ws).hooks.PreToolUse[0];

  const lease = fixture(root, "studio-lease", LEASE_HOOKS);
  const clock = fixture(root, "run-clock", CLOCK_HOOKS);
  const r = wirePluginHooks(ws, [lease, clock]);

  assert.strictEqual(r.wrote, true);
  const pre = readCfg(ws).hooks.PreToolUse;
  assert.strictEqual(pre.length, 2, "nothing dropped, nothing duplicated");
  assert.deepStrictEqual(pre[0], before, "the installer's perm entry is byte-identical and still first");
  assert.strictEqual(pre[1].matcher, "mcp__Roblox_Studio__.*");
  assert.strictEqual(readCfg(ws).hooks.PostToolUse.length, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

// ---- case 3: already complete — the file must NOT change ---------------------

test("already complete — a second wiring writes nothing and leaves the bytes alone", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  const daemonDir = path.join(root, "daemon");
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(path.join(daemonDir, "perm.js"), "// perm\n");
  seedPermOnly(ws, path.join(daemonDir, "perm.js"));
  const lease = fixture(root, "studio-lease", LEASE_HOOKS);
  const clock = fixture(root, "run-clock", CLOCK_HOOKS);

  assert.strictEqual(wirePluginHooks(ws, [lease, clock]).wrote, true);
  const text = rawCfg(ws);
  const mtime = fs.statSync(cfgPath(ws)).mtimeMs;

  const again = wirePluginHooks(ws, [lease, clock]);
  assert.strictEqual(again.wrote, false, "second wiring must not write");
  assert.deepStrictEqual(again.added, []);
  assert.deepStrictEqual(again.updated, []);
  assert.strictEqual(again.unchanged.length, 2);
  assert.strictEqual(rawCfg(ws), text, "bytes unchanged");
  assert.strictEqual(fs.statSync(cfgPath(ws)).mtimeMs, mtime, "the file was not even reopened for writing");

  fs.rmSync(root, { recursive: true, force: true });
});

// ---- case 4: the hook .js is not on disk -------------------------------------

test("hook file missing on disk — no entry is written and the reason is reported", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  const daemonDir = path.join(root, "daemon");
  fs.mkdirSync(daemonDir, { recursive: true });
  fs.writeFileSync(path.join(daemonDir, "perm.js"), "// perm\n");
  seedPermOnly(ws, path.join(daemonDir, "perm.js"));
  const text = rawCfg(ws);

  const ghost = fixture(root, "studio-lease", LEASE_HOOKS, { withFile: false });
  const r = wirePluginHooks(ws, [ghost]);

  assert.strictEqual(r.wrote, false, "a hook that cannot run must not be written into settings.json");
  assert.strictEqual(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /not on disk/);
  assert.strictEqual(rawCfg(ws), text, "the existing file is untouched");
  assert.strictEqual(readCfg(ws).hooks.PreToolUse.length, 1, "only perm is there");

  fs.rmSync(root, { recursive: true, force: true });
});

// ---- merge semantics ---------------------------------------------------------

test("a stale absolute path is refreshed in place — the entry keeps its position", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  const lease = fixture(root, "studio-lease", LEASE_HOOKS);
  fs.writeFileSync(cfgPath(ws), JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [ { type: "command", command: 'node "/old/daemon/perm.js"', timeout: 60 } ] },
        { matcher: "mcp__Roblox_Studio__.*", hooks: [ { type: "command", command: 'node "/old/install/plugins/studio-lease/hook/pretooluse.js"', timeout: 10 } ] },
        { hooks: [ { type: "command", command: 'node "/x/other.js"' } ] },
      ],
    },
  }, null, 2) + "\n");

  const r = wirePluginHooks(ws, [lease]);
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(r.updated.length, 1);
  assert.deepStrictEqual(r.added, []);

  const pre = readCfg(ws).hooks.PreToolUse;
  assert.strictEqual(pre.length, 3, "updated in place, not appended");
  assert.match(pre[0].hooks[0].command, /old\/daemon\/perm\.js/, "the perm entry is none of our business");
  assert.strictEqual(pre[1].hooks[0].command, `node ${JSON.stringify(path.join(lease.dir, "hook", "pretooluse.js"))}`);
  assert.strictEqual(pre[2].hooks[0].command, 'node "/x/other.js"', "a stranger's entry keeps its slot");

  fs.rmSync(root, { recursive: true, force: true });
});

test("other top-level keys and other events survive the merge", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  const lease = fixture(root, "studio-lease", LEASE_HOOKS);
  fs.writeFileSync(cfgPath(ws), JSON.stringify({
    permissions: { allow: ["Bash(git status:*)"] },
    env: { FOO: "bar" },
    hooks: { Stop: [ { hooks: [ { type: "command", command: "node /x/stop.js" } ] } ] },
  }, null, 2) + "\n");

  wirePluginHooks(ws, [lease]);
  const out = readCfg(ws);
  assert.deepStrictEqual(out.permissions, { allow: ["Bash(git status:*)"] });
  assert.deepStrictEqual(out.env, { FOO: "bar" });
  assert.strictEqual(out.hooks.Stop[0].hooks[0].command, "node /x/stop.js");
  assert.strictEqual(out.hooks.PreToolUse.length, 1);
  assert.deepStrictEqual(Object.keys(out), ["permissions", "env", "hooks"], "key order is preserved");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a settings.json we cannot parse is never overwritten", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.writeFileSync(cfgPath(ws), "{ this is not json ");
  const lease = fixture(root, "studio-lease", LEASE_HOOKS);

  const r = wirePluginHooks(ws, [lease]);
  assert.strictEqual(r.wrote, false);
  assert.match(r.skipped[0].reason, /not valid JSON/);
  assert.strictEqual(rawCfg(ws), "{ this is not json ", "a file we do not understand is left for a human");

  fs.rmSync(root, { recursive: true, force: true });
});

test("mergePluginHooks reports unparsable input instead of returning text", () => {
  const spec = { id: "x", event: "PreToolUse", matcher: null, file: "/p/x/hook/a.js", timeout: null, marker: "x/hook/a.js" };
  for (const bad of ["[1,2,3]", "null", '"str"', "{oops"]) {
    const r = mergePluginHooks(bad, [spec]);
    assert.strictEqual(r.text, null, bad);
    assert.strictEqual(r.unparsable, true, bad);
  }
});

test("wirePluginHooks does nothing when the host gave it no workspace", () => {
  const r = wirePluginHooks(null, [{ manifest: { id: "x", hooks: LEASE_HOOKS }, dir: "/nope" }]);
  assert.strictEqual(r.wrote, false);
  assert.deepStrictEqual(r.added, []);
});

// ---- through the real loader --------------------------------------------------

test("load() wires the hooks of every plugin it loaded, and a reload is a no-op", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  fixture(root, "studio-lease", LEASE_HOOKS, { index: "module.exports = () => ({});\n" });
  fixture(root, "run-clock", CLOCK_HOOKS);

  const logs = [];
  const host = initPlugins({ pluginsDir: path.join(root, "plugins"), workspace: ws, log: (m) => logs.push(m) });
  // initPlugins() already called load() once — the file is there before we ask again.
  const out = readCfg(ws);
  assert.strictEqual(out.hooks.PreToolUse.length, 1);
  assert.strictEqual(out.hooks.PostToolUse.length, 1);
  assert.ok(logs.some((l) => /\[plugin\] hooks wired/.test(l)), "the wiring is visible in the daemon log");

  const text = rawCfg(ws);
  host.load();
  assert.strictEqual(rawCfg(ws), text, "a /plugins/reload must not rewrite a file that is already right");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a disabled or syntax-broken plugin gets no hooks wired", () => {
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  // enabled:false — load() skips it entirely.
  const off = fixture(root, "studio-lease", LEASE_HOOKS);
  const man = JSON.parse(fs.readFileSync(path.join(off.dir, "plugin.json"), "utf8"));
  man.enabled = false;
  fs.writeFileSync(path.join(off.dir, "plugin.json"), JSON.stringify(man, null, 2));
  // a plugin whose index.js does not parse is refused before it is registered.
  fixture(root, "run-clock", CLOCK_HOOKS, { index: "module.exports = () => {\n  return { x: 1\n" });

  initPlugins({ pluginsDir: path.join(root, "plugins"), workspace: ws, log: () => {} });
  assert.strictEqual(fs.existsSync(cfgPath(ws)), false, "no plugin loaded, so no settings.json was created");

  fs.rmSync(root, { recursive: true, force: true });
});

// ---- cross-check against the real plugins and the real watchdog manifest ------
// The point of the whole change: a machine that has just pulled cae15ed must end
// up with a settings.json that hook-integrity-watchdog calls ok — all three rails
// present, in manifest-v2 order, each matcher right, each .js on disk.
const WATCHDOG = path.join(APP, "plugins", "hook-integrity-watchdog", "index.js");
const REAL = ["studio-lease", "run-clock"].map((id) => path.join(APP, "plugins", id, "plugin.json"));

test("a fresh machine: plugin self-registration + the daemon's perm wiring satisfy the watchdog", { skip: !fs.existsSync(WATCHDOG) || !REAL.every(fs.existsSync) }, () => {
  const { evaluate, readAllGroups, DEFAULT_MANIFEST } = require(WATCHDOG)._internals;
  const root = tmpRoot();
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });

  // The real plugin folders (read-only) — only the settings.json we write is fake.
  const entries = REAL.map((f) => ({ manifest: JSON.parse(fs.readFileSync(f, "utf8")), dir: path.dirname(f) }));

  // Startup order: the loader runs at require time, wireWorkspaceSettings later.
  const wired = wirePluginHooks(ws, entries);
  assert.strictEqual(wired.added.length, 2, "both real plugins declare a hook");
  assert.deepStrictEqual(wired.skipped, [], "both hook files are on disk");
  wireWorkspaceSettings(ws, path.join(APP, "daemon"));

  const settings = readCfg(ws);
  const r = evaluate(DEFAULT_MANIFEST.entries, readAllGroups(settings), fs.existsSync);
  assert.strictEqual(r.present, 3, `all three rails present — missing: ${JSON.stringify(r.missing)}`);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.reordered, null, "manifest v2 order: perm.js then studio-lease, run-clock on its own event");
  assert.deepStrictEqual(r.mismatch, [], "every matcher is scoped as the manifest asks");
  assert.deepStrictEqual(r.missingFiles, [], "every hook points at a .js that exists");

  // And it is stable: re-running either wiring changes nothing.
  const text = rawCfg(ws);
  assert.strictEqual(wirePluginHooks(ws, entries).wrote, false);
  assert.strictEqual(wireWorkspaceSettings(ws, path.join(APP, "daemon")), false);
  assert.strictEqual(rawCfg(ws), text);

  fs.rmSync(root, { recursive: true, force: true });
});

test("the real plugin.json hooks point at the paths the watchdog manifest expects", { skip: !fs.existsSync(WATCHDOG) || !REAL.every(fs.existsSync) }, () => {
  const { DEFAULT_MANIFEST, commandMatches } = require(WATCHDOG)._internals;
  for (const f of REAL) {
    const manifest = JSON.parse(fs.readFileSync(f, "utf8"));
    const { hooks, skipped } = declaredHooks(manifest, path.dirname(f));
    assert.deepStrictEqual(skipped, [], `${manifest.id}: every declared hook is usable`);
    assert.strictEqual(hooks.length, 1, `${manifest.id}: one declared hook`);
    const want = DEFAULT_MANIFEST.entries.find((e) => commandMatches(hooks[0].file, e.endsWith));
    assert.ok(want, `${manifest.id}: ${hooks[0].file} matches no watchdog manifest entry`);
    assert.strictEqual(hooks[0].event, want.event, `${manifest.id}: event`);
    assert.strictEqual(hooks[0].matcher, want.matcher, `${manifest.id}: matcher`);
  }
});
