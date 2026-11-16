// The plugin descriptor (from the removed plugin SDK's specification): read tolerantly, negotiated, compared
// (§4.2 item 2) and pinned (§4.2 item 3). What this Sixkey cannot use is dropped item by item and listed in `unavailable`;
// the descriptor fails, `invalid`, only on its top level. The result is the normalised descriptor: only the version-1
// fields, only the items that survived, so that a tolerated unknown field never changes a comparison. No text, no
// browser calls.
import { isPlainText, PNG_URL, wellFormed } from "./text";
import { jcs, sha256Hex } from "./jcs";

export const SDK_MIN = 1;
export const SDK_MAX = 1;

/** Every capability name of version 1 (`#/$defs/capabilityName`), in the registry's order (§6.2). */
export const CAPABILITY_NAMES = [
  "ui.slots",
  "env.read",
  "ui.badge",
  "accounts.read",
  "accounts.add",
  "accounts.update",
  "accounts.trash",
  "sites.propose",
  "codes.read",
  "codes.forPage",
  "backups.transport",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** Every slot of version 1 (`#/$defs/slotName`). */
export const SLOT_NAMES = [
  "popup.menu",
  "add.sources",
  "settings.page",
  "account.actions",
  "account.primary",
  "action.menu",
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * What this Sixkey offers (wave 1a: P0; wave 2a: P1, `accounts.read`, and its slot `account.actions`; wave 2b: P2's
 * `accounts.add`, `accounts.update` and `accounts.trash`: OWNER-DECISIONS/16, PLUGINS-W1A-NOTES.md §2,
 * PLUGINS-W2A-NOTES.md §3, PLUGINS-W2B-NOTES.md §3). A capability or slot of version 1 that is not offered here is "this
 * Sixkey does not offer" (§4.1, §4.3): dropped and listed in `unavailable`, as an unknown one is. account.primary is the
 * official plugins' alone (autofill's Fill code, built in: no descriptor); action.menu needs `contextMenus`, which this
 * build does not hold (§7.1, "OPTIONAL"); sites.propose (official only, and no official plugin asks for it) and P3 come
 * later. backups.transport, the official cloud plugin's, went with that plugin's backup to Drive: a descriptor that
 * asks for it has it dropped and listed in `unavailable`, so no new approval grants it; one an earlier version stored
 * still reads, and holds nothing of it (RETIRED_CAPABILITIES below).
 */
export const OFFERED_CAPABILITIES: readonly CapabilityName[] = [
  "ui.slots",
  "env.read",
  "accounts.read",
  "accounts.add",
  "accounts.update",
  "accounts.trash",
];
export const OFFERED_SLOTS: readonly SlotName[] = ["popup.menu", "add.sources", "settings.page", "account.actions"];
/**
 * Capabilities an earlier version offered and this one does not. An approval stored then (a grant entry's descriptor
 * and its `granted` list) can still name one: the grant record still reads (isStoredDescriptor's `retired`), so the
 * other plugins' approvals keep working, and the capability is held by no plugin (policy.ts heldNow) and offered to
 * none, so nothing grants it again. Any other name a stored descriptor holds that this version does not offer still
 * fails it, and with it the record.
 */
export const RETIRED_CAPABILITIES: readonly CapabilityName[] = ["backups.transport"];
/** What a contribution's `with` asks for in a click (§7.2, §7.4): the capability it needs, which must be offered. */
const WITH_NEEDS: Record<"account" | "code", CapabilityName> = { account: "accounts.read", code: "codes.read" };

/** The slots that carry no account (§7.1): no `with`, no `when.accountTypes` or `when.thisSite` (the schema's if/then). */
const NON_ACCOUNT_SLOTS = new Set<string>(["popup.menu", "add.sources", "settings.page", "action.menu"]);

export const BUILTIN_ICONS = [
  "key",
  "lock",
  "star",
  "bolt",
  "camera",
  "image",
  "download",
  "upload",
  "clipboard",
  "link",
  "shield",
  "wand",
  "grid",
  "list",
  "globe",
  "clock",
  "dice",
  "file",
] as const;
export type BuiltinIcon = (typeof BUILTIN_ICONS)[number];

export type Icon = { builtin: BuiltinIcon } | { png: string };
export type Contribution = {
  id: string;
  slot: SlotName;
  title: string;
  icon: Icon;
  with?: ("account" | "code")[];
  when?: { vault?: "unlocked" | "any"; accountTypes?: ("totp" | "hotp")[]; thisSite?: boolean };
};
export type LocaleStrings = {
  name?: string;
  description?: string;
  reasons?: Record<string, string>;
  titles?: Record<string, string>;
};
export type CapabilityRequest = { name: CapabilityName; reason: string };
/** A descriptor as stored (§4.2 item 1): the version-1 fields that survived §4.3, nothing else. */
export type Descriptor = {
  id: string;
  name: string;
  description?: string;
  version: string;
  publisher: { name: string; url?: string };
  worker?: string;
  sdkVersion: number;
  sdkMin?: number;
  capabilities: CapabilityRequest[];
  contributions: Contribution[];
  defaultLocale: string;
  locales?: Record<string, LocaleStrings>;
};

export const EXTENSION_ID = /^[a-p]{32}$/;
export const CHROME_VERSION = /^[0-9]{1,5}(\.[0-9]{1,5}){0,3}$/;
const LOCALE_TAG = /^[a-z]{2,3}(_([A-Z]{2}|[0-9]{3}))?$/;
const CONTRIBUTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const NAME_REF = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;
const WORKER = /^\/[A-Za-z0-9_/-]+(\.[A-Za-z0-9_-]+)*\.js$/;
const PUBLISHER_URL = /^https:\/\/[^\s]+$/;

export const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown, min: number): x is number => Number.isSafeInteger(x) && (x as number) >= min;
const str = (x: unknown, re: RegExp, max = Infinity): x is string =>
  typeof x === "string" && x.length <= max && re.test(x);
