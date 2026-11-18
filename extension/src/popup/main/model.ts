// The popup list as data: which entries match the search, how each belongs to the current site, and how they are
// grouped into sections. Pure functions, no UI; the translated labels come in as arguments.
import { canRegister, matchTier, type Tier } from "../../core/match";
import type { Entry } from "../../core/vault/model";
import { LIMITS } from "../../core/vault/validate";

/**
 * `tier`: how the entry belongs to the page the popup was opened on (core/match.ts), or null. `note`: for a "same sign-in"
 * account (TOTP autofill Stage 3, AF3-4: ./aliases.ts), the line that says so; it is then `related`.
 */
export type Row = { entry: Entry; tier: Tier | null; note?: string | false };
export type Section = { key: string; label: string; rows: Row[] };
/** "manual": the vault's own order (drag to change). "name": by name, compared with `compare` (the current language's collation). */
export type Order = { sort: "manual" } | { sort: "name"; compare: (a: string, b: string) => number };

/**
 * How a "same sign-in" line is keyed (TOTP autofill Stage 3, AF3-4: ./aliases.ts makes the lines, filterRows reads them):
 * the account's id, a space (which no id holds), and its sites as they are. A line made while the account had other sites
 * is not read once they change (the review's N3: an account whose site was taken off keeps no line naming it); and no two
 * accounts share a key, whatever their ids (the space: without it, ids `ab` and `abx` with sites `x.com` and `.com` would).
 */
export const aliasKey = (e: Pick<Entry, "id" | "domains">) => e.id + " " + e.domains;

/** The search as matched: trimmed and lower-cased. Empty means no search. */
export const normalizeQuery = (query: string) => query.trim().toLowerCase();

/** Registered matches first, then name guesses, then everything else; each part keeps its order. */
const byTier = (rows: Row[]) => [
  ...rows.filter((r) => r.tier === "registered"),
  ...rows.filter((r) => r.tier === "related"),
  ...rows.filter((r) => !r.tier),
];

/** What the search looks in: the name, the account, the group and the registered sites. */
const searchText = (e: Entry) =>
  `${e.issuer} ${e.label} ${e.group ?? ""} ${(e.domains ?? []).join(" ")} ${e.note ?? ""}`.toLowerCase();

/** An account's name as sameNames compares it: issuer and account, case and outer spaces aside. */
export const nameKey = (e: Pick<Entry, "issuer" | "label">): string =>
  `${e.issuer.trim().toLowerCase()}\n${e.label.trim().toLowerCase()}`;

/**
 * A section's rows with the accounts of one name side by side, at the first of them (the owner's report of 2026-11-18:
 * same-name accounts together, framed; List draws the frame). Only the display moves: the vault's order is untouched.
 */
export function sameTogether(rows: Row[]): Row[] {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = nameKey(r.entry);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  const out: Row[] = [];
  const done = new Set<string>();
  for (const r of rows) {
    const k = nameKey(r.entry);
    if (done.has(k)) continue;
    done.add(k);
    out.push(...by.get(k)!);
  }
  return out;
}

/**
 * The accounts whose name (issuer and account, case aside) another account has too, each with its number among them in
 * the list's order (1, 2, …): the owner's report of 2026-11-18, two "NbdPay OTC / admin" with different keys looked the
 * same. The list marks them; a note (Entry.note) tells them apart in the person's own words.
 */
export function sameNames(entries: readonly Entry[]): Map<string, number> {
  const by = new Map<string, string[]>();
  for (const e of entries) {
    const k = nameKey(e);
    by.set(k, [...(by.get(k) ?? []), e.id]);
  }
  const out = new Map<string, number>();
  for (const ids of by.values()) if (ids.length > 1) ids.forEach((id, i) => out.set(id, i + 1));
  return out;
}

/**
 * Entries matching the search `q` (already normalized), each with how it belongs to `host`. While searching, site matches
 * come first. `alias`: the "same sign-in" notes for `host` (AF3-4, ./aliases.ts), by `aliasKey`: an account with one
 * that does not belong to `host` otherwise is `related`, with its note; one that does keeps its own tier and no note.
 */
export function filterRows(entries: Entry[], q: string, host: string | null, alias?: Map<string, string>): Row[] {
  const list = q ? entries.filter((e) => searchText(e).includes(q)) : entries;
  const mapped = list.map((entry): Row => {
    const tier = matchTier(entry, host);
    const note = !tier && alias?.get(aliasKey(entry));
    return { entry, tier: note ? "related" : tier, note };
  });
  return q ? byTier(mapped) : mapped;
}

/**
 * Whether an account is the one the page's user name box names (platform/page-user.ts): its label equals it, or the
 * part of either before an "@" equals the other, case aside. An empty user name names none.
 */
export function namesUser(e: Pick<Entry, "label">, user: string | null): boolean {
  const u = (user ?? "").trim().toLowerCase();
  const l = e.label.trim().toLowerCase();
  if (!u || !l) return false;
  const local = (s: string) => (s.includes("@") ? s.slice(0, s.indexOf("@")) : s);
  return l === u || local(l) === u || local(u) === l;
}

/**
 * The site's rows, those used more often in this browser first (`uses`: id → times, ./uses.ts), the others in their order
 * (the owner's question of 2026-11-18). Only the site's sections are sorted so: the groups keep the list's order.
 */
