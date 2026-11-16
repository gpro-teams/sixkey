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
const searchText = (e: Entry) => `${e.issuer} ${e.label} ${e.group ?? ""} ${(e.domains ?? []).join(" ")}`.toLowerCase();

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