const uniqueOf = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;

/** What a version-1 Sixkey reads of a descriptor, or why it cannot: §5.3's negotiation comes first. */
export type Read =
  | { ok: true; descriptor: Descriptor; unavailable: string[]; sdk: number }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "version"; supported: { min: number; max: number } };

/**
 * The negotiated version (§5.3): `v = min(sMax, pMax)` provided `v ≥ max(sMin, pMin)`, where the plugin speaks
 * `[sdkMin ?? sdkVersion, sdkVersion]`. Read before anything else of the descriptor. null: no common version.
 * "invalid" when the two fields are not integers ≥ 1 (or sdkMin is above sdkVersion).
 */
export function negotiate(d: unknown): number | null | "invalid" {
  if (!isObject(d) || !isInt(d.sdkVersion, 1)) return "invalid";
  const pMax = d.sdkVersion;
  if (d.sdkMin !== undefined && !isInt(d.sdkMin, 1)) return "invalid";
  const pMin = (d.sdkMin as number | undefined) ?? pMax;
  if (pMin > pMax) return "invalid";
  const v = Math.min(SDK_MAX, pMax);
  return v >= Math.max(SDK_MIN, pMin) ? v : null;
}

/** `#/$defs/icon`: one of its two shapes, exactly (an unknown name or kind is not an icon this Sixkey can draw). */
function iconOf(x: unknown): Icon | null {
  if (!isObject(x)) return null;
  const keys = Object.keys(x);
  if (keys.length !== 1) return null;
  if (keys[0] === "builtin")
    return (BUILTIN_ICONS as readonly unknown[]).includes(x.builtin) ? { builtin: x.builtin as BuiltinIcon } : null;
  if (keys[0] === "png") return str(x.png, PNG_URL, 11_000) ? { png: x.png } : null;
  return null;
}

/**
 * `#/$defs/contribution` (its own fields only; unknown ones are left out), a slot this Sixkey offers, and a `with` it can
 * honour: one that names what this Sixkey does not offer (a code, while `codes.read` is not: wave 2a) is "a value this
 * Sixkey cannot use" (§4.3 item 3), so the entry is dropped rather than drawn with a promise it would not keep.
 */
