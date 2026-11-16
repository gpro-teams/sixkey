// Who a plugin is, and what it may do now (from the removed plugin SDK's specification): the trust level,
// computed at run time from the bundled catalog and, with Chrome's optional `management`, the install type (§8.1–§8.2),
// never read from storage; the ceiling of each level; the slots each level may use; and a plugin's state as every
// context sees it, from its grant entry, the overlay and the pauses (grants.ts), the catalog's pins, and `management`.
// Pure. Since the plugin platform was removed (2026-11-12) every build's catalog is the built-in autofill's entry alone
// (src/platform/plugins/chrome.ts), and no install type is ever known (no build holds `management`): what autofill's gate
// asks of this module (trustOf, ceilingOf, heldNow) is the official level's answer for it.
import {
  CAPABILITY_NAMES,
  CHROME_VERSION,
  EXTENSION_ID,
  isObject,
  localeIn,
  RETIRED_CAPABILITIES,
  sameVersion,
  type CapabilityName,
  type Descriptor,
  type SlotName,
} from "./descriptor";
import { displayText, isPlainText, usesProtectedTerm } from "./text";
import { pausedNow, type GrantEntry, type GrantReason, type Pause } from "./grants";

export type Trust = "official" | "listed" | "unlisted" | "blocked";
export type CatalogEntry = {
  id: string;
  trust: "official" | "listed" | "blocked";
  name: string;
  publisher: string;
  store?: string;
  ceiling?: CapabilityName[];
  contributionsHash?: string;
  minVersion?: string;
  reason?: string;
};
export type Catalog = { v: 1; plugins: CatalogEntry[] };

/** What `management.get(id)` said (only with the optional permission; §8.2), or null without it. */
export type Install = { installType: string; version: string; name: string; enabled: boolean } | null;

const STORE_URL = /^https:\/\/chromewebstore\.google\.com\/detail\/[^\s]+$/;
const HASH = /^[0-9a-f]{64}$/;
const CAP_NAMES = new Set<string>(CAPABILITY_NAMES);

/** The catalog file, checked against `#/$defs/catalog`; throws a TypeError naming what is wrong (the build stops). */
export function parseCatalog(x: unknown): Catalog {
  const bad = (m: string): never => {
    throw new TypeError(`plugin catalog: ${m}`);
  };
  if (
    !isObject(x) ||
    x.v !== 1 ||
    !Array.isArray(x.plugins) ||
    Object.keys(x).some((k) => k !== "v" && k !== "plugins")
  )
    return bad("not { v: 1, plugins: [...] }");
  if (x.plugins.length > 1000) bad("more than 1,000 plugins");
  const seen = new Set<string>();
  const plugins = x.plugins.map((p, i): CatalogEntry => {
    const at = `plugins[${i}]`;
    if (!isObject(p)) return bad(`${at} is not an object`);
    const allowed = [
      "id",
      "trust",
      "name",
      "publisher",
      "store",
      "ceiling",
      "contributionsHash",
      "minVersion",
      "reason",
    ];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) bad(`${at} has an unknown field ${k}`);
    if (typeof p.id !== "string" || !EXTENSION_ID.test(p.id)) bad(`${at}.id is not an extension ID`);
    if (seen.has(p.id as string)) bad(`${at}.id is listed twice`);
    seen.add(p.id as string);
    if (p.trust !== "official" && p.trust !== "listed" && p.trust !== "blocked") bad(`${at}.trust`);
    if (!isPlainText(p.name, 1, 40)) bad(`${at}.name`);
    if (!isPlainText(p.publisher, 1, 60)) bad(`${at}.publisher`);
    if (p.store !== undefined && (typeof p.store !== "string" || p.store.length > 200 || !STORE_URL.test(p.store)))
      bad(`${at}.store`);
    if (
      p.ceiling !== undefined &&
      (!Array.isArray(p.ceiling) ||
        new Set(p.ceiling).size !== p.ceiling.length ||
        !p.ceiling.every((c) => typeof c === "string" && CAP_NAMES.has(c)))
    )
      bad(`${at}.ceiling`);
    if (
      p.contributionsHash !== undefined &&
      (typeof p.contributionsHash !== "string" || !HASH.test(p.contributionsHash))
    )
      bad(`${at}.contributionsHash`);
    if (p.minVersion !== undefined && (typeof p.minVersion !== "string" || !CHROME_VERSION.test(p.minVersion)))
      bad(`${at}.minVersion`);
    if (p.reason !== undefined && !isPlainText(p.reason, 0, 200)) bad(`${at}.reason`);
    if (p.trust === "blocked" && p.reason === undefined) bad(`${at}: a blocked entry needs a reason`);
    if (p.trust === "listed" && (p.store === undefined || p.ceiling === undefined || p.contributionsHash === undefined))
      bad(`${at}: a listed entry needs store, ceiling and contributionsHash`);
    if (p.trust === "official" && p.ceiling === undefined) bad(`${at}: an official entry needs a ceiling`);
    return p as CatalogEntry;
  });
  return { v: 1, plugins };
}

