// The sites with code suggestions, and Chrome's grant for each (TOTP autofill Stage 2, patch 2; AUTOFILL2-PLAN §3.1 and
// §3.3 with its review's M7 and m4; docs/design/notes/AUTOFILL2-NOTES.md §7). Two halves, both needed for a site to count:
//   - the list, `sk_af_sites` in chrome.storage.local ({v: 1, hosts}, at most 32): the sites the user turned on in Sixkey.
//     It is device-local, like Chrome's grants (TOTP-AUTOFILL §0.7 item 1): never synced, backed up or exported. It is
//     written only right after a granted request for that one site, made by a click in Sixkey (the Fill card's offer in
//     the popup or the side panel, Settings' "Turn on again"), and edited only here, under one lock, by those pages and the
//     worker. Nothing removes a site from it but the user's Remove: a site whose grant was withdrawn in Chrome's own UI
//     stays on it, shown as "Turned off in Chrome" (review m4), and counts for nothing until it is granted again;
//   - Chrome's grant of the site's one pattern (that exact host over https: core/autofill-sites.ts sitePattern), from the
//     manifest's optional pattern of every https site. A broad grant chosen in Chrome's menus ("On all sites") covers
//     every site's pattern, so it is never what turns a site on: only the list does.
// The request is the first statement of the click (a gesture spent on an await is gone), and the same synchronous run
// notes the ask in chrome.storage.session (`sk_af_pending`: the host and when, nothing else), so a toolbar popup that
// Chrome's dialog closed still gets its site on the list: the worker's permissions.onAdded finishes it, for exactly that
// pattern and within a minute (review M7). "Not now" is `sk_af_later` in chrome.storage.session: gone when the browser
// closes (TOTP-AUTOFILL §8.3). What the sites are used for (patch 3's content script) is decided by
// platform/autofill-reconcile.ts, from both halves.
import { MAX_SITES, readSites, siteHostOk, sitePattern, sitesRecord } from "../core/autofill-sites";
import { grantedExactly, type GrantList } from "./permission-grants";
import { webLock } from "./locks";

/** The list (chrome.storage.local). */
export const SITES_KEY = "sk_af_sites";
/** Sixkey's last ask for a site, until it is answered or a minute has passed (chrome.storage.session). */
export const PENDING_KEY = "sk_af_pending";
/** The sites whose offer was answered "Not now", or refused in Chrome's dialog (chrome.storage.session). */
export const LATER_KEY = "sk_af_later";
/** How long the worker may finish an ask that its page did not (review M7). */
export const PENDING_MS = 60_000;
/**
 * The page hint that autofill is switched off (page localStorage; platform/plugins/autofill-switch.ts writes it with the
 * switch): read in a click by the popup, the side panel and Settings, so that none of them asks Chrome for `scripting`, or
 * offers a site, while it is off, without a chrome.storage read at their open (perf.spec's six). Only a reason not to
 * ask: what decides is the platform's gate, and what keeps autofill out of pages is `scripting` given back.
 */
export const OFF_HINT = "sk_af_off";
/** Whether this browser's pages last saw autofill switched off (the hint above). */
export function offHint(): boolean {
  try {
    return localStorage.getItem(OFF_HINT) !== null;
  } catch {
    return false;
  }
}
/** The hint written with the switch (platform/plugins/autofill-switch.ts only). */
export function setOffHint(off: boolean): void {
  try {
    if (off) localStorage.setItem(OFF_HINT, "1");
    else localStorage.removeItem(OFF_HINT);
  } catch {
    /* no page storage: a click asks Chrome, and the gate refuses the code */
  }
}
/**
 * The worker's watch on the list (src/background/sw.ts): a change of `sk_af_sites`, made by a trusted context, starts a
 * reconcile. Nothing is taken from the change but its key: the run reads the list itself, as platform/action-mode.ts does.
 */
export function watchList(
  local: { onChanged: { addListener(f: (changes: Record<string, unknown>) => void): void } },
  reconcile: () => unknown,
): void {
  local.onChanged.addListener((changes) => {
    if (SITES_KEY in changes) void reconcile();
  });
}

/** The chrome.permissions calls used here (tests pass fakes). */
export type SitePermissions = {
  contains(p: { origins: string[] }): Promise<boolean>;
  request(p: { permissions?: string[]; origins: string[] }): Promise<boolean>;
  remove(p: { origins: string[] }): Promise<boolean>;
} & GrantList;
/** The part of a storage area used here (chrome.storage.local or .session; tests pass MemoryKV). */
export type SiteArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};
const permissions = (): SitePermissions => chrome.permissions as unknown as SitePermissions;
const localArea = (): SiteArea => chrome.storage.local as unknown as SiteArea;
const sessionArea = (): SiteArea | undefined => globalThis.chrome?.storage?.session as unknown as SiteArea | undefined;

const lock = webLock("sixkey-af-sites");

/** The hosts on a list kept under `key` (the sites, or "Not now"), as read back; none when it cannot be read. */
async function hostsAt(area: SiteArea, key: string): Promise<string[]> {
  try {
    return readSites((await area.get([key]))[key]);
  } catch {
    return [];
  }
}
/** The sites on the list. */
export const readList = (local: SiteArea = localArea()): Promise<string[]> => hostsAt(local, SITES_KEY);
/** The sites answered "Not now" since the browser started. */
export const laterList = (session: SiteArea | undefined = sessionArea()): Promise<string[]> =>
  session ? hostsAt(session, LATER_KEY) : Promise.resolve([]);

