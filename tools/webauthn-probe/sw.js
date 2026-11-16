// Service worker of the WebAuthn probe: it only keeps the lifecycle log.
//
// Why a worker: a toolbar popup that closes while the OS dialog is up cannot write anything reliably as it dies. The
// worker sees the page's port disconnect instead, and records whether a ceremony was still pending at that moment. That
// is how the probe tells "the popup survived the Touch ID / Windows Hello dialog" from "the dialog closed the popup".
//
// The log lives in chrome.storage.session (memory only, cleared when the browser restarts). Nothing is sent anywhere:
// the manifest's policy has connect-src 'none' and the extension has no host permission.

const KEY = "probe_life";
const MAX_RUNS = 20;
const MAX_EVENTS = 100;
const KINDS = new Set(["load", "focus", "blur", "visibilitychange", "pagehide", "ceremony-start", "ceremony-end"]);

// Writes are read-modify-write on one key; chain them so two events never overwrite each other.
let queue = Promise.resolve();
function update(change) {
  queue = queue
    .then(async () => {
      const cur = (await chrome.storage.session.get(KEY))[KEY] ?? { runs: [] };
      change(cur);
      cur.runs = cur.runs.slice(-MAX_RUNS);
      await chrome.storage.session.set({ [KEY]: cur });
    })
    .catch(() => undefined); // a failed log write must not stop the next one
  return queue;
}

const short = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : null);

chrome.runtime.onConnect.addListener((port) => {
  // Only this extension's own pages (there are no content scripts and no externally_connectable).
  if (port.sender?.id !== chrome.runtime.id) return port.disconnect();
  let info;
  try {
    info = JSON.parse(port.name);
  } catch {
    return port.disconnect();
  }
  const runId = short(info?.runId, 40);
  const ctx = short(info?.ctx, 20);
  if (!runId || !ctx) return port.disconnect();
  const findRun = (cur) => cur.runs.find((r) => r.runId === runId);

  void update((cur) => {
    let run = findRun(cur);
    if (!run) {
      run = { runId, ctx, connectedAt: Date.now(), connections: 0, events: [], pending: null };
      cur.runs.push(run);
    }
    run.connections += 1; // more than 1: the worker was restarted and the page reconnected
  });

  port.onMessage.addListener((m) => {
    if (!m || typeof m !== "object" || m.kind === "ping") return; // pings only keep the worker awake
    if (!KINDS.has(m.kind)) return;
    void update((cur) => {
      const run = findRun(cur);
      if (!run) return;
      if (run.events.length < MAX_EVENTS) run.events.push({ kind: m.kind, detail: short(m.detail), at: Date.now() });
      if (m.kind === "ceremony-start") run.pending = short(m.detail);
      if (m.kind === "ceremony-end") run.pending = null;
    });
  });

  port.onDisconnect.addListener(() => {
    void update((cur) => {
      const run = findRun(cur);
      if (!run) return;
      run.disconnectedAt = Date.now();
      if (run.events.length < MAX_EVENTS) run.events.push({ kind: "port-disconnected", detail: null, at: Date.now() });
      // The page went away (closed, navigated, or killed) while create() or get() had not returned.
      if (run.pending) run.closedDuringCeremony = run.pending;
    });
  });
});