export const catalogEntry = (c: Catalog, id: string): CatalogEntry | undefined => c.plugins.find((p) => p.id === id);

/**
 * The trust level (§8.1–§8.2), and whether this is a developer copy: an official or listed ID that `management` reports
 * as loaded unpacked or sideloaded counts as unlisted, so a copy with the same `key` gets none of their rights (PRB M0-8).
 * Without `management` (install null) Sixkey cannot tell.
 */
export function trustOf(
  c: Catalog,
  id: string,
  install: Install,
): { trust: Trust; devCopy: boolean; entry?: CatalogEntry } {
  const entry = catalogEntry(c, id);
  if (!entry) return { trust: "unlisted", devCopy: false };
  if (entry.trust === "blocked") return { trust: "blocked", devCopy: false, entry };
  if (install && (install.installType === "development" || install.installType === "sideload"))
    return { trust: "unlisted", devCopy: true, entry };
  return { trust: entry.trust, devCopy: false, entry };
}

/**
 * What each level may hold in this version (§6.2's O, L and U columns, the balanced preset of OWNER-DECISIONS/16): an
 * unlisted plugin P0 only (P1 would need a developer mode, which no build has: wave 2a keeps plugins added by their ID at
 * P0); an official or listed one its catalog ceiling (a listed one never `sites.propose`, `codes.*` or `ui.badge` in
 * version 1). What is offered at all is descriptor.ts's OFFERED_CAPABILITIES: nothing else can be asked for.
 */
export function ceilingOf(trust: Trust, entry?: CatalogEntry): ReadonlySet<CapabilityName> {
  const p0 = [...P0] as CapabilityName[];
  if (trust === "blocked") return new Set();
  if (trust === "unlisted") return new Set(p0);
  const ceiling = entry?.ceiling ?? [];
  if (trust === "official") return new Set(ceiling);
  const notListed = new Set<CapabilityName>(["sites.propose", "codes.read", "codes.forPage", "ui.badge"]);
  return new Set(ceiling.filter((c) => !notListed.has(c)));
}

/**
 * The capabilities an approval grants (all or nothing, §9.3): those asked for, offered here, within the level's ceiling.
 * The approval screen that asked it went with the plugin platform.
 */
export function grantsOf(
  d: Pick<Descriptor, "id" | "capabilities">,
  catalog: Catalog,
  install: Install,
): CapabilityName[] {
  const { trust, entry } = trustOf(catalog, d.id, install);
  const ceiling = ceilingOf(trust, entry);
  return d.capabilities.map((c) => c.name).filter((n) => ceiling.has(n));
}

/** The slots each level may contribute to (§7.1's "Who"), of those this version offers. */
export function slotAllowed(slot: SlotName, trust: Trust): boolean {
  if (trust === "blocked") return false;
  if (slot === "popup.menu" || slot === "settings.page") return true;
  // add.sources, and the account menu (which needs P1 too: ACCOUNT_SLOTS below; no developer mode for unlisted ones)
  if (slot === "add.sources" || slot === "account.actions") return trust === "official" || trust === "listed";
  return false; // account.primary is the built-in autofill's; the toolbar menu needs `contextMenus`: neither offered
}

/**
 * The slots that carry an account (§7.1, V-4): drawn only for a plugin that holds `accounts.read` now, verified, and only
 * on an account's own menu, so a click hands over that account (its handle, and with `with: ["account"]` its summary).
 */
export const ACCOUNT_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>(["account.actions", "account.primary"]);

