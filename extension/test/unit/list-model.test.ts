// PHASE0X-PLAN B2: the popup list's site sections. "This site" holds only accounts registered for the page; name
// guesses go under "Possibly related"; search also looks in the registered sites; what "Remember this site" writes.
import { describe, expect, it } from "vitest";
import { hostOf } from "../../src/core/match";
import { domainChoices, preferredChoice } from "../../src/core/site-domains";
import type { Entry } from "../../src/core/vault/model";
import { LIMITS } from "../../src/core/vault/validate";
import {
  appendDomain,
  askHost,
  autoGroups,
  buildSections,
  byUse,
  sameNames,
  sameTogether,
  filterRows,
  namesUser,
  normalizeQuery,
  userFirst,
  type Section,
} from "../../src/popup/main/model";

const LABELS = { results: "results", ungrouped: "accounts", related: "possibly related" };
let n = 0;
function entry(issuer: string, domains?: string[], group?: string): Entry {
  n++;
  return {
    id: `id${String(n).padStart(3, "0")}`,
    type: "totp",
    issuer,
    label: `user${n}`,
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    counter: 0,
    ...(group ? { group } : {}),
    ...(domains ? { domains } : {}),
  } as Entry;
}
const sections = (entries: Entry[], url: string, query = ""): Section[] => {
  const host = hostOf(url);
  const q = normalizeQuery(query);
  return buildSections(filterRows(entries, q, host), q, host, LABELS);
};
const view = (s: Section[]) => s.map((x) => [x.key, x.label, x.rows.map((r) => r.entry.issuer)]);

describe("site sections", () => {
  const google = entry("Google", ["google.com"]);
  const github = entry("GitHub", ["github.com"]);
  const paypal = entry("PayPal", ["paypal.com"]);
  const guessOnly = entry("GitHub"); // a second GitHub account, never registered
  const aliyun = entry("阿里云", ["aliyun.com"]);
  const other = entry("Zoom", undefined, "Work");
  const all = [google, github, paypal, guessOnly, aliyun, other];

  it('registered accounts under the host, as "site"; guesses under "related"; then the groups, labelled', () => {
    expect(view(sections(all, "https://github.com/login"))).toEqual([
      ["site", "github.com", ["GitHub"]],
      ["related", "possibly related", ["GitHub"]],
      ["g:", "accounts", ["Google", "PayPal", "阿里云"]],
      ["g:Work", "Work", ["Zoom"]],
    ]);
    const s = sections(all, "https://github.com/login");
    expect(s[0]!.rows[0]!.entry.id).toBe(github.id);
    expect(s[1]!.rows[0]!.entry.id).toBe(guessOnly.id);
    expect(s[1]!.rows[0]!.tier).toBe("related");
  });

  it('a Chinese name is "This site" on its registered domain', () => {
    expect(view(sections(all, "https://signin.aliyun.com/"))[0]).toEqual(["site", "signin.aliyun.com", ["阿里云"]]);
  });

  it('only guesses: no "site" section, and the ungrouped accounts are still labelled', () => {
    const s = sections([entry("Dropbox"), entry("Zoom")], "https://www.dropbox.com/");
    expect(view(s)).toEqual([
      ["related", "possibly related", ["Dropbox"]],
      ["g:", "accounts", ["Zoom"]],
    ]);
  });

  it('safety: on a look-alike host there is never a "site" section, and registered accounts are not even guessed', () => {
    for (const url of [
      "https://google.evil-login.ru/",
      "https://secure-google-verify.com/",
      "https://paypal-account-check.xyz/",
      "https://github.com.attacker.io/",
      "https://github.com@evil.io/",
      "https://аpple.com/",
      "https://accounts.google.com.evil.io/",
    ]) {
      const s = sections([...all, entry("Apple", ["apple.com"])], url);
      expect(
        s.some((x) => x.key === "site"),
        url,
      ).toBe(false);
      const related = s.find((x) => x.key === "related")?.rows.map((r) => r.entry.id) ?? [];
      for (const id of related) expect([guessOnly.id], url).toContain(id);
      expect(s.flatMap((x) => x.rows).length, url).toBe(all.length + 1); // nobody is hidden
    }
  });

  it("no page, or a page that is not a web page: no site sections", () => {
    for (const url of ["chrome://newtab", "chrome-extension://abc/popup/index.html", ""])
      expect(
        sections(all, url).some((x) => x.key === "site" || x.key === "related"),
        url,
      ).toBe(false);
  });

  it("search also finds registered sites; registered results first, then guesses, then the rest", () => {
    expect(view(sections(all, "chrome://newtab", "aliyun"))).toEqual([["results", "results", ["阿里云"]]]);
    expect(view(sections(all, "chrome://newtab", "PAYPAL.COM"))).toEqual([["results", "results", ["PayPal"]]]);
    expect(view(sections(all, "https://github.com/", "git"))).toEqual([["results", "results", ["GitHub", "GitHub"]]]);
    const s = sections(all, "https://github.com/", "git")[0]!;
    expect(s.rows.map((r) => r.tier)).toEqual(["registered", "related"]);
  });
});