export function byUse(rows: Row[], uses: Readonly<Record<string, number>>): Row[] {
  const n = (r: Row) => {
    const v = uses[r.entry.id];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return rows
    .map((r, i) => ({ r, i, n: n(r) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.r);
}

/** The site's rows (registered, related) with the account the page's user name names first; nothing else moves. */
export function userFirst(rows: Row[], user: string | null): Row[] {
  if (!user) return rows;
  const hit = rows.filter((r) => r.tier && namesUser(r.entry, user));
  return hit.length ? [...hit, ...rows.filter((r) => !hit.includes(r))] : rows;
}

/** Rows by name: the name shown in bold (issuer, else label), then the label, then the id so the order is total. */
export function sortByName(rows: Row[], compare: (a: string, b: string) => number): Row[] {
  const name = (e: Entry) => e.issuer || e.label;
  return [...rows].sort(
    (a, b) =>
      compare(name(a.entry), name(b.entry)) ||
      compare(a.entry.label, b.entry.label) ||
      (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
}

/**
 * Sections, in display order. While searching: one "results" section. Otherwise: the accounts registered for the
 * current site first (key "site", labelled with the host: the only ones shown as "This site"), then the name guesses
 * (key "related", labelled `labels.related`), then one section per group in order of first appearance; the ungrouped
 * section is labelled only when there is something else to tell it apart from.
 * Sorting by name orders the rows inside every section, and the groups by name with the ungrouped accounts last. The
 * site sections stay first whatever the order, and so do site matches (registered, then related) among search results.
 */
export function buildSections(
  rows: Row[],
  q: string,
  host: string | null,
  labels: { results: string; ungrouped: string; related?: string },
  order: Order = { sort: "manual" },
): Section[] {
  const sorted = order.sort === "name" ? sortByName(rows, order.compare) : rows;
  if (q) return [{ key: "results", label: labels.results, rows: byTier(sorted) }];
  const site = sorted.filter((r) => r.tier === "registered");
  const related = sorted.filter((r) => r.tier === "related");
  const rest = sorted.filter((r) => !r.tier);
  const out: Section[] = [];
  if (site.length) out.push({ key: "site", label: host ?? "", rows: site });
  if (related.length) out.push({ key: "related", label: labels.related ?? "", rows: related });
  let groups = [...new Set(rest.map((r) => r.entry.group ?? ""))];
  if (order.sort === "name")
    groups = [...groups.filter((g) => g !== "").sort(order.compare), ...groups.filter((g) => g === "")];
  const labelled = groups.some((g) => g !== "") || out.length > 0;
  for (const g of groups)
    out.push({
      key: `g:${g}`,
      label: g || (labelled ? labels.ungrouped : ""),
      rows: rest.filter((r) => (r.entry.group ?? "") === g),
    });
  return out;
}

/**
 * The page to ask "which account is it?" about, above the list (docs/design/notes/AFMATCH-NOTES.md): `host` when it
 * could be registered (canRegister) and no account is registered for it, while not searching and with accounts to
 * choose from; null otherwise. `sections` is what buildSections made for the search `q` on `host`.
 */
export const askHost = (sections: Section[], q: string, host: string | null): string | null =>
  !q && canRegister(host) && sections.length > 0 && sections[0]?.key !== "site" ? host : null;

/**
 * An account's sites with `d` added at the end, unless it is already there: what the editor and "Remember this site"
 * write. `d` comes from match.ts (parseSite or hostOf), so it is canonical and at most LIMITS.domain long; the count is
 * checked here, before writing: "too_many" when the account already has as many sites as a vault may hold.
 */
export function appendDomain(list: readonly string[] | undefined, d: string): string[] | "too_many" {
  const cur = [...(list ?? [])];
  if (cur.includes(d)) return cur;
  return cur.length >= LIMITS.domains ? "too_many" : [...cur, d];
}

/** The first word of an issuer ("DynastyX-Admin": "DynastyX"; "Amazon Web Services": "Amazon"; "乐支付": itself). */
const firstWord = (issuer: string): string => issuer.trim().split(/[\s\-_.:|/()·,，]+/)[0] ?? "";

/**
 * Grouping by name in one click (the owner's report of 2026-11-18: 57 accounts, many of one service): the accounts in no
 * group whose issuer starts with the same word as another such account's (case aside), each with the group it goes in: a
 * group already named so (any case), else their issuer when they all share it, else that word; cut to the longest group
 * name. Accounts already in a group are never moved, and a service with one account makes no group.
 */
export function autoGroups(entries: readonly Entry[]): Map<string, string> {
  const free = new Map<string, Entry[]>();
  const named = new Map<string, string>(); // the groups there are, by their name in lower case
  for (const e of entries) {
    if (e.group) named.set(e.group.toLowerCase(), e.group);
    else {
      const w = firstWord(e.issuer).toLowerCase();
      if (w) free.set(w, [...(free.get(w) ?? []), e]);
    }
  }
  const out = new Map<string, string>();
  for (const [w, list] of free) {
    const issuer = list[0]!.issuer.trim();
    const same = list.every((e) => e.issuer.trim().toLowerCase() === issuer.toLowerCase());
    const there = named.get(w) ?? (same ? named.get(issuer.toLowerCase()) : undefined);
    if (!there && list.length < 2) continue;
    const name = (there ?? (same ? issuer : firstWord(issuer))).slice(0, LIMITS.group);
    for (const e of list) out.set(e.id, name);
  }
  return out;
}
