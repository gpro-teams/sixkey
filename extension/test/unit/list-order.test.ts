// PHASE0X-PLAN B1: the popup list's order. Manual keeps the vault's order; by name sorts with the current language's
// collation; the current site's accounts come first either way.
import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/vault/model";
import { buildSections, filterRows, sortByName, type Order } from "../../src/popup/main/model";

const LABELS = { results: "results", ungrouped: "accounts" };
let n = 0;
function entry(issuer: string, label = "", group?: string, domains?: string[]): Entry {
  n++;
  return {
    id: `id${String(n).padStart(3, "0")}`,
    type: "totp",
    issuer,
    label,
    secret: "JBSWY3DPEHPK3PXP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    counter: 0,
    ...(group ? { group } : {}),
    ...(domains ? { domains } : {}),
  } as Entry;
}
const en: Order = { sort: "name", compare: new Intl.Collator("en", { sensitivity: "base", numeric: true }).compare };
const zh: Order = { sort: "name", compare: new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true }).compare };
const names = (rows: { entry: Entry }[]) => rows.map((r) => r.entry.issuer || r.entry.label);

describe("popup list order", () => {
  const vault = [
    entry("Zoom"),
    entry("aws"),
    entry("GitHub", "work"),
    entry("Binance", "", "Money"),
    entry("GitHub", "alice"),
    entry("Apple", "", "Home"),
    entry("", "label only"),
    entry("PayPal", "", "Money"),
  ];

  it("manual keeps the vault's order, as before (the default)", () => {
    const rows = filterRows(vault, "", null);
    const manual = buildSections(rows, "", null, LABELS);
    expect(manual).toEqual(buildSections(rows, "", null, LABELS, { sort: "manual" }));
    expect(manual.map((s) => [s.label, names(s.rows)])).toEqual([
      ["accounts", ["Zoom", "aws", "GitHub", "GitHub", "label only"]],
      ["Money", ["Binance", "PayPal"]],
      ["Home", ["Apple"]],
    ]);
  });

  it("by name: rows sorted inside each section, case-insensitive, label then id break ties; groups by name, ungrouped last", () => {
    const s = buildSections(filterRows(vault, "", null), "", null, LABELS, en);
    expect(s.map((x) => [x.label, names(x.rows)])).toEqual([
      ["Home", ["Apple"]],
      ["Money", ["Binance", "PayPal"]],
      ["accounts", ["aws", "GitHub", "GitHub", "label only", "Zoom"]],
    ]);
    const gh = s[2]!.rows.filter((r) => r.entry.issuer === "GitHub").map((r) => r.entry.label);
    expect(gh).toEqual(["alice", "work"]);
  });

  it("numbers inside names sort as numbers", () => {
    const rows = filterRows([entry("Server 10"), entry("Server 9"), entry("Server 1")], "", null);
    expect(names(buildSections(rows, "", null, LABELS, en)[0]!.rows)).toEqual(["Server 1", "Server 9", "Server 10"]);
  });

  it("the current site's accounts stay first, whatever the order", () => {
    const site = [
      entry("Zeta", "", undefined, ["example.com"]),
      entry("Alpha"),
      entry("Beta", "", undefined, ["example.com"]),
    ];
    for (const order of [{ sort: "manual" } as Order, en]) {
      const s = buildSections(filterRows(site, "", "example.com"), "", "example.com", LABELS, order);
      expect(s[0]!.key).toBe("site");
      expect(s[0]!.label).toBe("example.com");
      expect(new Set(names(s[0]!.rows))).toEqual(new Set(["Zeta", "Beta"]));
    }
    expect(names(buildSections(filterRows(site, "", "example.com"), "", "example.com", LABELS, en)[0]!.rows)).toEqual([
      "Beta",
      "Zeta",
    ]);
    expect(
      names(buildSections(filterRows(site, "", "example.com"), "", "example.com", LABELS, { sort: "manual" })[0]!.rows),
    ).toEqual(["Zeta", "Beta"]);
  });

  it("search results: site matches first, then the rest, each part by name", () => {
    const list = [
      entry("Zeta mail", "", undefined, ["example.com"]),
      entry("Alpha mail"),
      entry("Beta mail", "", undefined, ["example.com"]),
      entry("Other"),
    ];
    const s = buildSections(filterRows(list, "mail", "example.com"), "mail", "example.com", LABELS, en);
    expect(s).toHaveLength(1);
    expect(s[0]!.key).toBe("results");
    expect(names(s[0]!.rows)).toEqual(["Beta mail", "Zeta mail", "Alpha mail"]);
  });

  it("Chinese names use the Chinese collation (pinyin order)", () => {
    const rows = filterRows([entry("招商银行"), entry("阿里云"), entry("百度")], "", null);
    expect(names(buildSections(rows, "", null, LABELS, zh)[0]!.rows)).toEqual(["阿里云", "百度", "招商银行"]);
  });

  it("sortByName does not change its input", () => {
    const rows = filterRows([entry("b"), entry("a")], "", null);
    const before = names(rows);
    sortByName(rows, en.sort === "name" ? en.compare : () => 0);
    expect(names(rows)).toEqual(before);
  });
});
