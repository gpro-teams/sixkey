// A future message type cannot ship without a sender policy (TOTP-AUTOFILL §4.2 item 1). This test reads the source: every
// message type the code sends or listens for must have a row in platform/sender-policy.ts, every row must be in use,
// every `runtime.onMessage` listener must start with the sender gate, and no other way into the worker or the offscreen
// document (external messages, ports) exists. A new alarm name is the only thing that needs a line here without a row.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTENT_MESSAGES, CSB_MESSAGES, MESSAGE_SENDERS } from "../../src/platform/sender-policy";
import { SCRIPT_ID } from "../../src/platform/autofill-register";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(EXT, "src");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
const code = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = walk(SRC).map((p) => ({
  path: relative(SRC, p).split("\\").join("/"),
  code: code(readFileSync(p, "utf8")),
}));
const file = (path: string) => files.find((f) => f.path === path)!;
const rows = Object.keys(MESSAGE_SENDERS).sort();
/** The content script's types (AUTOFILL2 patch 3): a table of their own, never a page's row (sender-policy.ts). */
// with the gated row (AUTOFILL2 patch 4a): `sk-af-open` is a row only with the in-page suggestion's release gate open
// (scripts/suggest-ui.mjs, the build's define, absent here), and is checked both ways in the built files by check-dist
const contentRows = [...new Set([...Object.keys(CONTENT_MESSAGES), "sk-af-open"])].sort();
/**
 * The site rules' updater's (TOTP autofill Stage 3, AF3-U2): a table of their own (sender-policy.ts RULES_SENDERS), which
 * is empty but with the updater's release gate open (the build's define, absent here), so written out here; their rows
 * and senders are test/unit/rules-update-worker.test.ts's, and check-dist checks them both ways in the built files.
 */
const rulesRows = ["sk-af-rule", "sk-af-rules-status"];

/** Strings that start like a message type but are alarm names (chrome.alarms): not messages. A new one is added here. */
const ALARM_NAMES = [
  "sk-daily",
  "sk-autolock",
  "sk-quick-expiry",
  // the server sync's four, named only to clear them (platform/server-sync-leftovers.ts; its client went, DV-0b)
  "sk-sync-sync",
  "sk-sync-kick",
  "sk-sync-retry",
  "sk-sync-periodic",
  "sk-csb-soon", // the backup in Chrome sync's debounce (CSB-3, platform/csb-worker.ts)
  "sk-csb-retry", // and its retries
];

