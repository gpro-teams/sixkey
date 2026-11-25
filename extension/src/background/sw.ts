// Service worker: event wiring only. It can be stopped at any moment, so nothing is kept in memory between events.
// All listeners are registered synchronously at the top level, as MV3 requires.
// The first import asks the browser to close storage.local and storage.session to content scripts (TOTP-AUTOFILL §4.2;
// storage.local only from Chrome 140, and src/platform/autofill.ts injects nothing into a page otherwise: STORAGEGATE),
// and storage.sync, apart, for the backup in Chrome's sync storage (its gate alone: the maintainers' C7); keep it
// first. The second sets what the toolbar icon opens, the popup or the side panel (src/platform/action-mode.ts); keep it
// second.
import { storageAccess, syncAccess } from "./storage-access-first";
import { action } from "./action-first";
import { followSwitch, workerReconciler } from "../platform/autofill-reconcile";
import { workerChannel } from "../platform/content-channel";
import { acceptPending, watchList } from "../platform/autofill-sites";
import { aliveEntries } from "../core/vault/model";
import { createDiagOnce } from "../platform/diag";
import { closedBy } from "../platform/storage-access";
import { createRuntime } from "../platform/runtime";
import {
  acceptedType,
  contentSender,
  contentType,
  CSB_MESSAGES,
  rulesMessage,
  type CsbMessage,
  type MessageFor,
} from "../platform/sender-policy";
import { dropServerSyncLeftovers } from "../platform/server-sync-leftovers";
import { gatedCode } from "../platform/plugins/autofill-gate";
import { giveBackSites, switchedOff, watchSwitch } from "../platform/plugins/autofill-switch";
import { runShortcut, type FillChrome, type Tab } from "./fill-command";
// the in-page suggestion's worker end (with its release gate open only; imported after the modules it shares with the rest)
import { inFront } from "../platform/autofill";
import { workerPageChannel } from "../platform/content-page-worker";
import { ChromeLocalKV } from "../platform/chrome-kv";
import { createCsbWorker, CSB_RETRY_ALARM, CSB_SOON_ALARM, watchVault } from "../platform/csb-worker";
import { webLock } from "../platform/locks";
import { createMacLink, fillFromMac } from "../platform/mac-link";
import { pinForMac } from "../platform/mac-pin";

const rt = createRuntime();

// The backup in Chrome's sync storage (CSB-3; platform/csb-worker.ts): while it is on, every change of the vault is
// written after the debounce, with the generation as the store reads it with no key, into this device's slot of
// chrome.storage.sync, which Chrome sync carries. Off until the settings page turns it on (sk-csb-on, below), and only
// in a worker whose start closed storage.sync to content scripts (syncAccess). The e2e build's debounce is short, so its
// tests need not wait 30 s (an unpacked extension's alarms may fire sooner): its define alone (scripts/build.mjs).
declare const __CSB_E2E__: boolean;
const csb = createCsbWorker({
  kv: new ChromeLocalKV(chrome.storage.local),
  lock: webLock("sixkey-csb"), // the records' lock, the store's recovery hook's too (platform/cloud-mark.ts)
  vaultLock: webLock("sixkey-vault"), // the store's own (runtime-base.ts), for the handlers that lift or replace a hold
  load: () => rt.store.load(),
  alarms: chrome.alarms,
  now: () => Date.now(),
  app: `Sixkey ${chrome.runtime.getManifest().version}`,
  access: () => syncAccess,
  note: (line) => note(line),
  ...(typeof __CSB_E2E__ === "boolean" && __CSB_E2E__ ? { soonMs: 5_000 } : {}),
});
// The link with Sixkey for Mac, when the person turned it on (platform/mac-link.ts): the vault sent a moment after a
// commit, and the Mac's copy merged (what the host answers with, and a pull once a minute while unlocked).
const macLink = createMacLink({
  load: () => rt.store.load(),
  app: `Sixkey ${chrome.runtime.getManifest().version}`,
  service: rt.service,
  alarms: chrome.alarms,
  pin: () => pinForMac((also) => rt.store.loadView(also)),
});
void macLink.start();
// A commit moves the store's pointer, from whichever context made it: the debounce starts again (csb-worker.ts), and
// the Mac link's send.
watchVault(chrome.storage.local, () => {
  macLink.changed();
  return csb.changed();
});
// (The server sync's worker, its bridge for pages, its transport and the toolbar badge it drew were here, in the dev and
// e2e builds only; they went with that sync's client, OWNER-DECISIONS/25, DV-0b.)