describe("remembering a site", () => {
  it('adds the chosen domain as an ordinary edit of `domains`, and the account becomes "This site"', () => {
    const e = entry("GitHub");
    const host = hostOf("https://github.com/login")!;
    expect(sections([e], "https://github.com/login")[0]!.key).toBe("related");
    const next = appendDomain(e.domains, preferredChoice(domainChoices(host))!);
    expect(next).toEqual(["github.com"]);
    const remembered = { ...e, domains: next as string[] };
    expect(view(sections([remembered], "https://github.com/login"))).toEqual([["site", "github.com", ["GitHub"]]]);
    expect(view(sections([remembered], "https://gist.github.com/"))[0]![0]).toBe("site");
  });

  it("keeps what is there, adds no duplicates, and refuses a seventeenth site", () => {
    const list = ["a.example", "b.example"];
    expect(appendDomain(list, "c.example")).toEqual(["a.example", "b.example", "c.example"]);
    expect(list).toEqual(["a.example", "b.example"]); // not changed in place
    expect(appendDomain(list, "a.example")).toEqual(list);
    expect(appendDomain(undefined, "a.example")).toEqual(["a.example"]);
    const full = Array.from({ length: LIMITS.domains }, (_, i) => `s${i}.example`);
    expect(LIMITS.domains).toBe(16);
    expect(appendDomain(full, "one-more.example")).toBe("too_many");
    expect(appendDomain(full, "s3.example")).toEqual(full); // already there: nothing to add, nothing refused
  });
});

// AFMATCH (docs/design/notes/AFMATCH-NOTES.md): the line above the list that asks which account the page is, so an
// account with no sites (imported from Google Authenticator, say) can be remembered for it with one choice.
describe("which account is this page: when the list asks", () => {
  const ask = (entries: Entry[], url: string, query = "") => {
    const host = hostOf(url);
    const q = normalizeQuery(query);
    return askHost(buildSections(filterRows(entries, q, host), q, host, LABELS), q, host);
  };

  it("on a page no account is registered for, whether a name is guessed there or not", () => {
    expect(ask([entry("ws"), entry("Zoom")], "https://ws.g.pro/admin/")).toBe("ws.g.pro"); // "ws" is only related
    expect(ask([entry("Zoom")], "https://ws.g.pro/")).toBe("ws.g.pro");
    expect(ask([entry("GitHub", ["github.com"])], "https://ws.g.pro/")).toBe("ws.g.pro"); // registered elsewhere
    expect(ask([entry("NAS")], "http://192.168.1.10:5001/")).toBe("192.168.1.10"); // an address can be registered
  });

  it("not when an account is registered for the page or a parent of it", () => {
    expect(ask([entry("ws", ["ws.g.pro"]), entry("Zoom")], "https://ws.g.pro/")).toBeNull();
    expect(ask([entry("Zoom"), entry("X", ["g.pro"])], "https://ws.g.pro/admin/")).toBeNull();
  });

  it("not while searching (results or none), not with no accounts, not on a page that cannot be registered", () => {
    expect(ask([entry("ws"), entry("Zoom")], "https://ws.g.pro/", "zo")).toBeNull();
    expect(ask([entry("ws")], "https://ws.g.pro/", "zzz")).toBeNull();
    expect(ask([], "https://ws.g.pro/")).toBeNull();
    for (const url of [
      "http://localhost:3000/",
      "http://intranet/",
      "chrome://newtab/",
      "file:///x.html",
      "about:blank",
      "",
    ])
      expect(ask([entry("ws"), entry("Zoom")], url), url).toBeNull();
  });
});

