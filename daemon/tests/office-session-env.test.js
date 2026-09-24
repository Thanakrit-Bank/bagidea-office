// M3-session — the office must hand every agent/hook process the session key it already
// puts on the events it broadcasts.
//
// Until 2026-09-21 the daemon set OFFICE_AGENT + OFFICE_TASK on a spawned run but never
// OFFICE_SESSION, so a process could name its agent and its turn to the Studio-lease
// registry but never its session. A lease could therefore only be scoped to a turn — and a
// turn ends every few minutes, so task.completed swept leases mid-Play (l_fdc205b86fb0,
// 2026-09-21 03:55, taken in t151 while the work ran on in t156).
//
// server.js boots a live daemon on require, so this reads the source instead: the three
// spawn sites are asserted on their own text, which is exactly the thing that has to stay
// true for the env var to reach a child process.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// An `env: { … }` object literal passed to a spawn, as the three sites write it.
const envBlocks = () => {
  const out = [];
  const re = /env:\s*\{/g;
  let m;
  while ((m = re.exec(SRC))) {
    let i = re.lastIndex - 1, depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === "{") depth++;
      else if (SRC[i] === "}") { depth--; if (!depth) break; }
    }
    const body = SRC.slice(m.index, i + 1);
    if (body.includes("OFFICE_AGENT")) out.push(body);
  }
  return out;
};

test("every env block that sets OFFICE_AGENT also sets OFFICE_SESSION", () => {
  const blocks = envBlocks();
  assert.strictEqual(blocks.length, 3, `expected the 3 known spawn sites, found ${blocks.length}`);
  for (const b of blocks) {
    assert.ok(b.includes("OFFICE_TASK"), "an OFFICE_AGENT block without OFFICE_TASK: " + b.slice(0, 120));
    assert.ok(b.includes("OFFICE_SESSION"), "an OFFICE_AGENT block without OFFICE_SESSION: " + b.slice(0, 120));
  }
});

test("OFFICE_SESSION carries entry.key — the same value task.started/completed broadcast as `session`", () => {
  for (const b of envBlocks()) {
    assert.match(b, /OFFICE_SESSION:\s*\(entry && entry\.key\)\s*\|\|\s*""/,
      "OFFICE_SESSION must be entry.key: " + b.slice(0, 160));
  }
  // …and that IS what the broadcast uses, so a lease keyed on it can be matched.
  assert.match(SRC, /broadcast\(\{\s*type:\s*"task\.started",\s*agent,\s*task,\s*session:\s*entry\.key/);
  assert.match(SRC, /type:\s*ok \? "task\.completed" : "task\.failed", agent, task,/);
});

test("a run with no session still gets a defined, empty OFFICE_SESSION (old behaviour kept)", () => {
  // `(entry && entry.key) || ""` never yields undefined: an env value of undefined makes
  // the child inherit the parent's OFFICE_SESSION, which would tag the run with somebody
  // else's session. Empty string = "no session", which the lease registry treats exactly
  // as a pre-M3-session caller.
  for (const b of envBlocks()) assert.ok(!/OFFICE_SESSION:\s*entry\.key\s*[,}]/.test(b),
    "bare entry.key can be undefined and leak the parent's session: " + b.slice(0, 160));
  const evalEnv = (entry) => (entry && entry.key) || "";
  assert.strictEqual(evalEnv(null), "");
  assert.strictEqual(evalEnv({}), "");
  assert.strictEqual(evalEnv({ key: "s1789937000000" }), "s1789937000000");
});