// The diagnostics log's lines from the worker, one after another: createDiagOnce reads and then writes, unlocked, so two
// lines written in one tick would lose one. Each is written only once while it stays in the log (every start would
// otherwise fill the 50 lines).
let noted: Promise<void> = Promise.resolve();
const note = (line: string): void => void (noted = noted.then(() => createDiagOnce(rt.local)(line)));

// A refused level is not fatal (the next worker start tries again), but it is written down for the diagnostics file, and
// it is the outcome TOTP-AUTOFILL probe P1 / kill criterion K2 is about. One line for both areas.
void storageAccess.then((r) => {
  if (r.local && r.session) return;
  const areas = [r.local ? "" : "local", r.session ? "" : "session"].filter(Boolean).join(", ");
  note(`storage access level not restricted: ${areas}`);
});
// storage.sync's (C7): refused, or no answer within GATE_MS, and the backup in Chrome sync does not run in this worker's
// life, nor turn on; one line of its own (autofill does not depend on it).
void syncAccess.then((ok) => {
  if (!ok) note("storage access level not restricted: sync");
});

// A click that could not open the side panel (the popup is then used), or a setting that could not be applied: one line.
action.onProblem(note);

// Autofill's sites (src/platform/autofill-reconcile.ts): the list ∩ Chrome's grants, behind STORAGEGATE's gate, worked out
// again at every start, on every permission event and on every change of the list, and the content script registered for
// exactly those (src/platform/autofill-register.ts).
const reconcileSites = workerReconciler(storageAccess, note, switchedOff);
// That content script's one message (src/platform/content-channel.ts): the toolbar badge of its tab while Autofill is on,
// nothing else. With the in-page suggestion's release gate open (scripts/suggest-ui.mjs, the build's define), also the
// answer whether to draw the suggestion, and its click's `open`: Sixkey's own surface for that document, once (AUTOFILL2
// patch 4a; platform/content-page.ts). The gate closed, the channel is patch 3's and none of the rest is in this file.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;
const contentMessage = SUGGEST_UI
  ? workerPageChannel(chrome.runtime.id, () => closedBy(storageAccess), switchedOff, {
      front: inFront,
      epoch: () => rt.session.lockEpoch(),
      opens: () => action.plan?.opens,
    })
  : workerChannel(chrome.runtime.id, () => closedBy(storageAccess), switchedOff);

// The site rules' updater's release gate (scripts/rules-update.mjs; AF3-U2, below).
declare const __RULES_UPDATE__: boolean;
const ALARM_DAILY = "sk-daily";
const ALARM_AUTOLOCK = "sk-autolock";
/**
 * The end of the Touch ID / Windows Hello gate's 12 hours (QUICK-UNLOCK §5.5): sk_quick leaves storage.session even if no
 * page is open.
 */
const ALARM_QUICK = "sk-quick-expiry";
/** The keyboard shortcut that locks Sixkey (manifest.base.json `commands`; QUICK-UNLOCK §5.12 item 2). */
const LOCK_COMMAND = "lock";
/** The keyboard shortcut that fills the code of the one account registered for the tab's site (src/background/fill-command.ts). */
const FILL_COMMAND = "fill";

async function ensureAlarms(): Promise<void> {
  // Alarms can be lost (profile reset, browser update), so check on every start rather than only on install.
  if (!(await chrome.alarms.get(ALARM_DAILY)))
    await chrome.alarms.create(ALARM_DAILY, { delayInMinutes: 1, periodInMinutes: 360 });
}

/** Cheap and idempotent: safe to run on every wake-up, which is what makes the daily snapshot robust to missed alarms. */
async function routine(full: boolean): Promise<void> {
  try {
    if (full) await rt.store.selfCheck();
    await rt.store.ensureDailySnapshot();
    await ensureAlarms();
    await rescheduleQuickExpiry();
    // the backup in Chrome sync's daily check, and changes whose alarm was lost
    const armed = (await chrome.alarms.get(CSB_SOON_ALARM)) ?? (await chrome.alarms.get(CSB_RETRY_ALARM));
    await csb.routine(armed !== undefined);
  } catch {
    /* a failed routine must not stop the worker; the next wake-up retries */
  }
}