function contributionOf(x: unknown, offered: ReadonlySet<string>, caps: readonly string[]): Contribution | null {
  if (!isObject(x)) return null;
  if (!str(x.id, CONTRIBUTION_ID) || !str(x.slot, NAME_REF, 64) || !isPlainText(x.title, 1, 32)) return null;
  const icon = iconOf(x.icon);
  if (!icon) return null;
  const c: Contribution = { id: x.id, slot: x.slot as SlotName, title: x.title, icon };
  if (x.with !== undefined) {
    const w = x.with;
    if (!Array.isArray(w) || w.length > 2 || !uniqueOf(w) || !w.every((v) => v === "account" || v === "code"))
      return null;
    c.with = w as Contribution["with"];
    if (c.with!.some((v) => !caps.includes(WITH_NEEDS[v]))) return null;
  }
  if (x.when !== undefined) {
    if (!isObject(x.when)) return null;
    const when: NonNullable<Contribution["when"]> = {};
    const { vault, accountTypes, thisSite } = x.when;
    if (vault !== undefined) {
      if (vault !== "unlocked" && vault !== "any") return null;
      when.vault = vault;
    }
    if (accountTypes !== undefined) {
      if (
        !Array.isArray(accountTypes) ||
        !accountTypes.length ||
        !uniqueOf(accountTypes) ||
        !accountTypes.every((t) => t === "totp" || t === "hotp")
      )
        return null;
      when.accountTypes = accountTypes as ("totp" | "hotp")[];
    }
    if (thisSite !== undefined) {
      if (typeof thisSite !== "boolean") return null;
      when.thisSite = thisSite;
    }
    c.when = when;
  }
  // the schema's if/then: a slot with no account takes no `with`, and no `when` about accounts
  if (NON_ACCOUNT_SLOTS.has(c.slot) && (c.with || c.when?.accountTypes || c.when?.thisSite !== undefined)) return null;
  // known to the schema but not offered here, or unknown: "an unknown slot" (§4.3 item 3)
  if (!offered.has(c.slot)) return null;
  return c;
}

/** `#/$defs/localeStrings`, its own fields only; null if any of them fails (the whole locale entry is dropped). */
function localeOf(x: unknown): LocaleStrings | null {
  if (!isObject(x)) return null;
  const out: LocaleStrings = {};
  if (x.name !== undefined) {
    if (!isPlainText(x.name, 1, 40)) return null;
    out.name = x.name;
  }
  if (x.description !== undefined) {
    if (!isPlainText(x.description, 0, 200)) return null;
    out.description = x.description;
  }
  for (const [field, keyRe, min, max] of [
    ["reasons", NAME_REF, 1, 120],
    ["titles", CONTRIBUTION_ID, 1, 32],
  ] as const) {
    const t = x[field];
    if (t === undefined) continue;
    if (!isObject(t)) return null;
    const table: Record<string, string> = {};
    for (const [k, v] of Object.entries(t)) {
      if (!keyRe.test(k) || (field === "reasons" && k.length > 64) || !isPlainText(v, min, max)) return null;
      table[k] = v;
    }
    out[field] = table;
  }
  return out;
}

/** An `unavailable` item (`#/$defs/helloResult`): its kind and the name as given, cut to 80 characters. */
const item = (kind: "capability" | "contribution" | "locale", name: unknown) =>
  `${kind}:${typeof name === "string" && name ? Array.from(name).slice(0, 80).join("") : "?"}`;

/**
 * Read a descriptor (§4.3, §5.3). `offered`: what this Sixkey offers (by default OFFERED_CAPABILITIES and
 * OFFERED_SLOTS). The top level is checked against `#/$defs/descriptor`; each capability request, contribution and
 * locale entry then on its own, and one that fails, is not offered, or repeats an earlier name or id is dropped and
 * listed in `unavailable` (at most 32 items, the schema's limit; the rest are dropped all the same).
 */