/** One change of a list, read and written in one critical section (the popup, the side panel, Settings, the worker). */
function edit(area: SiteArea, key: string, f: (hosts: string[]) => string[] | null): Promise<string[]> {
  return lock(async () => {
    const hosts = readSites((await area.get([key]))[key]);
    const next = f(hosts);
    if (next === null) return hosts;
    await area.set({ [key]: sitesRecord(next) });
    return next;
  });
}
const adding = (host: string) => (hosts: string[]) =>
  !siteHostOk(host) || hosts.includes(host) || hosts.length >= MAX_SITES ? null : [...hosts, host];

/** Put a site on the list; true if it is on it now (not for a host that may not be, nor past MAX_SITES). */
export const addSite = async (host: string, local: SiteArea = localArea()): Promise<boolean> =>
  (await edit(local, SITES_KEY, adding(host))).includes(host);

/** Whether Chrome grants the site's pattern now (a broad grant counts here: the list is what decides). */
export async function siteGranted(host: string, p: SitePermissions = permissions()): Promise<boolean> {
  const pattern = sitePattern(host);
  if (pattern === null) return false;
  try {
    return await p.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Chrome's prompt for one site, exactly https://<host>/* and nothing else, with `scripting` in the same request (optional
 * since wave 1b, MOD-PLATFORM §7.2 Option I item 3: a site turned on before the first Fill gets it there; it adds nothing
 * to the prompt). True: granted, or already granted. Call it as the FIRST statement of the click handler, before any
 * await: Chrome grants a request only in the user's gesture. The ask is noted (sk_af_pending) in the same synchronous run,
 * after the request and without waiting for it. A host that may not be turned on (http, an IP address, a shared suffix,
 * the API host) is never asked for: false.
 */
export function requestSite(
  host: string,
  p: SitePermissions = permissions(),
  session: SiteArea | undefined = sessionArea(),
  now: number = Date.now(),
): Promise<boolean> {
  const pattern = sitePattern(host);
  if (pattern === null) return Promise.resolve(false);
  let asked: Promise<boolean>;
  try {
    asked = p.request({ permissions: ["scripting"], origins: [pattern] });
  } catch {
    return Promise.resolve(false);
  }
  void session?.set({ [PENDING_KEY]: { v: 1, host, at: now } }).catch(() => undefined);
  return asked;
}

/** The pending ask as read back, or null (its exact shape only). */
function readPending(raw: unknown): { host: string; at: number } | null {
  const r = raw as { v?: unknown; host?: unknown; at?: unknown } | null | undefined;
  if (!r || typeof r !== "object" || Object.keys(r).sort().join() !== "at,host,v" || r.v !== 1) return null;
  return siteHostOk(r.host) && Number.isSafeInteger(r.at) ? { host: r.host, at: r.at as number } : null;
}

/** The ask is over (the page that made it saw the answer): the note goes, if it is still this site's. */
async function dropPending(session: SiteArea, host: string): Promise<void> {
  const r = readPending((await session.get([PENDING_KEY]))[PENDING_KEY]);
  if (r?.host === host) await session.remove([PENDING_KEY]);
}

/**
 * The page's own end of an ask it made (requestSite): granted, the site goes on the list; refused, it is not offered
 * again until the browser restarts. True if the site is on the list now.
 */
export async function answered(
  host: string,
  granted: boolean,
  local: SiteArea = localArea(),
  session: SiteArea | undefined = sessionArea(),
): Promise<boolean> {
  const on = granted ? await addSite(host, local) : false;
  if (session) {
    if (!granted) await edit(session, LATER_KEY, adding(host));
    await dropPending(session, host).catch(() => undefined);
  }
  return on;
}

/** "Not now" for a site's offer: not offered again until the browser restarts. */
export async function notNow(host: string, session: SiteArea | undefined = sessionArea()): Promise<void> {
  if (session) await edit(session, LATER_KEY, adding(host));
}

/**
 * The worker's end of an ask (chrome.permissions.onAdded, review M7): the site goes on the list only if Sixkey's own ask
 * is under PENDING_MS old and Chrome added exactly its pattern. Nothing else is ever added here: a site granted in Chrome's
 * own menus, "On all sites" (the broad https pattern), an ask older than a minute. True if a site was
 * added.
 */
export async function acceptPending(
  added: { origins?: string[] },
  local: SiteArea = localArea(),
  session: SiteArea | undefined = sessionArea(),
  now: number = Date.now(),
): Promise<boolean> {
  if (!session) return false;
  const r = readPending((await session.get([PENDING_KEY]))[PENDING_KEY]);
  if (!r) return false;
  const age = now - r.at;
  if (age < 0 || age > PENDING_MS) {
    await session.remove([PENDING_KEY]); // an ask no answer can finish any more
    return false;
  }
  if (!(added.origins ?? []).includes(sitePattern(r.host)!)) return false;
  await session.remove([PENDING_KEY]);
  return addSite(r.host, local);
}

/**
 * Remove a site (Settings): off the list first, which is what turns it off; then Chrome's grant given back, only if Chrome
 * lists exactly that site's pattern. A broad grant chosen in Chrome's own menus stays as the user set it: what removing a
 * narrower pattern does under it is not verified (AUTOFILL2-PLAN §3.4 item 3), and the list alone already turns the site
 * off. A grant Chrome refuses to remove (a required one, in the e2e build) stays too; the site is off either way.
 */
export async function removeSite(
  host: string,
  local: SiteArea = localArea(),
  p: SitePermissions = permissions(),
): Promise<void> {
  await edit(local, SITES_KEY, (hosts) => (hosts.includes(host) ? hosts.filter((h) => h !== host) : null));
  const pattern = sitePattern(host);
  if (pattern !== null && (await grantedExactly(pattern, p))) await p.remove({ origins: [pattern] }).catch(() => false);
}
