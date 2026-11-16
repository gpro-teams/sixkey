// Popup benchmark (docs/research/ux-study.md §2.3, appendix A; PHASE0X-PLAN A2). A manual tool, not part of CI: timings
// depend on the machine. Read counts are measured too, but their hard gate is test/unit/read-budget.test.ts.
//
//   node scripts/bench/bench.mjs <scenario> <profile dir> <runs> --dist=<extension build> [--label=<name>]
//        [--out=<results.jsonl>] [--throttle=<N>] [--prefix=taskpolicy,-b]
//
// scenarios
//   warm      unlock once after starting the browser, then open the real toolbar popup <runs> times
//   proccold  the same, but before each open wait until the browser has stopped the extension's service worker
//   idlecpu   main-thread time per second of an open popup nobody touches, over 10 s
//   restart   start the browser for every run (the vault is locked), open the popup, type the password, submit
// The profile must have been made by seed.mjs with the same --dist path (the extension id comes from the path; use
// run-set.sh, which copies each build to one fixed path). Results are appended to --out (default: results.jsonl in the
// system temp directory), and a summary (median, p95) is printed.
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { attach, COLLECT, INSTRUMENT, launch, sleep, targets, waitMark, waitTarget } from "./cdp.mjs";

const [, , scenario, profileArg, runsStr, ...rest] = process.argv;
const opt = Object.fromEntries(rest.map((a) => a.replace(/^--/, "").split("=")));
if (!scenario || !profileArg || !runsStr || !opt.dist) {
  console.error(
    "usage: node scripts/bench/bench.mjs <warm|proccold|idlecpu|restart> <profile dir> <runs> --dist=<build> [--label=] [--out=] [--throttle=] [--prefix=]",
  );
  process.exit(2);
}
const RUNS = Number(runsStr);
const DIST = resolve(opt.dist);
const profile = resolve(profileArg);
const label = opt.label ?? DIST;
const OUT = resolve(opt.out ?? join(tmpdir(), "sixkey-bench", "results.jsonl"));
const PW = process.env.SIXKEY_BENCH_PASSWORD ?? "Q7m#Xv9!pL2@rT5$kB8w"; // seed.mjs's
const throttle = Number(opt.throttle ?? 1);
const prefix = opt.prefix ? opt.prefix.split(",") : [];
mkdirSync(dirname(OUT), { recursive: true });

async function session(b) {
  const page = await waitTarget(b, (t) => t.type === "page");
  const tsid = await attach(b, page.targetId);
  await b.send("Page.navigate", { url: `http://github.localhost:${b.sitePort}/` }, tsid);
  const tab = await waitTarget(b, (t) => t.type === "tab");
  const sw = await waitTarget(b, (t) => t.type === "service_worker" && t.url.includes("/sw.js"));
  const ID = new URL(sw.url).host;
  // pause every new popup so throttling and the instrument apply before its first line of script
  const attached = [];
  b.on((m) => {
    if (m.method === "Target.attachedToTarget") attached.push(m.params);
  });
  await b.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: "service_worker", exclude: true },
      { type: "browser_ui", exclude: true },
      { type: "tab", exclude: true },
      {},
    ],
  });
  return { tab, ID, attached };
}

async function openPopup(b, s) {
  s.attached.length = 0;
  const t0 = Date.now();
  await b.send("Extensions.triggerAction", { id: s.ID, targetId: s.tab.targetId });
  let a;
  for (
    let i = 0;
    i < 2000 &&
    !(a = s.attached.find(
      (x) =>
        (x.targetInfo.type === "other" || x.targetInfo.type === "page") &&
        (x.targetInfo.url === "" || x.targetInfo.url.includes(`${s.ID}/popup/`)),
    ));
    i++
  )
    await sleep(5);
  if (!a) throw new Error("popup not attached");
  const sid = a.sessionId;
  if (throttle > 1) await b.send("Emulation.setCPUThrottlingRate", { rate: throttle }, sid);
  await b.send("Page.enable", {}, sid);
  await b.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }, sid);
  await b.send("Runtime.runIfWaitingForDebugger", {}, sid);
  return { sid, targetId: a.targetInfo.targetId, t0 };
}

async function unlock(b, sid) {
  await waitMark(b, sid, ["x:lockscreen"]);
  const t1 = await b.evaluate(
    sid,
    `(() => { const i = document.querySelector('#secret'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(PW)}); i.dispatchEvent(new Event('input', {bubbles:true})); return new Promise(r => setTimeout(() => { const t = performance.now(); document.querySelector('form.lock').requestSubmit(); r(t); }, 30)); })()`,
  );
  await waitMark(b, sid, ["x:firstcode-paint"]);
  return t1;
}

const results = [];
function rec(o) {
  results.push(o);
  appendFileSync(OUT, JSON.stringify({ scenario, profile, label, throttle, prefix: prefix.join(" "), ...o }) + "\n");
}
/** Reads, as counted by the injected instrument: up to the first code, and up to when the run was collected. */
const reads = (sk) =>
  sk && {
    localAtFirstCode: sk.atFirstCode?.localGet,
    localBytesAtFirstCode: sk.atFirstCode?.localGetBytes,
    sessionAtFirstCode: sk.atFirstCode?.sessionGet,
    local: sk.localGet,
    localBytes: sk.localGetBytes,
    session: sk.sessionGet,
  };