export function readDescriptor(
  raw: unknown,
  offered: { capabilities: readonly string[]; slots: readonly string[] } = {
    capabilities: OFFERED_CAPABILITIES,
    slots: OFFERED_SLOTS,
  },
): Read {
  const v = negotiate(raw);
  if (v === "invalid") return { ok: false, error: "invalid" };
  if (v === null) return { ok: false, error: "version", supported: { min: SDK_MIN, max: SDK_MAX } };
  // a lone surrogate anywhere (a URL's too, which plain text does not cover) cannot be stored or compared (§2.3, F-1)
  if (!wellFormed(raw)) return { ok: false, error: "invalid" };
  const d = raw as Record<string, unknown>;
  // the top level (§4.3 item 1)
  const publisher = d.publisher;
  if (
    !str(d.id, EXTENSION_ID) ||
    !isPlainText(d.name, 1, 40) ||
    (d.description !== undefined && !isPlainText(d.description, 0, 200)) ||
    !str(d.version, CHROME_VERSION) ||
    !isObject(publisher) ||
    !isPlainText(publisher.name, 1, 60) ||
    (publisher.url !== undefined && !str(publisher.url, PUBLISHER_URL, 200)) ||
    (d.worker !== undefined && !str(d.worker, WORKER, 100)) ||
    !Array.isArray(d.capabilities) ||
    d.capabilities.length > 16 ||
    !d.capabilities.every(isObject) ||
    !Array.isArray(d.contributions) ||
    d.contributions.length > 16 ||
    !d.contributions.every(isObject) ||
    !str(d.defaultLocale, LOCALE_TAG) ||
    (d.locales !== undefined &&
      (!isObject(d.locales) || Object.keys(d.locales).length > 32 || !Object.values(d.locales).every(isObject))) ||
    (d.capabilities.some((c) => (c as Record<string, unknown>).name === "codes.forPage") && d.worker === undefined)
  )
    return { ok: false, error: "invalid" };

  const unavailable: string[] = [];
  const caps: CapabilityRequest[] = [];
  const seenCaps = new Set<string>();
  for (const c of d.capabilities as Record<string, unknown>[]) {
    const ok =
      str(c.name, NAME_REF, 64) &&
      isPlainText(c.reason, 1, 120) &&
      offered.capabilities.includes(c.name) &&
      !seenCaps.has(c.name);
    if (typeof c.name === "string") seenCaps.add(c.name);
    if (ok) caps.push({ name: c.name as CapabilityName, reason: c.reason as string });
    else unavailable.push(item("capability", c.name));
  }
  const contributions: Contribution[] = [];
  const seenIds = new Set<string>();
  const slots = new Set(offered.slots);
  for (const raw of d.contributions as Record<string, unknown>[]) {
    const c = contributionOf(raw, slots, offered.capabilities);
    if (c && !seenIds.has(c.id)) contributions.push(c);
    else unavailable.push(item("contribution", raw.id));
    if (typeof raw.id === "string") seenIds.add(raw.id);
  }
  let locales: Record<string, LocaleStrings> | undefined;
  if (d.locales !== undefined) {
    locales = {};
    for (const [tag, entry] of Object.entries(d.locales as Record<string, unknown>)) {
      const l = LOCALE_TAG.test(tag) ? localeOf(entry) : null;
      if (l) locales[tag] = l;
      else unavailable.push(item("locale", tag));
    }
  }
  const descriptor: Descriptor = {
    id: d.id,
    name: d.name,
    ...(d.description !== undefined ? { description: d.description as string } : {}),
    version: d.version,
    publisher: {
      name: publisher.name,
      ...(publisher.url !== undefined ? { url: publisher.url as string } : {}),
    },
    ...(d.worker !== undefined ? { worker: d.worker as string } : {}),
    sdkVersion: d.sdkVersion as number,
    ...(d.sdkMin !== undefined ? { sdkMin: d.sdkMin as number } : {}),
    capabilities: caps,
    contributions,
    defaultLocale: d.defaultLocale,
    ...(locales ? { locales } : {}),
  };
  return { ok: true, descriptor, unavailable: [...new Set(unavailable)].slice(0, 32), sdk: v };
}

/**
 * A stored descriptor read back (from the grant store, or the session's record of a hello): the same rules, and it must
 * come out unchanged. A descriptor that does not is not one Sixkey wrote (or not this version's), so it is refused.
 * `retired` (the grant store's entries): a capability of RETIRED_CAPABILITIES counts as offered, so an approval an
 * earlier version stored still reads; it stays as stored (the record's tag covers it) and is held by no one.
 */
export function isStoredDescriptor(x: unknown, o: { retired?: boolean } = {}): x is Descriptor {
  const r = o.retired
    ? readDescriptor(x, { capabilities: [...OFFERED_CAPABILITIES, ...RETIRED_CAPABILITIES], slots: OFFERED_SLOTS })
    : readDescriptor(x);
  return r.ok && r.unavailable.length === 0 && jcs(r.descriptor) === safeJcs(x);
}
const safeJcs = (x: unknown): string | null => {
  try {
    return jcs(x);
  } catch {
    return null;
  }
};

/**
 * A Chrome version string in one spelling (`#/$defs/chromeVersion`): its parts as numbers, trailing zeros taken off, so
 * "1.0" and "1.0.0" (and "01.0") are one version, as Chrome compares them (W1a review N5, a W2 must-fix: written
 * differently, the descriptor's version and the manifest's kept a P1 plugin paused for a version change at every hello).
 */
