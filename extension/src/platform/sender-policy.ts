// Who may send which message (TOTP-AUTOFILL §4.2 item 1). Every message the service worker or the offscreen document
// accepts has one row in MESSAGE_SENDERS: the receiver, and the extension pages that may send it. Anything else is
// ignored without an answer: a type with no row, a sender that is not one of those pages, and a sender that is a content
// script or any other context that carries the extension's ID but not one of its pages.
//
// Why this is needed before any content script exists: `runtime.sendMessage` from a content script (or from code
// injected with `scripting.executeScript`, or a compromised renderer acting as one) carries this extension's ID, and the
// message reaches every extension context. So `sender.id === chrome.runtime.id` proves nothing about the page. The
// checks that do:
//   - `sender.url` is a URL of this extension (scheme chrome-extension:, host exactly this ID) at exactly the path of an
//     allowed page: the browser sets it, a page cannot choose it. A content script's `url` is the web page's;
//   - `sender.origin`, when the browser gives one (Chrome 80+), is this extension's origin;
//   - `sender.tab`, when there is one (an extension page open in a tab, such as the settings page), has a URL that is
//     one of this extension's own pages. A tab with a web URL or with no readable URL is refused;
//   - the page is in the row's list. The popup cannot send the offscreen document's message, and the offscreen document
//     cannot send the popup's.
//   - the side panel (src/sidepanel/) is a page of its own, at its own path, though it draws the popup's screens: it sends
//     exactly the popup's two messages, the ones its screens send (the idle alarm, the clipboard), and no other. A side panel is no tab, so it has no `sender.tab` [unverified in a real panel: SIDEPANEL-NOTES.md].
//
// This module is imported by the service worker and the offscreen document only. The popup and the settings page do not
// import it (the popup's size budget). The message types are written out here, not imported, for the same reason
// (runtime-base.ts is in the popup's graph); test/unit/autofill-pre-sender.test.ts compares them with the constants.
//
// A new message type needs a row here: the service worker's and the offscreen document's handler tables are typed over
// these rows (a missing or an extra handler fails `npm run typecheck`), and a source test lists every type the code
// sends or reads and fails on one without a row.

// (The developer sync page, a sender in dev and e2e builds only, and the server sync's three messages, sk-sync-soon,
// sk-sync-changed and sk-api, went with that sync's client: OWNER-DECISIONS/25, DV-0b.)

/** The extension's own contexts that send messages, each with its page (or script) path. */
export type Surface = "popup" | "sidepanel" | "options" | "offscreen" | "worker";

/** The path of each surface's page; `worker` is the service worker script. */
export const SURFACE_PATHS: Readonly<Record<Surface, string>> = {
  popup: "/popup/index.html",
  sidepanel: "/sidepanel/index.html",
  options: "/options/index.html",
  offscreen: "/offscreen/index.html",
  worker: "/sw.js",
};

type Row = { readonly to: "worker" | "offscreen"; readonly from: readonly Surface[] };

/**
 * The table. `to` is the receiver; `from` is every surface that may send the type, no other. Where each is sent:
 *   sk-reschedule-autolock: popup/App.tsx, sidepanel/guard.ts, options/App.tsx,
 *                           options/DeviceBox.tsx (a gate armed by an enrolment: its expiry alarm)
 *   sk-clip-arm:            platform/clipboard.ts, from the popup, the side panel and the settings page
 *   sk-offscreen-arm:       the service worker, to the offscreen document
 *   sk-offscreen-done:      the offscreen document, to the service worker
 */
export const MESSAGE_SENDERS = {
  "sk-reschedule-autolock": { to: "worker", from: ["popup", "sidepanel", "options"] },
  "sk-clip-arm": { to: "worker", from: ["popup", "sidepanel", "options"] },
  "sk-offscreen-done": { to: "worker", from: ["offscreen"] },
  "sk-offscreen-arm": { to: "offscreen", from: ["worker"] },
  // The backup in Chrome's sync storage (CSB-3; platform/csb-worker.ts): turned on and off, a run now, the switch
  // "只用恢复密钥打开", a restore's adoption of the slot it continues, a held slot's merge, and the removal of the other
  // slots a merge took in. The settings page alone (its card and first run, CSB-4): the popup never sends one.
  "sk-csb-on": { to: "worker", from: ["options"] },
  "sk-csb-off": { to: "worker", from: ["options"] },
  "sk-csb-now": { to: "worker", from: ["options"] },
  "sk-csb-opens": { to: "worker", from: ["options"] },
  "sk-csb-restored": { to: "worker", from: ["options"] },
  "sk-csb-merged": { to: "worker", from: ["options"] },
  "sk-csb-drop": { to: "worker", from: ["options"] },
} as const satisfies Record<string, Row>;

