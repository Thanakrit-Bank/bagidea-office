// The i18n retry governor — POST /i18n's reply handler in server.js.
//
// On 2026-09-19 an exhausted Gemini free-tier quota (20 req/min) answered with
// {"error":{"code":429,...}} — a body that carries no `candidates` at all. The
// handler assumed candidates existed, so `txt` was undefined and `txt.match()`
// threw "Cannot read properties of undefined (reading 'match')". That line landed
// 14,770 times in 17,098 lines of daemon.log, because a string that fails to
// translate never enters the cache and the overlay's 1.5s janitor sweep re-asks
// for it forever — the loop was itself running 5-12x over the limit it was hitting.
//
// This file does not re-describe the fix in its own words: it lifts the real
// source out of server.js and RUNS it against both replies, so the assertions
// below can only pass if the shipped code behaves. Time is faked so the once-a-
// minute log throttle can be tested without waiting a minute.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// CRLF-insensitive: the file is read with every carriage return removed.
const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").split("\r").join("");

function slice(from, to, after) {
  const i = SRC.indexOf(from, after || 0);
  assert.ok(i > -1, "not found in server.js: " + from.slice(0, 48));
  const j = SRC.indexOf(to, i + from.length);
  assert.ok(j > -1, "end marker not found after: " + from.slice(0, 48));
  return { text: SRC.slice(i, j + to.length), start: i, end: j };
}

// 1. the governor's state + throttled logger (declared once, near the top)
const GOV = slice("const i18nInflight = new Set();", "\n}\n").text;
// 2. the reply handler of the /i18n Gemini call. Three routes post to the same
// Gemini path, so anchor on this one's prompt — that sentence exists once.
const PROMPT = SRC.indexOf("Translate these UI strings from Thai to");
assert.ok(PROMPT > -1, "the /i18n route is gone — this test is aimed at nothing");
const I18N_CALL = SRC.indexOf("/v1beta/models/gemini-flash-latest:generateContent?key=", PROMPT);
assert.ok(I18N_CALL > -1, "the /i18n Gemini request is gone — this test is aimed at nothing");
const HEAD = 'rs.on("end", () => {';
const h = slice(HEAD, "\n            });", I18N_CALL);
const BODY = h.text.slice(HEAD.length, h.text.length - "\n            });".length);

// Build a context holding the REAL source, with only the daemon's surroundings faked.
function sandbox() {
  const code = `
let __logs = [], __now = 1758300000000;
const Date = { now: () => __now };
const console = { error: (...a) => __logs.push(a.map(String).join(" ")) };
${GOV}
// one HTTPS reply, exactly as the handler receives it
function __reply(status, bodyText, chunk, cache) {
  const rs = { statusCode: status };
  const o = bodyText;
  let finished = 0;
  const finish = () => { finished++; };
  const auxCost = () => {};
  const COST_RATES = { gemini_i18n_per_char: 0.000001 };
  for (const s of chunk) i18nInflight.add(s);   // what the send loop does
  ${BODY}
  return finished;
}
globalThis.reply = __reply;
globalThis.advance = (ms) => { __now += ms; };
globalThis.logs = () => __logs.slice();
globalThis.now = () => __now;
globalThis.state = () => ({
  backoff: i18nBackoffUntil,
  inflight: [...i18nInflight],
  cooloff: [...i18nCooloff.entries()],
  cooloffMs: I18N_COOLOFF_MS,
});
`;
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

// The reply that caused the outage, verbatim in shape.
const QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details. " +
      "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 20, model: gemini-3.8-flash\nPlease retry in 24.8s.",
    status: "RESOURCE_EXHAUSTED",
  },
});
const OK_200 = JSON.stringify({
  candidates: [{ content: { parts: [{ text: '{"บันทึก":"Save","ยกเลิก":"Cancel"}' }] } }],
});

test("a 429 with no candidates does not throw — the old crash is gone", () => {
  const S = sandbox();
  const cache = {};
  let finished;
  assert.doesNotThrow(() => { finished = S.reply(429, QUOTA_429, ["บันทึก", "ยกเลิก"], cache); },
    "the quota reply must be handled, not thrown on");
  assert.strictEqual(finished, 1, "finish() still runs exactly once, so the batch never hangs");
  assert.deepStrictEqual(cache, {}, "nothing is cached from a failed call");
  const logged = S.logs();
  assert.strictEqual(logged.length, 1, "one line, not one per string");
  assert.match(logged[0], /HTTP 429/, "the status is reported, no longer swallowed");
  assert.doesNotMatch(logged.join("\n"), /Cannot read properties of undefined/,
    "the 2026-09-19 message must never be produced again");
});

test("the 429's own retry window becomes i18nBackoffUntil", () => {
  const S = sandbox();
  const t0 = S.now();
  S.reply(429, QUOTA_429, ["บันทึก"], {});
  // "Please retry in 24.8s" -> 24800ms, ceil'd, measured from the moment of failure
  assert.strictEqual(S.state().backoff, t0 + 24800, "waits exactly as long as Google asked");
  assert.ok(S.state().backoff > t0, "and the daemon is actually held off");
});