describe("the account the page's user name names comes first (owner, 2026-11-18)", () => {
  const named = (label: string, domains?: string[]) => ({ ...entry("CSLink", domains), label });
  it("names: the label itself, or the part before an @, case and spaces aside", () => {
    expect(namesUser({ label: "admin2" }, "admin2")).toBe(true);
    expect(namesUser({ label: "Admin2 " }, " ADMIN2")).toBe(true);
    expect(namesUser({ label: "admin2@cslink.vip" }, "admin2")).toBe(true);
    expect(namesUser({ label: "admin2" }, "admin2@cslink.vip")).toBe(true);
    expect(namesUser({ label: "admin" }, "admin2")).toBe(false);
    expect(namesUser({ label: "admin2" }, "")).toBe(false);
    expect(namesUser({ label: "admin2" }, null)).toBe(false);
  });
  it("the site's rows: the named account first, the others in their order; no user name, no change", () => {
    const list = [named("N000021"), named("N269225"), named("admin"), named("admin2"), named("CN67474")];
    const rows = filterRows(list, "", "admin.cslink.vip");
    expect(userFirst(rows, "admin2").map((r) => r.entry.label)).toEqual([
      "admin2",
      "N000021",
      "N269225",
      "admin",
      "CN67474",
    ]);
    expect(userFirst(rows, null)).toBe(rows);
    expect(userFirst(rows, "nobody")).toBe(rows);
  });
  it("only accounts of the site move: an unrelated account with that name stays where it is", () => {
    const other = { ...entry("GitHub"), label: "admin2" };
    const rows = filterRows([named("N000021"), other], "", "admin.cslink.vip");
    expect(userFirst(rows, "admin2").map((r) => r.entry.issuer)).toEqual(["CSLink", "GitHub"]);
  });
});