if (scenario === "warm" || scenario === "proccold" || scenario === "idlecpu") {
  const b = await launch({ profile, dist: DIST, prefix });
  const s = await session(b);
  await sleep(500);
  // unlock once (the browser just started, so storage.session is empty)
  {
    const p = await openPopup(b, s);
    const w = await waitMark(b, p.sid, ["x:lockscreen", "x:firstcode-paint"]);
    if (w === "x:lockscreen") await unlock(b, p.sid);
    else await waitMark(b, p.sid, ["x:firstcode-paint"]);
    await b.send("Target.closeTarget", { targetId: p.targetId });
    await sleep(600);
  }
  for (let i = 0; i < RUNS; i++) {
    let swGoneAfter;
    if (scenario === "proccold") {
      // wait for the browser to stop the extension's service worker (nothing of ours attached, no extension page open)
      const tw = Date.now();
      while ((await targets(b)).some((t) => t.type === "service_worker" && t.url.includes(s.ID))) {
        await sleep(500);
        if (Date.now() - tw > 120000) throw new Error("sw never stopped");
      }
      await sleep(1500);
      swGoneAfter = Date.now() - tw;
    }
    const p = await openPopup(b, s);
    await waitMark(b, p.sid, ["x:firstcode-paint"]);
    if (scenario === "idlecpu") {
      await b.send("Performance.enable", {}, p.sid);
      await sleep(1000);
      const m0 = Object.fromEntries(
        (await b.send("Performance.getMetrics", {}, p.sid)).metrics.map((x) => [x.name, x.value]),
      );
      await sleep(10000);
      const m1 = Object.fromEntries(
        (await b.send("Performance.getMetrics", {}, p.sid)).metrics.map((x) => [x.name, x.value]),
      );
      const d = (k) => +(((m1[k] - m0[k]) * 1000) / (m1.Timestamp - m0.Timestamp)).toFixed(1); // ms per second
      rec({
        run: i,
        cpuTaskMsPerS: d("TaskDuration"),
        scriptMsPerS: d("ScriptDuration"),
        layoutMsPerS: d("LayoutDuration"),
        styleMsPerS: d("RecalcStyleDuration"),
        heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
        nodes: m1.Nodes,
        layoutCount: m1.LayoutCount - m0.LayoutCount,
      });
    } else {
      await sleep(300); // let the post-render work (touch) finish, so the whole open is counted
      const r = await b.evaluate(p.sid, COLLECT);
      rec({
        run: i,
        prenav: +(r.timeOrigin - p.t0).toFixed(1),
        clickToFirst: +(r.timeOrigin + r.marks["x:firstcode"] - p.t0).toFixed(1),
        firstcode: r.marks["x:firstcode"],
        firstPaint: r.marks["x:firstcode-paint"],
        ...reads(r.sk),
        rows: r.rows,
        res: i === 0 ? r.res : undefined,
        swGoneAfter,
      });
    }
    await b.send("Target.closeTarget", { targetId: p.targetId });
    await sleep(scenario === "warm" ? 400 : 200);
  }
  await b.close();
} else if (scenario === "restart") {
  // every run: start the browser, open the popup (locked: storage.session is empty), unlock with the password
  for (let i = 0; i < RUNS; i++) {
    const b = await launch({ profile, dist: DIST, prefix });
    const s = await session(b);
    await sleep(700);
    const p = await openPopup(b, s);
    const w = await waitMark(b, p.sid, ["x:lockscreen", "x:firstcode-paint"]);
    const r1 = await b.evaluate(p.sid, COLLECT);
    const out = { run: i, prenav: +(r1.timeOrigin - p.t0).toFixed(1), first: w };
    if (w === "x:lockscreen") {
      out.lockscreen = r1.marks["x:lockscreen"];
      const t1 = await unlock(b, p.sid);
      await sleep(300);
      const r2 = await b.evaluate(p.sid, COLLECT);
      out.unlockToFirst = +(r2.marks["x:firstcode"] - t1).toFixed(1);
      out.unlockToPaint = +(r2.marks["x:firstcode-paint"] - t1).toFixed(1);
      Object.assign(out, reads(r2.sk));
      out.rows = r2.rows;
    } else {
      out.firstcode = r1.marks["x:firstcode"];
      Object.assign(out, reads(r1.sk));
      out.rows = r1.rows;
    }
    rec(out);
    await b.close();
    await sleep(300);
  }
} else {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
const pick = (k) =>
  results
    .map((r) => r[k])
    .filter((x) => typeof x === "number")
    .sort((a, b) => a - b);
const stat = (k) => {
  const v = pick(k);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))];
  return { n: v.length, med: q(0.5), p95: q(0.95), min: v[0], max: v[v.length - 1] };
};
const keys = [
  "prenav",
  "clickToFirst",
  "firstcode",
  "firstPaint",
  "lockscreen",
  "unlockToFirst",
  "unlockToPaint",
  "cpuTaskMsPerS",
  "scriptMsPerS",
  "layoutMsPerS",
  "styleMsPerS",
  "heapMB",
  "swGoneAfter",
  "localAtFirstCode",
  "localBytesAtFirstCode",
  "sessionAtFirstCode",
  "local",
  "localBytes",
  "session",
];
console.log(scenario, profile, `label=${label}`, `throttle=${throttle}`, prefix.join(" "));
for (const k of keys) {
  const s = stat(k);
  if (s) console.log("  ", k.padEnd(22), JSON.stringify(s));
}
process.exit(0);