/** Arm a one-shot alarm for the idle deadline, so the key leaves storage.session even if no page is open. */
async function rescheduleAutoLock(): Promise<void> {
  void rescheduleQuickExpiry().catch(() => undefined); // its own alarm: never in the idle alarm's way
  const s = await rt.session.get();
  const { autoLock } = await rt.settings.get();
  if (!s || autoLock.mode !== "idle") return;
  const when = s.lastActive + autoLock.minutes * 60_000 + 1000;
  await chrome.alarms.create(ALARM_AUTOLOCK, { when: Math.max(when, Date.now() + 1000) });
}

/** One alarm for the live sk_quick's end (an expired one is deleted now). Nothing when there is none. */
async function rescheduleQuickExpiry(): Promise<void> {
  const end = await rt.service.enforceQuickExpiry();
  if (end !== null) await chrome.alarms.create(ALARM_QUICK, { when: Math.max(end + 1000, Date.now() + 1000) });
}

// The dev and e2e builds' worker also removes, at an install or an update, what the server sync's client left in a
// profile that once had it on, its records, its identity's database and its alarms (platform/server-sync-leftovers.ts;
// the build's define __SYNC_DEV__, below): the store and test builds never had a way to turn it on, and compile this
// out. A line in the diagnostics log says what went.
chrome.runtime.onInstalled.addListener(() => {
  void routine(true);
  if (typeof __SYNC_DEV__ === "boolean" && __SYNC_DEV__)
    void dropServerSyncLeftovers(rt.local, globalThis.indexedDB, chrome.alarms).then(
      (gone) => {
        const all = [...gone.keys, ...gone.alarms];
        if (all.length) note(`the server sync's leftovers removed: ${all.join(", ")}`);
      },
      () => undefined,
    );
});
chrome.runtime.onStartup.addListener(() => {
  void routine(true);
});

// Every event that may be about a site (any event that names a host) reconciles autofill's sites: a site withdrawn in
// Chrome's own UI stops counting at once. An added origin that is exactly the pattern of Sixkey's own ask for a site,
// under a minute old, puts that site on the list first (the page that asked may have closed when Chrome's dialog took the
// focus: platform/autofill-sites.ts acceptPending). A change of the list reconciles too (watchList). So does every event
// that names `scripting` (optional since wave 1b: MOD-PLATFORM §7.2 Option I item 3), granted or given back: without it
// nothing can be registered, and with it again the sites that count are registered. Events about API permissions alone
// (the clipboard pair) are not a site's.
const namesScripting = (p: { permissions?: string[] }) => (p.permissions ?? []).includes("scripting");
const mayBeSite = (p: { origins?: string[] }) => (p.origins?.length ?? 0) > 0;
chrome.permissions.onRemoved.addListener((p) => {
  if (mayBeSite(p) || namesScripting(p)) void reconcileSites();
});
chrome.permissions.onAdded.addListener((p) => {
  if (mayBeSite(p) || namesScripting(p))
    void acceptPending(p)
      .catch(() => false)
      .then(() => reconcileSites());
});
watchList(chrome.storage.local, reconcileSites);
// Autofill's switch (wave 1b): a run, and with autofill off the registration gone first, then each listed site's grant
// and `scripting` given back (platform/autofill-reconcile.ts followSwitch; the page that switched it touches none).
const switched = () =>
  followSwitch(reconcileSites, switchedOff, {
    sites: (off) => giveBackSites({ off }),
    scripting: () => chrome.permissions.remove({ permissions: ["scripting"] }),
  }).catch(() => undefined);
watchSwitch(chrome.storage.local, switched);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DAILY) void routine(false);
  // the site rules' updater's daily check (AF3-U2, below), with its release gate open only; a failed check changes nothing
  if (typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__ && alarm.name === ALARM_DAILY)
    void rulesUpdater()
      .then((u) => u.check())
      .catch(() => undefined);
  if (alarm.name === ALARM_AUTOLOCK) {
    void (async () => {
      const locked = await rt.service.enforceAutoLock();
      if (!locked) await rescheduleAutoLock(); // activity moved the deadline
    })();
  }
  if (alarm.name === ALARM_QUICK) void rescheduleQuickExpiry().catch(() => undefined);
  macLink.alarm(alarm.name); // the Mac link's pull (sk-mac-pull); false for every other
  csb.alarm(alarm.name); // the backup in Chrome sync's debounce and retries (sk-csb-*); false for every other
});