/** The backup in Chrome sync's messages: answered by their own listener, after the work (sw.ts). */
export const CSB_MESSAGES = [
  "sk-csb-on",
  "sk-csb-off",
  "sk-csb-now",
  "sk-csb-opens",
  "sk-csb-restored",
  "sk-csb-merged",
  "sk-csb-drop",
] as const satisfies readonly MessageType[];
export type CsbMessage = (typeof CSB_MESSAGES)[number];

export type MessageType = keyof typeof MESSAGE_SENDERS;

type Receiver = Row["to"];
/** The types one receiver accepts. */
export type MessageFor<R extends Receiver> = {
  [K in MessageType]: (typeof MESSAGE_SENDERS)[K]["to"] extends R ? K : never;
}[MessageType];

/** The type of a message, if it is an object with a string `type` that has a row (own property only: no `constructor`). */
export function knownType(msg: unknown): MessageType | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg) || !Object.hasOwn(msg, "type")) return null;
  const t = (msg as { type?: unknown }).type;
  return typeof t === "string" && Object.hasOwn(MESSAGE_SENDERS, t) ? (t as MessageType) : null;
}

type Sender = { id?: string; url?: string; origin?: string; tab?: { url?: string } } | undefined;

/** The URL's path if it is a URL of this extension: scheme chrome-extension:, host exactly `selfId`, no userinfo or port. */
function ownPath(url: unknown, selfId: string): string | null {
  if (typeof url !== "string" || selfId === "") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "chrome-extension:" || u.host !== selfId || u.username !== "" || u.password !== "") return null;
  return u.pathname;
}

/**
 * Which of the extension's own surfaces sent this, or null: not this extension, not one of its pages, or a context
 * (a content script, a tab with a web URL) that only carries its ID.
 */
export function surfaceOf(sender: Sender, selfId: string): Surface | null {
  if (!sender || selfId === "" || sender.id !== selfId) return null;
  const path = ownPath(sender.url, selfId);
  if (path === null) return null;
  if (sender.origin !== undefined && sender.origin !== `chrome-extension://${selfId}`) return null;
  if (sender.tab !== undefined && ownPath(sender.tab.url, selfId) === null) return null;
  for (const [surface, p] of Object.entries(SURFACE_PATHS) as [Surface, string][]) if (p === path) return surface;
  return null;
}

/**
 * The message's type if `receiver` accepts it from this sender, else null (the caller ignores the message: no answer,
 * no work, no error). One test for every message, so no type can be handled without it.
 */
export function acceptedType<R extends Receiver>(
  msg: unknown,
  sender: Sender,
  selfId: string,
  receiver: R,
): MessageFor<R> | null {
  const type = knownType(msg);
  if (type === null) return null;
  const row: Row = MESSAGE_SENDERS[type];
  if (row.to !== receiver) return null;
  const from = surfaceOf(sender, selfId);
  return from !== null && row.from.includes(from) ? (type as MessageFor<R>) : null;
}

// ---- the site rules' updater (TOTP autofill Stage 3, AF3-U2; docs/design/notes/AUTOFILL3-NOTES.md §10) ---------------
// Two messages to the worker, in a build whose updater's release gate is open (scripts/rules-update.mjs, the build's
// define) and in no other: there, the table below is empty and rulesMessage takes nothing, so neither type is named (check-
// dist). Like the content script's, they have no row in MESSAGE_SENDERS (acceptedType never takes them) and the
// worker answers them in a listener of their own (background/sw.ts):
//   sk-af-rule:          one host's rule from the live bundle in use (platform/site-rule.ts), from the Fill paths
//   sk-af-rules-status:  the switch and its status line, and turning it on or off (options/RulesUpdate.tsx)
declare const __RULES_UPDATE__: boolean;
const RULES_UPDATE = typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__;
export type RulesMessage = "sk-af-rule" | "sk-af-rules-status";
/** Who may send each (gate open only; empty otherwise). */
export const RULES_SENDERS: Readonly<Partial<Record<RulesMessage, readonly Surface[]>>> = RULES_UPDATE
  ? { "sk-af-rule": ["popup", "sidepanel"], "sk-af-rules-status": ["options"] }
  : {};

/** The updater's message type, if `msg` is one and this sender's page may send it; else null (always, gate closed). */
export function rulesMessage(msg: unknown, sender: Sender, selfId: string): RulesMessage | null {
  if (!RULES_UPDATE) return null;
  if (typeof msg !== "object" || msg === null || Array.isArray(msg) || !Object.hasOwn(msg, "type")) return null;
  const t = (msg as { type?: unknown }).type;
  if (typeof t !== "string" || !Object.hasOwn(RULES_SENDERS, t)) return null;
  const from = surfaceOf(sender, selfId);
  return from !== null && RULES_SENDERS[t as RulesMessage]!.includes(from) ? (t as RulesMessage) : null;
}