/** Chrome version strings compared part by part (`#/$defs/chromeVersion`). */
export function versionBelow(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** A plugin's state, as `hello` answered it and the removed plugin list showed it. */
export type PluginState =
  | { state: "unknown" }
  | { state: "blocked"; reason: string }
  | { state: "approved"; entry: GrantEntry }
  | { state: "disabled"; entry: GrantEntry }
  | {
      state: "suspended";
      entry: GrantEntry;
      why: GrantReason | "paused" | "update";
    };

/**
 * The state of `entry` (the grant store's, with the overlay applied) right now:
 *   - blocked by the catalog, whatever is stored;
 *   - suspended or disabled as stored;
 *   - suspended at run time, unstored: paused after denials (sk_plugin_pauses); a listed plugin whose stored
 *     contributions no longer give the catalog's contributionsHash (`storedHash`: the caller works it out; a release that
 *     changed the pin suspends it until that release's review is approved again, §4.2 item 3); a version below the
 *     catalog's minVersion ("update", §9.6), held against the version the plugin has now (`management`'s, else its latest
 *     hello's, `o.version`, else the approved one: W1a review F5); with `management`, a plugin that is not official and
 *     holds more than P0 whose installed version is not the approved one (§8.2, §9.5; a P0-only plugin's new version
 *     pauses nothing, and the removed plugin list said it, OD-2).
 */
export function stateOf(
  c: Catalog,
  id: string,
  entry: GrantEntry | undefined,
  o: { install: Install; pauses: readonly Pause[]; storedHash?: string; version?: string },
): PluginState {
  const { trust, entry: cat } = trustOf(c, id, o.install);
  if (trust === "blocked") return { state: "blocked", reason: cat?.reason ?? "" };
  if (!entry) return { state: "unknown" };
  if (entry.state === "disabled") return { state: "disabled", entry };
  if (entry.state === "suspended") return { state: "suspended", entry, why: entry.reason ?? "changed" };
  if (pausedNow(entry, o.pauses)) return { state: "suspended", entry, why: "paused" };
  if (trust === "listed" && cat?.contributionsHash !== undefined && o.storedHash !== cat.contributionsHash)
    return { state: "suspended", entry, why: "changed-since-review" };
  const version = o.install?.version ?? o.version ?? entry.descriptor.version;
  if (cat?.minVersion !== undefined && versionBelow(version, cat.minVersion))
    return { state: "suspended", entry, why: "update" };
  // the same version however it is written ("1.0" is "1.0.0"): only a real change suspends (N5)
  if (o.install && trust !== "official" && !p0Only(entry) && !sameVersion(o.install.version, entry.descriptor.version))
    return { state: "suspended", entry, why: "version-changed" };
  return { state: "approved", entry };
}

/** P0's capabilities (§6.1): what every plugin may hold, and all an unlisted one may. */
const P0: ReadonlySet<string> = new Set(["ui.slots", "env.read"]);

/** Whether `entry` was granted nothing beyond P0: then a new version alone is not a change to approve (OD-2). */
export const p0Only = (entry: Pick<GrantEntry, "granted">): boolean => entry.granted.every((g) => P0.has(g));

const RETIRED: ReadonlySet<string> = new Set(RETIRED_CAPABILITIES);

/**
 * The capabilities `entry` holds now: granted, within its level's ceiling, and not retired. What this version offers is
 * settled when a descriptor is read (readDescriptor drops the rest, so no approval grants it); a capability an earlier
 * version granted and this one retired (RETIRED_CAPABILITIES) can still be in a stored approval, and is dropped here.
 * Not filtered by OFFERED_CAPABILITIES: the built-in autofill holds codes.forPage, which no descriptor is offered.
 */
export function heldNow(entry: GrantEntry, trust: Trust, cat?: CatalogEntry): CapabilityName[] {
  const ceiling = ceilingOf(trust, cat);
  return entry.granted.filter((g) => ceiling.has(g) && !RETIRED.has(g));
}

/**
 * The name Sixkey shows (§4.1, §7.3 item 2, §8.3): the catalog's for an official or listed plugin; else Chrome's (with
 * `management`: the plugin's own manifest's), else the descriptor's, which the caller marks as given by the plugin. A
 * third-party name of either kind that uses a protected term, or has no text, is not shown: the plugin's ID is (W1a
 * review F2).
 */
export function shownName(
  c: Catalog,
  d: Pick<Descriptor, "id" | "name" | "locales">,
  lang: string,
  install: Install,
): { name: string; given: boolean } {
  const { trust, entry } = trustOf(c, d.id, install);
  if (entry && (trust === "official" || trust === "listed")) return { name: entry.name, given: false };
  const l = localeIn(d, lang);
  const own = install ? install.name : typeof l?.name === "string" ? l.name : d.name;
  // the string checked is the string drawn (r2 N1)
  const shown = displayText(own, 40);
  if (!shown || usesProtectedTerm(shown)) return { name: d.id, given: false };
  return { name: shown, given: !install };
}