describe("grouping by name in one click (the owner's report of 2026-11-18)", () => {
  const named = (es: Entry[], plan: Map<string, string>) => es.map((e) => [e.issuer, plan.get(e.id) ?? null]);
  it("the owner's accounts: one service's accounts together, by the first word of the name; a service with one account stays", () => {
    const es = [
      entry("Sharelife"),
      entry("Sharelife"),
      entry("Sharelife"),
      entry("CSLink"),
      entry("DynastyX"),
      entry("DynastyX-Admin"),
      entry("乐支付"),
      entry("cslink"),
      entry("MomoPay"),
      entry("Amazon Web Services"),
      entry("MomoPay"),
      entry("Amazon Web Services"),
      entry("KuCoin"),
      entry(""),
      entry(""),
    ];
    expect(named(es, autoGroups(es))).toEqual([
      ["Sharelife", "Sharelife"],
      ["Sharelife", "Sharelife"],
      ["Sharelife", "Sharelife"],
      ["CSLink", "CSLink"], // the same name, case aside: the first account's spelling
      ["DynastyX", "DynastyX"], // not all the same issuer: the word they share
      ["DynastyX-Admin", "DynastyX"],
      ["乐支付", null],
      ["cslink", "CSLink"],
      ["MomoPay", "MomoPay"],
      ["Amazon Web Services", "Amazon Web Services"], // all the same issuer: the issuer, whole
      ["MomoPay", "MomoPay"],
      ["Amazon Web Services", "Amazon Web Services"],
      ["KuCoin", null],
      ["", null], // no name: nothing to go by
      ["", null],
    ]);
  });
  it("accounts already in a group stay where they are; one alone joins a group of its name, whatever its case", () => {
    const es = [
      entry("GitHub", undefined, "Work"),
      entry("GitHub"),
      entry("Sharelife", undefined, "sharelife"),
      entry("Sharelife"),
      entry("Binance", undefined, "Binance"),
    ];
    expect(named(es, autoGroups(es))).toEqual([
      ["GitHub", null], // in Work: never moved
      ["GitHub", null], // alone among the accounts in no group
      ["Sharelife", null],
      ["Sharelife", "sharelife"],
      ["Binance", null],
    ]);
  });
  it("a name longer than a group may be is cut to the limit", () => {
    const long = "X".repeat(LIMITS.group + 10);
    const es = [entry(long), entry(long)];
    expect([...autoGroups(es).values()]).toEqual(["X".repeat(LIMITS.group), "X".repeat(LIMITS.group)]);
  });
});

describe("on a site, the accounts used more often first (the owner's question of 2026-11-18)", () => {
  it("more uses first; the same number keeps the list's order; an unreadable count is none", () => {
    const es = [entry("A"), entry("B"), entry("C"), entry("D")];
    const rows = es.map((entry) => ({ entry, tier: "related" as const }));
    const uses = { [es[2]!.id]: 3, [es[3]!.id]: 1, [es[1]!.id]: Number.NaN } as Record<string, number>;
    expect(byUse(rows, uses).map((r) => r.entry.issuer)).toEqual(["C", "D", "A", "B"]);
    expect(byUse(rows, {}).map((r) => r.entry.issuer)).toEqual(["A", "B", "C", "D"]);
    // the page's user name still comes before any count
    const u = rows.map((r, i) => ({ ...r, entry: { ...r.entry, label: ["x", "admin2", "y", "z"][i]! } }));
    expect(userFirst(byUse(u, uses), "admin2").map((r) => r.entry.issuer)).toEqual(["B", "C", "D", "A"]);
  });
});

describe("accounts of the same name (the owner's report of 2026-11-18)", () => {
  it("numbered among themselves in the list's order, case and spaces aside; others not at all; a note is searched", () => {
    const es = [entry("NbdPay OTC"), entry("NbdPay OTC"), entry("nbdpay otc "), entry("Other")];
    es[0]!.label = "admin";
    es[1]!.label = "M10001";
    es[2]!.label = "Admin";
    es[3]!.label = "admin";
    const d = sameNames(es);
    expect([...d.entries()]).toEqual([
      [es[0]!.id, 1],
      [es[2]!.id, 2],
    ]);
    es[2]!.note = "Shop B";
    expect(filterRows(es, normalizeQuery("shop b"), null).map((r) => r.entry.id)).toEqual([es[2]!.id]);
  });
});

describe("the accounts of one name side by side (the owner's report of 2026-11-18)", () => {
  it("each moves up to the first of its name; everything else keeps its order", () => {
    const es = [entry("CSLink"), entry("CSLink"), entry("CSLink"), entry("CSLink"), entry("CSLink")];
    ["CS001226", "N000021", "N242048", "N000021", "cs001226 "].forEach((l, i) => (es[i]!.label = l));
    const rows = es.map((entry) => ({ entry, tier: null }));
    expect(sameTogether(rows).map((r) => r.entry.label)).toEqual([
      "CS001226",
      "cs001226 ",
      "N000021",
      "N000021",
      "N242048",
    ]);
    expect(sameTogether([])).toEqual([]);
  });
});
