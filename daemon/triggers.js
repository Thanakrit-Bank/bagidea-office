// BagIdea Office — triggers: the office reacts to the world.
//
// Until v1.3 a workflow had exactly one way to start: someone pressed Run. A
// trigger is a source of runs. Each kind is small and does one thing:
//
//   schedule   every N minutes, or daily at HH:MM  (like a job)
//   webhook    POST /hook/<token> — anything can call it; an optional secret
//              verifies an HMAC-SHA256 signature (GitHub's X-Hub-Signature-256
//              works as-is)
//   event      an office event by type (task.completed, proposal.created, a
//              plugin's own event — anything that goes through broadcast)
//   file       a file appears or changes in a folder (fs.watch, debounced)
//   channel    a message on Telegram/Discord/LINE/… that starts with a keyword
//
// Every payload is normalized to { source, event, data, at } before it reaches
// the workflow, so the same workflow can be fed by GitHub today and by a folder
// tomorrow.
//
// Records live in reg.triggers. Zero dependencies.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KINDS = new Set(["schedule", "webhook", "event", "file", "channel"]);

module.exports = function initTriggers(ctx) {
  const reg = ctx.reg;
  const saveReg = ctx.saveReg || (() => {});
  const workflows = ctx.workflows;              // the engine
  const log = ctx.log || (() => {});
  const now = ctx.now || (() => Date.now());
  const watchers = new Map();                   // trigger id -> fs.FSWatcher
  const debounce = new Map();                   // trigger id|file -> timer

  function all() { return Array.isArray(reg.triggers) ? reg.triggers : (reg.triggers = []); }
  function get(id) { return all().find((t) => t.id === id) || null; }
  function pub(t) { const { cfg, ...rest } = t; const c = { ...cfg }; if (c.secret) c.secret = "•••"; return { ...rest, cfg: c }; }

  let seq = 0;
  function newId() { const t = now(); let id; do { id = "tr" + t + (seq ? "-" + seq : ""); seq++; } while (get(id)); return id; }

  function add(spec) {
    if (!KINDS.has(spec.kind)) throw new Error("unknown trigger kind");
    if (!spec.workflowId || !workflows.load(spec.workflowId)) throw new Error("workflow not found");
    const t = { id: newId(), kind: spec.kind, workflowId: String(spec.workflowId), enabled: spec.enabled !== false,
                name: String(spec.name || "").slice(0, 80), cfg: cleanCfg(spec.kind, spec.cfg || {}), created: now(), lastRun: 0, runs: 0 };
    if (t.kind === "webhook" && !t.cfg.token) t.cfg.token = crypto.randomBytes(12).toString("hex");
    all().push(t); saveReg();
    startWatcher(t);
    return pub(t);
  }
  function update(id, patch) {
    const t = get(id); if (!t) return null;
    if (patch.enabled !== undefined) t.enabled = !!patch.enabled;
    if (patch.name !== undefined) t.name = String(patch.name).slice(0, 80);
    if (patch.workflowId && workflows.load(patch.workflowId)) t.workflowId = String(patch.workflowId);
    if (patch.cfg) t.cfg = { ...t.cfg, ...cleanCfg(t.kind, patch.cfg) };
    saveReg(); stopWatcher(t.id); startWatcher(t);
    return pub(t);
  }
  function remove(id) {
    const before = all().length;
    reg.triggers = all().filter((t) => t.id !== id);
    stopWatcher(id); saveReg();
    return all().length < before;
  }
  function cleanCfg(kind, c) {
    const o = {};
    if (kind === "schedule") { o.everyMin = Math.max(0, Number(c.everyMin) || 0); o.at = /^\d\d:\d\d$/.test(c.at || "") ? c.at : ""; if (!o.everyMin && !o.at) o.everyMin = 60; }
    if (kind === "webhook") { if (c.token) o.token = String(c.token).replace(/[^\w-]/g, "").slice(0, 64); if (c.secret !== undefined) o.secret = String(c.secret || ""); }
    if (kind === "event") o.type = String(c.type || "").slice(0, 60);
    if (kind === "file") { o.dir = String(c.dir || ""); o.glob = String(c.glob || "*"); }
    if (kind === "channel") o.keyword = String(c.keyword || "").trim().slice(0, 40);
    return o;
  }

  // ---- firing ---------------------------------------------------------------
  function fire(id, payload = {}, by = "trigger") {
    const t = get(id); if (!t) throw new Error("unknown trigger");
    const run = workflows.start(t.workflowId, { trigger: { source: t.kind, event: payload.event || "", data: payload.data || payload, at: now() }, by: by + ":" + t.id });
    t.lastRun = now(); t.runs = (t.runs || 0) + 1; saveReg();
    return run;
  }

  // schedule — on the office's 30s tick
  function tick(at) {
    const t0 = at || now();
    let fired = 0;
    for (const t of all()) {
      if (t.kind !== "schedule" || !t.enabled) continue;
      let due = false;
      if (t.cfg.everyMin) due = t0 - (t.lastRun || 0) >= t.cfg.everyMin * 60000;
      else if (t.cfg.at) {
        const d = new Date(t0), [hh, mm] = t.cfg.at.split(":").map(Number);
        const passed = d.getHours() > hh || (d.getHours() === hh && d.getMinutes() >= mm);
        due = passed && new Date(t.lastRun || 0).toDateString() !== d.toDateString();
      }
      if (due) { try { fire(t.id, { event: "schedule" }); fired++; } catch (e) { log("[trigger] schedule " + e.message); } }
    }
    return fired;
  }

  // event — called from broadcast()
  function onEvent(evt) {
    if (!evt || !evt.type || evt.type.startsWith("workflow.") || evt.type === "world.pos") return 0;
    let fired = 0;
    for (const t of all()) {
      if (t.kind !== "event" || !t.enabled || t.cfg.type !== evt.type) continue;
      try { fire(t.id, { event: evt.type, data: evt }); fired++; } catch (e) { log("[trigger] event " + e.message); }
    }
    return fired;
  }

  // channel — before the Director sees the message; returns true when handled
  function onChannel(channel, from, text) {
    const s = String(text || "").trim();
    for (const t of all()) {
      if (t.kind !== "channel" || !t.enabled || !t.cfg.keyword) continue;
      const k = t.cfg.keyword.toLowerCase();
      if (s.toLowerCase().startsWith(k)) {
        try { fire(t.id, { event: "channel", data: { channel, from, text: s, rest: s.slice(k.length).trim() } }); } catch (e) { log("[trigger] channel " + e.message); }
        return true;
      }
    }
    return false;
  }

  // webhook — POST /hook/<token>. Optional HMAC-SHA256 over the raw body.
  function webhook(token, headers, rawBody) {
    const t = all().find((x) => x.kind === "webhook" && x.cfg.token === token);
    if (!t) return { status: 404, error: "no such hook" };
    if (!t.enabled) return { status: 409, error: "hook is disabled" };
    if (t.cfg.secret) {
      const sig = String(headers["x-hub-signature-256"] || headers["x-signature-256"] || headers["x-bagidea-signature"] || "");
      const want = "sha256=" + crypto.createHmac("sha256", t.cfg.secret).update(rawBody).digest("hex");
      const a = Buffer.from(sig), b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, error: "bad signature" };
    }
    let data = {};
    try { data = JSON.parse(rawBody.toString("utf8") || "{}"); } catch { data = { raw: rawBody.toString("utf8").slice(0, 10000) }; }
    const event = String(headers["x-github-event"] || headers["x-event"] || data.event || "webhook");
    try { const run = fire(t.id, { event, data }, "webhook"); return { status: 200, run: run.id }; }
    catch (e) { return { status: 500, error: e.message }; }
  }

  // file — fs.watch on a folder, debounced per file, filtered by a simple glob
  function globToRe(g) { return new RegExp("^" + String(g || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); }
  function startWatcher(t) {
    if (t.kind !== "file" || !t.enabled || !t.cfg.dir) return;
    try {
      if (!fs.existsSync(t.cfg.dir)) return;
      const re = globToRe(t.cfg.glob);
      const w = fs.watch(t.cfg.dir, (ev, name) => {
        if (!name || !re.test(String(name))) return;
        const key = t.id + "|" + name;
        clearTimeout(debounce.get(key));
        debounce.set(key, setTimeout(() => {
          debounce.delete(key);
          const p = path.join(t.cfg.dir, String(name));
          if (!fs.existsSync(p)) return;                    // deleted before we looked
          let size = 0; try { size = fs.statSync(p).size; } catch {}
          try { fire(t.id, { event: "file", data: { path: p, name: String(name), change: ev, size } }); } catch (e) { log("[trigger] file " + e.message); }
        }, 1500));
      });
      w.on("error", () => stopWatcher(t.id));
      watchers.set(t.id, w);
    } catch (e) { log("[trigger] watch " + e.message); }
  }
  function stopWatcher(id) { const w = watchers.get(id); if (w) { try { w.close(); } catch {} watchers.delete(id); } }
  function startAll() { for (const t of all()) startWatcher(t); return watchers.size; }
  function stopAll() { for (const id of [...watchers.keys()]) stopWatcher(id); }

  return { KINDS, list: () => all().map(pub), get: (id) => { const t = get(id); return t ? pub(t) : null; },
           add, update, remove, fire, tick, onEvent, onChannel, webhook, startAll, stopAll, globToRe };
};