// Every automatic and quick lock is the soft lock (QUICK-UNLOCK §5.5): the unlocked key goes from every context (the
// lock epoch tells pages holding one in memory, and they drop it and the codes on screen), and a live PIN stays.
chrome.idle.onStateChanged.addListener((state) => {
  if (state !== "locked") return;
  void (async () => {
    if ((await rt.settings.get()).lockOnScreenLock) await rt.service.lock();
  })();
});

// The `lock` shortcut (QUICK-UNLOCK §5.12 items 2, 3): handled here, so it needs no page and no vault key, and works with
// no Sixkey page open and after the worker slept. Commands need no permission.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === LOCK_COMMAND) void rt.service.lock().catch(() => undefined);
  if (command === FILL_COMMAND) void fillShortcut(tab);
});

// Test builds only (the define of scripts/build.mjs; a production build compiles this out, check-dist looks for the name):
// the browser's shortcut keys cannot be pressed from a test, so the end-to-end tests call the command's handler.
declare const __SYNC_DEV__: boolean;
if (typeof __SYNC_DEV__ === "boolean" && __SYNC_DEV__)
  (globalThis as { __skFill?: typeof fillShortcut }).__skFill = (tab) => fillShortcut(tab);

/**
 * The `fill` shortcut (fill-command.ts): the tab it was pressed on (activeTab is granted for it), the vault if the worker
 * can open it, the fill, and a word on the toolbar icon. The vault is read here and nowhere kept; no activity is counted.
 */
async function fillShortcut(given: Tab | undefined): Promise<void> {
  const tab = given ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  await runShortcut(tab, {
    epoch: () => rt.session.lockEpoch(),
    entries: async () => {
      const view = await rt.service.openView();
      return view.state === "unlocked" ? aliveEntries(view.vault) : null;
    },
    session: chrome.storage.session,
    chrome: chrome as unknown as FillChrome,
    opens: action.plan?.opens,
    // the code only through the platform's gate, with the worker's vault key (MOD-PLATFORM §7.2 Option I item 1); while
    // locked, Sixkey for Mac's after its Touch ID, when linked (platform/mac-link.ts)
    deps: { code: gatedCode(() => rt.service.grantKeys()), off: switchedOff, mac: fillFromMac },
  });
}

let creating: Promise<void> | null = null;

/** Two copies close together must not both try to create the document: the second create throws and its clean-up would be lost. */
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen/index.html",
      reasons: ["CLIPBOARD" as chrome.offscreen.Reason],
      justification: "Clear the clipboard 30 seconds after a code is copied, if the clipboard still holds that code.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

// Every message passes the one sender test (sender-policy.ts, acceptedType) before anything runs: this extension's own
// page that the type's row names, nothing else. A content script has this extension's ID, so the ID alone is not a test
// (TOTP-AUTOFILL §4.2). A type with no row is ignored, and the handler table is typed over the worker's rows, so a row
// without a handler, or a handler without a row, fails `npm run typecheck`.
type Msg = { hash?: unknown; delayMs?: unknown };
const HANDLERS: {
  [K in Exclude<MessageFor<"worker">, CsbMessage>]: (m: Msg, reply: (r: unknown) => void) => void;
} = {
  // Pages ask for the idle alarm to be re-armed after unlocking or using the vault.
  "sk-reschedule-autolock": () => void rescheduleAutoLock(),
  // The popup asks for the clipboard clean-up. Only a hash of the code is passed along. The answer says the request was
  // taken (platform/clipboard.ts reports success only on it); a refused sender gets no answer at all.
  "sk-clip-arm": (m, reply) => {
    const { hash, delayMs } = m;
    if (typeof hash !== "string") return reply({ ok: false });
    reply({ ok: true });
    void (async () => {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ type: "sk-offscreen-arm", hash, delayMs });
    })().catch(() => undefined);
  },
  "sk-offscreen-done": () => void chrome.offscreen.closeDocument().catch(() => undefined),
};

const isCsb = (t: string): t is CsbMessage => (CSB_MESSAGES as readonly string[]).includes(t);

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const type = acceptedType(msg, sender, chrome.runtime.id, "worker");
  // the backup in Chrome sync's are answered by the listener below
  if (type === null || isCsb(type)) return;
  HANDLERS[type](msg as Msg, sendResponse); // answered at once or not at all: this listener never keeps the channel open
});