// ---- content scripts (TOTP autofill Stage 2, patch 3; AUTOFILL2-PLAN §4.1; docs/design/notes/AUTOFILL2-NOTES.md §9) ----
// The one kind of sender that is not one of Sixkey's pages: the registered content script (src/inject/suggest.ts) on a
// site the user turned on. Its types have no row in MESSAGE_SENDERS, so acceptedType never takes them, and a page's
// types are never taken from it (the worker's third listener answers only these). Who sent a message is taken from the
// browser alone: the frame's origin, address, frame and document IDs, the tab and its address, all set by Chrome, never by
// the page (a renderer that never ran Sixkey's content script and claims to be one is ended by the browser: AUTOFILL2-PLAN
// §5.1 F10). Nothing in the message itself says who sent it or where it is: any field but `type` is ignored.

// The release gate of the in-page suggestion (scripts/suggest-ui.mjs, the build's define): a constant of this module,
// which the build folds, so a build with the gate closed has no `open` row (and so no `open` at all: check-dist).
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;
type ContentRow = { readonly to: "worker"; readonly from: "content" };

/** The content script's messages: the receiver, and that the sender is a content script. */
export const CONTENT_MESSAGES: Readonly<Record<"sk-af-cand", ContentRow> & Partial<Record<"sk-af-open", ContentRow>>> =
  {
    // a trusted click or key press in a code box, on a site the user turned on: the worker may set the toolbar badge (and,
    // with the gate open, answers whether the content script may draw its suggestion)
    "sk-af-cand": { to: "worker", from: "content" },
    // with the gate open (AUTOFILL2 patch 4): the user's click on that suggestion; the worker may open Sixkey's own surface
    // for that document, once (platform/content-channel.ts)
    ...(SUGGEST_UI ? { "sk-af-open": { to: "worker", from: "content" } as const } : {}),
  };
export type ContentMessage = "sk-af-cand" | "sk-af-open";

/** The type of a content script's message, if it is one (own property `type` only), else null. */
export function contentType(msg: unknown): ContentMessage | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg) || !Object.hasOwn(msg, "type")) return null;
  const t = (msg as { type?: unknown }).type;
  return typeof t === "string" && Object.hasOwn(CONTENT_MESSAGES, t) ? (t as ContentMessage) : null;
}

/** Where a content script's message came from, as the browser says: never what the message says. */
export type ContentSender = {
  tabId: number;
  windowId: number;
  frameId: number;
  documentId: string;
  /** The frame's own host (https, the default port): the site its message is about. */
  host: string;
  /** The host of the page in the tab (the top page), https too: a site in its own right. */
  topHost: string;
};

type BrowserSender = {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  documentId?: string;
  documentLifecycle?: string;
  tab?: { id?: number; windowId?: number; url?: string; active?: boolean; incognito?: boolean };
};

/** The host of an https origin at the default port with nothing else in it, or null. */
function httpsHost(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && u.origin === origin
    ? u.hostname
    : null;
}

/**
 * A content script's sender, or null (the message is then ignored: no answer, no work). This extension's; in a tab that
 * is in front of its window, not incognito, with an address; from a live document (not prerendered, not in the
 * back-forward cache) with its frame and document IDs; whose frame origin is https at the default port, with the frame's
 * address on that origin; and whose top page is https too. Whether the hosts are sites the user turned on, and granted, is
 * the caller's to ask (platform/content-channel.ts), from the hosts this returns.
 */
export function contentSender(sender: BrowserSender | undefined, selfId: string): ContentSender | null {
  if (!sender || selfId === "" || sender.id !== selfId) return null;
  const tab = sender.tab;
  if (!tab || !Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId) || typeof tab.url !== "string")
    return null;
  if (tab.active !== true || tab.incognito === true) return null;
  if (typeof sender.documentId !== "string" || sender.documentId === "" || !Number.isSafeInteger(sender.frameId))
    return null;
  if (sender.documentLifecycle !== "active") return null;
  const host = httpsHost(sender.origin);
  if (host === null || typeof sender.url !== "string" || !sender.url.startsWith(`${sender.origin}/`)) return null;
  let top: URL;
  try {
    top = new URL(tab.url);
  } catch {
    return null;
  }
  const topHost = httpsHost(top.origin);
  if (topHost === null) return null;
  return {
    tabId: tab.id!,
    windowId: tab.windowId!,
    frameId: sender.frameId!,
    documentId: sender.documentId,
    host,
    topHost,
  };
}