test("a 429 without a stated retry window falls back to a minute", () => {
  const S = sandbox();
  const t0 = S.now();
  S.reply(429, JSON.stringify({ error: { code: 429, message: "Resource exhausted." } }), ["ก"], {});
  assert.strictEqual(S.state().backoff, t0 + 60000, "a minute, rather than hammering on");
});

test("a failed string is released from inflight and parked in cooloff", () => {
  const S = sandbox();
  S.reply(429, QUOTA_429, ["บันทึก", "ยกเลิก"], {});
  const st = S.state();
  // length, not deepStrictEqual: these arrays are built inside the vm realm.
  assert.strictEqual(st.inflight.length, 0, "never leaks an inflight entry — that would freeze the string forever");
  assert.strictEqual(st.cooloff.length, 2, "both strings wait before being asked again");
  for (const [, until] of st.cooloff) assert.strictEqual(until, S.now() + st.cooloffMs, "10 minutes off");
});

test("a normal 200 reply still translates, caches and costs — unchanged behaviour", () => {
  const S = sandbox();
  const cache = {};
  let finished;
  assert.doesNotThrow(() => { finished = S.reply(200, OK_200, ["บันทึก", "ยกเลิก"], cache); });
  assert.deepStrictEqual(cache, { "บันทึก": "Save", "ยกเลิก": "Cancel" }, "translations land in the cache");
  assert.strictEqual(finished, 1, "finish() runs once");
  assert.strictEqual(S.logs().length, 0, "a good reply logs nothing");
  assert.strictEqual(S.state().backoff, 0, "and never arms the backoff");
  const st = S.state();
  assert.strictEqual(st.inflight.length, 0, "inflight is released on success too");
  assert.strictEqual(st.cooloff.length, 0, "a translated string is not parked");
});

test("a 200 whose body carries no candidates is reported, not crashed on", () => {
  const S = sandbox();
  assert.doesNotThrow(() => S.reply(200, JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), ["ก"], {}));
  assert.match(S.logs()[0], /no candidates/, "says what was wrong with the reply");
});

test("a 200 whose text holds no JSON object is reported, not crashed on", () => {
  const S = sandbox();
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: "I cannot do that." }] } }] });
  assert.doesNotThrow(() => S.reply(200, body, ["ก"], {}));
  assert.match(S.logs()[0], /no JSON object/, "the old '…of null (reading 0)' path is guarded too");
});

test("a torrent of failures costs at most one log line per minute", () => {
  const S = sandbox();
  const N = 201;                       // ~5 minutes of the overlay's 1.5s sweep
  for (let i = 0; i < N; i++) S.reply(429, QUOTA_429, ["บันทึก"], {});
  assert.strictEqual(S.logs().length, 1, `${N} failures in the same minute must print 1 line, not ${N}`);

  S.advance(60001);                    // the minute passes
  S.reply(429, QUOTA_429, ["บันทึก"], {});
  const out = S.logs();
  assert.strictEqual(out.length, 2, "the next minute prints one more");
  const m = /\(\+(\d+) more in the last minute\)/.exec(out[1]);
  assert.ok(m, "the second line accounts for what it swallowed: " + out[1]);
  assert.strictEqual(+m[1], N - 1, "every failure the first line did not print is counted in the second");

  // 14,770 lines in ~3h8m was the outage. At this rate the same storm costs ~188.
  assert.ok(out.length * 60000 <= 2 * 60000, "the throttle is per minute, not per call");
});

// The three hunks that live outside the reply handler: guarded by shape, since they
// are one-line guards in the middle of the route and cannot be lifted out alone.
test("the send path dedupes, backs off, and always releases", () => {
  const filter = slice("const missing = want.filter(", ";\n", 0).text;
  assert.match(filter, /!i18nInflight\.has\(s\)/, "a string already in flight is not re-sent by the 1.5s sweep");
  assert.match(filter, /!\(i18nCooloff\.get\(s\) > nowMs\)/, "a string that just failed waits its cooloff out");

  const route = SRC.slice(SRC.lastIndexOf("const gm = (reg.apiKeys || {}).GEMINI_API_KEY;", PROMPT), PROMPT);
  assert.match(route, /if \(Date\.now\(\) < i18nBackoffUntil\) return;/, "no request at all while backed off");
  assert.match(route, /for \(const s of chunk\) i18nInflight\.add\(s\);/, "the chunk is marked in flight before sending");

  const tail = SRC.slice(h.end, SRC.indexOf("rq.write(reqBody); rq.end();", h.end));
  assert.match(tail, /const release = \(\) => \{ for \(const s of chunk\) i18nInflight\.delete\(s\); \};/, "timeout/error release helper");
  assert.match(tail, /rq\.setTimeout\(40000, \(\) => \{ rq\.destroy\(\); release\(\); finish\(\); \}\);/,
    "a timed-out chunk is released — otherwise those strings are never translated again");
  assert.match(tail, /rq\.on\("error", \(e\) => \{ release\(\); logI18nFail\("request: " \+ e\.message\); finish\(\); \}\);/,
    "a socket error is released and throttled the same way");
});

test("the crashing expression is gone from the source", () => {
  assert.doesNotMatch(SRC, /const m = JSON\.parse\(txt\.match\(/,
    "server.js:7708 was the crash — an unguarded .match() on a possibly-undefined txt");
});