// The backup in Chrome sync's messages (CSB-3; platform/csb-worker.ts), from the settings page alone: answered after the
// work (return true keeps the channel open). Each handler checks the message's fields itself; turning on or off needs no
// unlock, a merge or a restore's adoption is taken only for the generation the page wrote.
const CSB_HANDLERS: { [K in CsbMessage]: (m: Record<string, unknown>) => Promise<unknown> } = {
  "sk-csb-on": () => csb.on(),
  "sk-csb-off": () => csb.off(),
  "sk-csb-now": () => csb.now(),
  "sk-csb-opens": (m) => csb.opens(m.opens).then((ok) => ({ ok })),
  "sk-csb-restored": (m) => csb.restored(m),
  "sk-csb-merged": (m) => csb.merged(m),
  "sk-csb-drop": (m) => csb.drop(m),
};
chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const type = acceptedType(msg, sender, chrome.runtime.id, "worker");
  if (type === null || !isCsb(type)) return;
  void CSB_HANDLERS[type](msg as Record<string, unknown>).then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});

// TOTP autofill's content script (src/inject/suggest.ts) on a site the user turned on: its own types only, which no other
// listener takes, from a sender the browser identifies as that content script (sender-policy.ts contentSender, checked
// first in contentMessage). Never answered: the page learns nothing from it. With the in-page suggestion's release gate
// open, `cand` alone is answered (whether to draw it, nothing else: no account, no lock state), for a sender that is the
// content script; contentMessage is called in the message's own task, so its first steps, the side panel's open among
// them, run before anything is awaited. The gate picks the listener; a build has one of the two.
chrome.runtime.onMessage.addListener(
  SUGGEST_UI
    ? (msg: unknown, sender, sendResponse) => {
        if (contentType(msg) === null) return; // a page's message is the two listeners' above
        if (contentType(msg) === "sk-af-cand" && contentSender(sender, chrome.runtime.id) !== null) {
          void contentMessage(msg, sender, sendResponse).catch(() => sendResponse({ show: false }));
          return true;
        }
        void contentMessage(msg, sender).catch(() => undefined);
      }
    : (msg: unknown, sender) => {
        if (contentType(msg) === null) return; // a page's message is the two listeners' above
        void contentMessage(msg, sender).catch(() => undefined);
      },
);

// The site rules' updater (TOTP autofill Stage 3, AF3-U2; platform/rules-live.ts), in a build whose release gate lets it
// in (scripts/rules-update.mjs, the build's define, used where it stands) and in no other: there the three statements below
// that use the define are dead code the build removes, and the function and the import with them (scripts/rules-guard.mjs
// would resolve the import to an empty module, and fail a build that held the module all the same). The worker is one
// file (no import() at run time: the bundler puts the module in it). Its daily check runs on `sk-daily` (the alarm
// listener above), and its two messages (sender-policy.ts rulesMessage) are answered after the work by a listener of their
// own, registered at the top level as every listener here: one host's rule for the Fill paths (`sk-af-rule`), the switch
// and its status line for Settings (`sk-af-rules-status`). Test builds (dev, e2e) also let a test start a check
// (`__skRules`), as `__skFill` lets it press the shortcut.
const rulesUpdater = () => import("../platform/rules-live").then((m) => m.updater());
function rulesListener(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) {
  const type = rulesMessage(msg, sender, chrome.runtime.id);
  if (type === null) return; // every other message is another listener's
  const m = msg as { host?: unknown; on?: unknown };
  void rulesUpdater()
    .then((u): Promise<unknown> | null =>
      type === "sk-af-rule"
        ? typeof m.host === "string"
          ? u.answer(m.host)
          : null
        : u.status(typeof m.on === "boolean" ? m.on : undefined),
    )
    .then(sendResponse, () => sendResponse(null));
  return true;
}
if (typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__) chrome.runtime.onMessage.addListener(rulesListener);
if (typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__ && typeof __SYNC_DEV__ === "boolean" && __SYNC_DEV__)
  (globalThis as { __skRules?: (force?: boolean) => Promise<string> }).__skRules = (force) =>
    rulesUpdater().then((u) => u.check(force));

void routine(false);
// (it waits for this start's access-level answer before it reads anything: the built worker's first calls stay those two).
// Not followSwitch: a start may be woken by an On click's grant, before that click's switch is written (PLUGINS-W1B-NOTES.md)
void reconcileSites();