export function normalVersion(v: string): string {
  const parts = v.split(".").map(Number);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join(".");
}
/** Whether two Chrome version strings name the same version (normalVersion). */
export const sameVersion = (a: string, b: string): boolean => normalVersion(a) === normalVersion(b);
/**
 * Chrome's version of a plugin when it is another version than the approved one (Settings' "updated to version X since
 * approved", OD-2), else null: the same version spelled otherwise is not a newer one (N5's fourth comparison, W2A-04).
 */
export const versionSince = (chrome: string | undefined, approved: string): string | null =>
  chrome && !sameVersion(chrome, approved) ? chrome : null;

/**
 * The fields of a descriptor that may change without asking (§4.2 item 2, the allow-list): `version`, `description`,
 * `locales.*.description` and `publisher.url`. `versionToo: false` keeps `version` out of it: with Chrome's `management`,
 * a third-party plugin's new version is a change to approve (§8.2, §9.5); compared as a version (normalVersion), never as
 * a spelling (N5).
 */
function withoutHarmless(d: Descriptor, versionToo = true): unknown {
  const { description: _d, version, publisher, locales, ...rest } = d;
  return {
    ...rest,
    ...(versionToo ? {} : { version: normalVersion(version) }),
    publisher: { name: publisher.name },
    ...(locales
      ? {
          locales: Object.fromEntries(Object.entries(locales).map(([tag, { description: _ld, ...l }]) => [tag, l])),
        }
      : {}),
  };
}

/** Whether `next` differs from `stored` only in the allow-list's fields (§4.2 item 2), compared as JCS. */
export const onlyHarmless = (stored: Descriptor, next: Descriptor, versionToo = true): boolean =>
  jcs(withoutHarmless(stored, versionToo)) === jcs(withoutHarmless(next, versionToo));

/**
 * `when` with only its version-1 fields. Named from one string, not as properties: one of them is also the name of a
 * message key, which the key collector would count as text the settings page shows (scripts/catalog-keys.mjs rule 2).
 */
const WHEN_FIELDS = "vault accountTypes thisSite".split(" ");
function whenFields(w: NonNullable<Contribution["when"]>): Contribution["when"] {
  const all = w as Record<string, unknown>;
  return Object.fromEntries(WHEN_FIELDS.filter((k) => all[k] !== undefined).map((k) => [k, all[k]]));
}

/**
 * `contributionsHash` (§4.2 item 3): lowercase hex of SHA-256 of JCS({"contributions": C, "titles": T}), C the
 * contributions that survived §4.3 reduced to the version-1 fields and sorted by id, T `locales.*.titles` restricted to
 * C's ids, with empty locales removed.
 */
export function contributionsHash(d: Descriptor): Promise<string> {
  const C = [...d.contributions]
    .map((c) => ({
      id: c.id,
      slot: c.slot,
      title: c.title,
      icon: c.icon,
      ...(c.with ? { with: c.with } : {}),
      ...(c.when ? { when: whenFields(c.when) } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set(C.map((c) => c.id));
  const T: Record<string, Record<string, string>> = {};
  for (const [tag, l] of Object.entries(d.locales ?? {})) {
    const titles = Object.fromEntries(Object.entries(l.titles ?? {}).filter(([id]) => ids.has(id)));
    if (Object.keys(titles).length) T[tag] = titles;
  }
  return sha256Hex(jcs({ contributions: C, titles: T }));
}

/**
 * `t[k]` only if it is `t`'s own string (W1a review F1): a contribution may be called "constructor", and a table may be
 * empty, so nothing an object inherits is ever read as a plugin's text.
 */
function own(t: Record<string, unknown> | undefined, k: string): string | undefined {
  const v = t !== undefined && Object.hasOwn(t, k) ? t[k] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** The descriptor's locale entry for `lang`, if it has one of its own. */
export function localeIn(d: Pick<Descriptor, "locales">, lang: string): LocaleStrings | undefined {
  return d.locales !== undefined && Object.hasOwn(d.locales, lang) ? d.locales[lang] : undefined;
}

/** The text of a descriptor in `lang` (its locale entry, else its own): the name, a reason, a contribution's title. */
export function localised(d: Descriptor, lang: string) {
  const l = localeIn(d, lang);
  return {
    name: own(l, "name") ?? d.name,
    reason: (cap: string) => own(l?.reasons, cap) ?? d.capabilities.find((c) => c.name === cap)?.reason ?? "",
    title: (c: Contribution) => own(l?.titles, c.id) ?? c.title,
  };
}
