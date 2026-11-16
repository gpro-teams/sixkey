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
  buildSections,
  filterRows,
  normalizeQuery,
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