describe("every message type has a sender policy", () => {
  it('every "sk-…" string in the source is a row of the table or a known alarm name', () => {
    const literals = new Set(
      files.flatMap((f) => [...f.code.matchAll(/["'`](sk-[a-z][a-z-]*)["'`]/g)].map((m) => m[1]!)),
    );
    const unknown = [...literals].filter(
      (l) =>
        !rows.includes(l) &&
        !contentRows.includes(l) &&
        !rulesRows.includes(l) &&
        !ALARM_NAMES.includes(l) &&
        l !== SCRIPT_ID,
    );
    // If this fails: a new message type needs a row in src/platform/sender-policy.ts MESSAGE_SENDERS (receiver and
    // senders) and a handler in sw.ts or offscreen/main.ts; a new alarm name goes in ALARM_NAMES above.
    expect(unknown).toEqual([]);
    expect(ALARM_NAMES.filter((a) => !literals.has(a))).toEqual([]); // no stale alarm names
    expect(rows.filter((r) => !literals.has(r))).toEqual([]); // no row that nothing uses
    expect(contentRows.filter((r) => !literals.has(r))).toEqual([]);
    expect(rulesRows.filter((r) => !literals.has(r))).toEqual([]);
  });

  it("the server sync's messages are gone with its client (DV-0b): no row, no literal, no constant; its alarms are named only to be cleared", () => {
    for (const t of ["sk-sync-soon", "sk-sync-changed", "sk-api"]) expect(rows, t).not.toContain(t);
    expect(
      files.filter((f) =>
        /["'`]sk-sync-(?:soon|changed)["'`]|["'`]sk-api["'`]|SYNC_SOON_MESSAGE|BRIDGE_MESSAGE/.test(f.code),
      ),
    ).toEqual([]);
    expect(files.filter((f) => /["'`]sk-sync-/.test(f.code)).map((f) => f.path)).toEqual([
      "platform/server-sync-leftovers.ts",
    ]);
  });

  it("every runtime.sendMessage in the source is in a file this list knows, and sends a row's type", () => {
    const senders = files
      .filter((f) => /runtime\.sendMessage\(/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(senders).toEqual([
      "background/sw.ts",
      "inject/suggest-ui.ts", // the in-page suggestion's two (AUTOFILL2 patch 4b): CONTENT_MESSAGES rows, as suggest.ts's
      "inject/suggest.ts", // the content script's one message: a CONTENT_MESSAGES row, never a page's (AUTOFILL2 patch 3)
      "offscreen/main.ts",
      "options/App.tsx",
      "options/DeviceBox.tsx", // Touch ID / Windows Hello's box: after an enrolment arms the gate, sk-reschedule-autolock (its expiry alarm)
      // (the PIN box no longer sends one: setting a PIN arms nothing in session memory since its record is its one way)
      "options/RulesUpdate.tsx", // the site rules' updater's switch (AF3-U2): sk-af-rules-status, its own table's
      "options/csb/merge.ts", // the backup in Chrome's sync storage's pages: their sk-csb-* rows, the worker's only
      "platform/clipboard.ts",
      "platform/site-rule.ts", // the Fill paths' ask of the updater (AF3-U2): sk-af-rule, its own table's
      "popup/App.tsx",
      "sidepanel/guard.ts", // the side panel's "list shown": sk-reschedule-autolock, as the popup's App sends it
    ]);
    for (const f of files)
      for (const m of f.code.matchAll(/runtime\.sendMessage\(\s*\{\s*type:\s*([^,}\s]+)/g)) {
        expect(m[1], `${f.path}: a literal type`).toMatch(/^"/);
        const t = m[1]!.slice(1, -1);
        if (f.path === "inject/suggest.ts" || f.path === "inject/suggest-ui.ts")
          expect(contentRows, `${f.path}: ${m[1]}`).toContain(t);
        else if (f.path === "options/RulesUpdate.tsx" || f.path === "platform/site-rule.ts")
          expect(rulesRows, `${f.path}: ${m[1]}`).toContain(t);
        else expect(rows, `${f.path}: ${m[1]}`).toContain(t);
      }
    // (the one call that passed a variable, the server sync's bridge, went with its client: DV-0b; every type is a literal)
    expect(files.filter((f) => /\btabs\.sendMessage\(|\bsendNativeMessage\b|\bconnectNative\b/.test(f.code))).toEqual(
      [],
    );
  });
});

describe("the listeners", () => {
  it("runtime.onMessage has listeners in the worker (four: the pages', the backup in Chrome sync's, the content script's, the site rules' updater's) and the offscreen document (one), nowhere else", () => {
    const where = Object.fromEntries(
      files
        .map((f) => [f.path, (f.code.match(/runtime\.onMessage\.addListener\(/g) ?? []).length])
        .filter(([, n]) => n),
    );
    // the site rules' updater's (AF3-U2) is registered with its release gate open only (the define, in the branch)
    expect(where).toEqual({ "background/sw.ts": 4, "offscreen/main.ts": 1 });
    expect(file("background/sw.ts").code).toMatch(
      /^if \(typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__\) chrome\.runtime\.onMessage\.addListener\(rulesListener\);$/m,
    );
  });

  it("no other way in: external messages, ports, the worker's own `message` event, channels, window messages", () => {
    const bad =
      /onMessageExternal|onConnectExternal|\bonConnect\b|runtime\.connect\(|onUserScriptMessage|onUserScriptConnect|BroadcastChannel|MessageChannel|\bonmessage\b|addEventListener\??\.?\(\s*["'`]message(?:error)?["'`]|\.postMessage\(|\bnew (?:Shared)?Worker\(/;
    // (the plugin platform's two ways, the worker's listener for other extensions and the ports a Sixkey page opened to
    // one, went with it: no file has any)
    expect(files.filter((f) => bad.test(f.code)).map((f) => f.path)).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(EXT, "manifest.base.json"), "utf8"));
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it("storage change handlers in the worker reread their own records, never use event values", () => {
    // A write to storage.local by anything that can write it would fire these; only trusted contexts can (storage-access.ts).
    // A listener in the worker would be a handler outside the sender gate, so this list is explicit: add a file knowingly.
    // The one in the worker (platform/action-mode.ts, the side panel: docs/design/notes/SIDEPANEL-NOTES.md) takes nothing
    // from the change but the names of two keys, and then reads both keys itself and applies them, as at every start of
    // the worker: below, it never reads a change's value.
    const users = files.filter((f) => /\bonChanged\b/.test(f.code)).map((f) => f.path);
    // (sw.ts itself had one until CSB-3, the Drive path's listener on the plugin's approval: unwired with that path)
    expect(users.filter((p) => /^(background|offscreen)\//.test(p))).toEqual([]);
    const worker = file("background/sw.ts").code;
    expect(worker).not.toMatch(/newValue|oldValue/);
    // the Drive path's listener on the official plugin's approval left the worker in CSB-3 (that path unwired): sw.ts
    // adds no storage listener of its own; each listener of the worker is in its own module (below)
    expect(worker).not.toMatch(/onChanged\??\.addListener/);
    expect(worker).not.toMatch(/GRANTS_KEY|OVERLAY_KEY|providerReady/);
    const action = file("platform/action-mode.ts").code;
    expect(action.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(action).toMatch(
      /onChanged\?\.addListener\(\(changes\) => \{\s*if \(OPENER_KEY in changes \|\| "sk_settings" in changes\) void apply\(\);\s*\}\)/,
    );
    expect(action).not.toMatch(/newValue|oldValue/);
    // the worker's second (AUTOFILL2 patch 2): a change of autofill's list starts a reconcile, which reads the list itself
    const sites = file("platform/autofill-sites.ts").code;
    expect(sites.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(sites).toMatch(
      /onChanged\.addListener\(\(changes\) => \{\s*if \(SITES_KEY in changes\)\s*void reconcile\(\);\s*\}\)/,
    );
    expect(sites).not.toMatch(/newValue|oldValue/);
    // the worker's third (wave 1b, PLUGINS-W1B-NOTES.md): a write of the grant store (where autofill's switch is) starts
    // followSwitch, which reads the record itself
    const sw = file("platform/plugins/autofill-switch.ts").code;
    expect(sw.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(sw).toMatch(/onChanged\.addListener\(\(changes\) => \{\s*if \(GRANTS_KEY in changes\)\s*void f\(\);\s*\}\)/);
    expect(sw).not.toMatch(/newValue|oldValue/);
    // (the worker's fourth, the plugin platform's proposals' watch, went with the platform)
    // the worker's fifth (CLOUDBK patch 4, moved to csb-worker.ts in CSB-3): a write of the store's pointer (a commit,
    // from any context) starts the backup's debounce, which reads what it needs itself
    const csbWorker = file("platform/csb-worker.ts").code;
    expect(csbWorker.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(csbWorker).toMatch(
      /onChanged\.addListener\(\(changes\) => \{\s*if \(VAULT_POINTER in changes\) void changed\(\)\.catch\(\(\) => undefined\);\s*\}\)/,
    );
    expect(csbWorker).not.toMatch(/newValue|oldValue/);
    // and the worker's start watches the store's pointer once, for the backup in Chrome sync; nothing watches
    // storage.sync in the worker (C17: its runs and its daily check suffice)
    expect(worker.match(/\bwatchVault\(/g)).toHaveLength(1);
    expect(worker).toMatch(/^watchVault\(chrome\.storage\.local, \(\) => csb\.changed\(\)\);$/m);
    // (the popup's and the side panel's watch on the plugin platform's proposals went with it: chrome.ts watches nothing)
    expect(file("platform/plugins/chrome.ts").code).not.toMatch(/onChanged/);
    // and the "same sign-in" chunk's (AF3-4, round 3): a lock (the epoch moved) empties what it keeps; it reads nothing
    const aliases = file("popup/main/aliases.ts").code;
    expect(aliases.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(aliases).toMatch(
      /onChanged\.addListener\(\(changes\) => \{\s*if \("sk_lock_epoch" in changes\) pages = new Map\(\);\s*\}\)/,
    );
    expect(aliases).not.toMatch(/newValue|oldValue/);
    // and the settings page's watch on the backup in Chrome's sync storage (first run's copy found and its restore): a
    // change of a slot's key reads the whole area again, never the change's values
    const csb = file("platform/csb-read.ts").code;
    expect(csb.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(csb).toMatch(
      /const changed = \(changes: Record<string, unknown>\) => \{\s*if \(Object\.keys\(changes\)\.some\(\(k\) => parseKey\(k\) !== null\)\) void read\(\);\s*\};/,
    );
    expect(csb).not.toMatch(/newValue|oldValue/);
    // and its card's watch on its two records: a change of either reads both again, never the change's values
    const card = file("options/csb/CsbCard.tsx").code;
    expect(card.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(card).toMatch(
      /const changed = \(c: Record<string, unknown>\) => \{\s*if \(CSB_CFG_KEY in c \|\| CSB_STATE_KEY in c\) void refresh\(\);\s*\};/,
    );
    expect(card).not.toMatch(/newValue|oldValue/);
    // and the popup's and the side panel's pill and footer of that backup: a change of either record reads both again
    // (once, whoever shows them), never the change's values
    const pop = file("popup/main/CsbPop.tsx").code;
    expect(pop).not.toMatch(/onChanged\??\.addListener/); // (added through `events`, below)
    expect(pop.match(/events\?\.addListener\(changed\)/g)).toHaveLength(1);
    expect(pop).toMatch(
      /const changed = \(x: Record<string, unknown>\) => void \(\(CSB_CFG_KEY in x \|\| CSB_STATE_KEY in x\) && readRecs\(true\)\);/,
    );
    expect(pop).not.toMatch(/newValue|oldValue/);
    // and the count of those records' changes from the page's start (before the open's read of them): a change of
    // either counts, never the change's values
    const marks = file("popup/csb-changes.ts").code;
    expect(marks.match(/onChanged\??\.addListener/g)).toHaveLength(1);
    expect(marks).toMatch(
      /area\.onChanged\.addListener\(\(c\) => void \(\(CSB_CFG_KEY in c \|\| CSB_STATE_KEY in c\) && n\+\+\)\);/,
    );
    expect(marks).not.toMatch(/newValue|oldValue/);
    expect(users).toEqual([
      "options/App.tsx",
      "options/Backup.tsx",
      "options/DeviceBox.tsx", // Touch ID / Windows Hello's box follows sk_prf and the session record, as PinBox (PRF-NOTES.md)
      "options/MasterField.tsx",
      "options/Misc.tsx", // Settings › Security › Autofill follows the list of sites (AUTOFILL2-NOTES.md §7)
      "options/PinBox.tsx",
      "options/SecurityCard.tsx",
      "options/csb/CsbCard.tsx", // the backup in Chrome's sync storage's card follows its two records (below)
      "options/settings-store.ts", // the settings page follows a change of the settings record made elsewhere (QUICKVIEW-NOTES.md)
      "options/shared.tsx",
      "platform/action-mode.ts", // the worker's: what the toolbar icon opens (above)
      "platform/autofill-sites.ts", // the worker's: autofill's list of sites (above)
      "platform/csb-read.ts", // the backup in Chrome's sync storage: the slots, while a page waits for one (above)
      "platform/csb-worker.ts", // the worker's: the backup's debounce (above)
      "platform/fill-request.ts", // the popup's and the side panel's watch on the pending fill request (AUTOFILL2-NOTES.md)
      "platform/plugins/autofill-switch.ts", // the worker's: autofill's switch (above)
      "popup/App.tsx",
      "popup/csb-changes.ts", // the count of the backup's records' changes from the page's start (above)
      "popup/main/CsbPop.tsx", // the backup in Chrome sync's pill and footer follow its two records (below)
      "popup/main/View.tsx", // the View menu, while it is open: a change of the settings record, by whoever made it (QUICKVIEW-NOTES.md)
      "popup/main/aliases.ts", // the "same sign-in" chunk: emptied at a lock (AUTOFILL3-NOTES.md §8.12)
      "sidepanel/guard.ts", // the side panel follows commits, settings and unlocks made elsewhere
      "ui/PasswordGroups.tsx", // the grouped input both pages draw: emptied at a lock (PASSWORD-SETUP-NOTES §8.2)
      "ui/ShareEntry.tsx", // the recovery code shares' entry both pages draw: emptied at a lock (SHAMIR-NOTES.md §5)
    ]);
  });

  it("every listener's first act is the sender gate, for its own receiver; neither file reads a message's `type` any other way", () => {
    for (const [path, receivers] of [
      ["background/sw.ts", ["worker", "worker", "content", "rules"]],
      ["offscreen/main.ts", ["offscreen"]],
    ] as const) {
      const c = file(path).code;
      const starts = [...c.matchAll(/runtime\.onMessage\.addListener\(/g)].map((m) => m.index!);
      expect(starts).toHaveLength(receivers.length);
      starts.forEach((at, i) => {
        if (receivers[i] === "content") {
          // the content script's (AUTOFILL2 patch 3): its own types only, then platform/content-channel.ts, whose first
          // acts are the same type test and the browser's sender (contentSender). Patch 4a: the in-page suggestion's release
          // gate picks one of two arrows, both opening with the type test; the gate's keeps the channel open for an answer
          // to `cand` only, and only for a sender that is the content script
          const call = c
            .slice(at, at + 900)
            .replace(/\/\/[^\n]*/g, "")
            .replace(/\s+/g, " ");
          expect(call, `${path} listener ${i}`).toMatch(
            /^runtime\.onMessage\.addListener\( SUGGEST_UI \? \(msg: unknown, sender, sendResponse\) => \{ if \(contentType\(msg\) === null\) return; if \(contentType\(msg\) === "sk-af-cand" && contentSender\(sender, chrome\.runtime\.id\) !== null\) \{/,
          );
          expect(call, `${path} listener ${i}`).toMatch(
            / : \(msg: unknown, sender\) => \{ if \(contentType\(msg\) === null\) return; void contentMessage\(msg, sender\)\.catch\(\(\) => undefined\); \}, \);/,
          );
          return;
        }
        if (receivers[i] === "rules") {
          // the site rules' updater's (AF3-U2): a named function, registered at the top level behind the gate; its first
          // act is its own table's gate (sender-policy.ts rulesMessage), which takes only its two types from their pages
          expect(c.slice(at, at + 60), `${path} listener ${i}`).toMatch(
            /^runtime\.onMessage\.addListener\(rulesListener\);/,
          );
          const fn = c.indexOf("function rulesListener(");
          expect(c.slice(fn, fn + 300).replace(/\s+/g, " "), `${path} listener ${i}`).toMatch(
            /^function rulesListener\(msg: unknown, sender: chrome\.runtime\.MessageSender, sendResponse: \(r: unknown\) => void\) \{ const type = rulesMessage\(msg, sender, chrome\.runtime\.id\); if \(type === null\) return;/,
          );
          return;
        }
        const head = c.slice(at, at + 220);
        expect(head, `${path} listener ${i}`).toMatch(
          new RegExp(`acceptedType\\(msg, sender, chrome\\.runtime\\.id, "${receivers[i]}"\\)`),
        );
        // nothing but the signature comes before the gate
        expect(head.split("acceptedType(")[0]!.replace(/\s+/g, " ")).toMatch(
          /^runtime\.onMessage\.addListener\(\(msg: unknown, sender(, sendResponse)?\) => \{ (const type = )?(if \()?$/,
        );
      });
      expect(c, `${path} must not look at a message's type itself`).not.toMatch(/\.type\b/);
    }
  });

  it("the worker's handler tables have exactly the worker's rows", () => {
    const c = file("background/sw.ts").code;
    const block = c.slice(c.indexOf("const HANDLERS"), c.indexOf("const isCsb"));
    const keys = [...block.matchAll(/^ {2}"(sk-[a-z-]+)":/gm)].map((m) => m[1]!).sort();
    const csbBlock = c.slice(c.indexOf("const CSB_HANDLERS"), c.lastIndexOf("chrome.runtime.onMessage.addListener"));
    const csbKeys = [...csbBlock.matchAll(/^ {2}"(sk-[a-z-]+)":/gm)].map((m) => m[1]!).sort();
    const worker = rows.filter((r) => MESSAGE_SENDERS[r as keyof typeof MESSAGE_SENDERS].to === "worker");
    // the backup in Chrome sync's (CSB-3) have their own table, answered after the work by their own listener; the
    // Google Drive backup's rows went with its code: every worker row has a handler, and every row has a sender
    expect([...keys, ...csbKeys].sort()).toEqual(worker);
    expect(csbKeys).toEqual([...CSB_MESSAGES].sort());
    for (const r of rows) expect(MESSAGE_SENDERS[r as keyof typeof MESSAGE_SENDERS].from.length, r).toBeGreaterThan(0);
    expect(c).not.toMatch(/sk-cloud-|CLOUD_HANDLERS|CloudMessage/);
    expect(c).toMatch(/const HANDLERS: \{\s*\[K in Exclude<MessageFor<"worker">, CsbMessage>\]:/); // typed over the rows
    expect(c).toMatch(/const CSB_HANDLERS: \{ \[K in CsbMessage\]:/);
  });

  it("only the worker and the offscreen document import the sender policy (the popup's budget), and nothing there imports a page", () => {
    expect(files.filter((f) => /sender-policy/.test(f.code)).map((f) => f.path)).toEqual([
      "background/sw.ts",
      "offscreen/main.ts",
      "platform/content-channel.ts", // the worker's end of the content script's messages, imported by sw.ts only
      "platform/content-page.ts", // that end with the in-page suggestion's gate open (AUTOFILL2 patch 4a), the worker's only
    ]);
    // and, with the in-page suggestion's gate open, by its two modules (content-page.ts: the channel's types only;
    // content-page-worker.ts: the gate's channel, which sw.ts builds instead of patch 3's)
    expect(files.filter((f) => /content-channel/.test(f.code)).map((f) => f.path)).toEqual([
      "background/sw.ts",
      "platform/content-page-worker.ts",
      "platform/content-page.ts",
    ]);
    expect(code(readFileSync(join(SRC, "platform/sender-policy.ts"), "utf8"))).not.toMatch(/^import /m);
  });
});
