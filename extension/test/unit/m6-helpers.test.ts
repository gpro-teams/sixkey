// The Sync section's small helpers: the recovery code as typed and confirmed (recovery.ts), the email and the one-time
// code (signin.ts), the account check's untrusted numbers (account.ts), the review's rows and answers (review.ts) and the
// section's translator (text.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountOf } from "../../src/options/sync/account";
import type { SyncKit } from "../../src/options/sync/gateway";
import { fullLength, groupedInput, groupsMatch, pickGroups } from "../../src/options/sync/recovery";
import { answerOf, reviewRows } from "../../src/options/sync/review";
import { emailOk, sixDigits } from "../../src/options/sync/signin";
import { loadSyncText, st, syncCatalog } from "../../src/options/sync/text";
import { setLangChoice } from "../../src/ui/i18n";
import { emptyVault } from "../../src/core/vault/model";

const CODE = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";

describe("the recovery code", () => {
  it("typed loosely, shown in groups, read the way the code is read (O as 0, I and L as 1), nothing cut off", () => {
    expect(groupedInput("abcd efgh")).toBe("ABCD-EFGH");
    expect(groupedInput("o1il")).toBe("0111");
    // a symbol too many stays (MUST 10: "not 28 symbols" is said, never a code silently shortened to fit)
    expect(groupedInput(`${CODE}-EXTRA`)).toBe(`${CODE}-EXTR-A`);
    expect(fullLength(`${CODE}-EXTRA`)).toBe(false);
    expect(fullLength(CODE.toLowerCase().replace(/-/g, " "))).toBe(true);
    expect(fullLength("ABCD-EFGH")).toBe(false);
  });
  it("two different groups to type back, in order, for any draw", () => {
    for (let i = 0; i < 49; i++) {
      const a = Math.floor(i / 7) / 7 + 0.001,
        b = (i % 7) / 7 + 0.001;
      let n = 0;
      const [x, y] = pickGroups(() => (n++ === 0 ? a : b));
      expect(x).toBeLessThan(y);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(7);
    }
  });
  it("the groups typed back must be those groups, read as the code is read", () => {
    expect(groupsMatch(CODE, [0, 6], ["abcd", "2345"])).toBe(true);
    expect(groupsMatch(CODE, [5, 6], ["yz0l", "2345"])).toBe(true); // l read as 1
    expect(groupsMatch(CODE, [0, 6], ["2345", "abcd"])).toBe(false); // swapped
    expect(groupsMatch(CODE, [0, 1], ["ABCD", ""])).toBe(false);
  });
});

describe("signing in", () => {
  it("an email address, roughly (the server says exactly)", () => {
    for (const ok of ["a@b.co", "first.last+tag@example.com"]) expect(emailOk(ok), ok).toBe(true);
    for (const bad of ["", "a@b", "a b@c.de", "@b.co", "a@.co"]) expect(emailOk(bad), bad).toBe(false);
  });
  it("six digits from what was typed or pasted", () => {
    expect(sixDigits("123456")).toBe("123456");
    expect(sixDigits("123 456")).toBe("123456");
    expect(sixDigits("123-456")).toBe("123456");
    for (const bad of ["12345", "1234567", "12a456", ""]) expect(sixDigits(bad), bad).toBeNull();
  });
});

describe("the account check (§3.5: the server's numbers are only a reminder)", () => {
  const kit = (a: Record<string, unknown>) => ({ engine: { api: { account: async () => a } } }) as unknown as SyncKit;
  const s = { token: "t", sub: "s" };
  it("plain numbers in range are shown; anything else is unknown", async () => {
    expect(
      await accountOf(
        kit({
          has_vault: true,
          vault_created_at: 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000),
          device_count: 3,
        }),
        s,
      ),
    ).toEqual({ hasVault: true, info: { createdAt: 1_800_000_000_000 - (1_800_000_000_000 % 3_600_000), devices: 3 } });
    for (const bad of [
      { vault_created_at: "2026", device_count: "3" },
      { vault_created_at: 1.5, device_count: -1 },
      { vault_created_at: 1_800_000_000_001, device_count: 1e9 },
    ]) {
      expect((await accountOf(kit({ has_vault: true, ...bad }), s)).info).toEqual({ createdAt: null, devices: null });
    }
    expect((await accountOf(kit({ has_vault: "yes" }), s)).hasVault).toBe(false);
  });
});

describe("the review (§4.4)", () => {
  it("rows named from this device's vault, erased ones first, each account once; the answers bound to what was seen", () => {
    const v = {
      ...emptyVault("v1"),
      entries: [
        { id: "a", issuer: "GitHub", label: "alice" },
        { id: "b", issuer: "", label: "bob@x" },
      ],
    } as unknown as Parameters<typeof reviewRows>[1];
    const blocked = {
      report: { secretChanged: ["b", "a"], purgedAlive: ["a"], trashed: [], purgedFromTrash: [] },
      seen: { a: "h1", b: "h2" },
    };
    expect(reviewRows(blocked, v)).toEqual([
      { id: "a", name: "GitHub", account: "alice", why: "erased" },
      { id: "b", name: "bob@x", account: "", why: "secret" },
    ]);
    expect(reviewRows(blocked, null)[0]).toMatchObject({ name: "" });
    expect(answerOf(blocked, "apply")).toEqual({ seen: blocked.seen, accept: ["a", "b"] });
    expect(answerOf(blocked, "keep")).toEqual({ seen: blocked.seen, keepMine: ["a", "b"] });
  });
});

describe("the section's translator", () => {
  it("substitutes $1..$9; a missing key shows itself; a catalog that cannot load falls back to English, then to nothing", async () => {
    await loadSyncText(async () => ({ syncX: { message: "a $1 b $2" } }));
    expect(st("syncX", 1, "two")).toBe("a 1 b two");
    expect(st("syncMissing")).toBe("syncMissing");
    await loadSyncText(async (lang) => {
      if (lang !== "en") throw new Error("no");
      return { syncX: { message: "en" } };
    });
    expect(st("syncX")).toBe("en");
    await loadSyncText(async () => {
      throw new Error("none");
    });
    expect(st("syncX")).toBe("syncX");
  });

  it("the section's own source loads both of its files, in the page's language (the managing screens' since the budget relief)", async () => {
    const file = (n: string) =>
      JSON.parse(readFileSync(join(__dirname, "../../catalogs", n), "utf8")) as Record<string, { message: string }>;
    try {
      for (const [lang, suffix] of [
        ["en", "en"],
        ["zh_CN", "zh_CN"],
      ] as const) {
        setLangChoice(lang);
        const main = file(`sync-${suffix}.json`);
        const manage = file(`sync-manage-${suffix}.json`);
        await loadSyncText(); // the default: syncCatalog
        for (const k of [
          Object.keys(main)[0]!,
          Object.keys(main).at(-1)!,
          Object.keys(manage)[0]!,
          Object.keys(manage).at(-1)!,
        ])
          expect(st(k), `${lang} ${k}`).toBe((main[k] ?? manage[k])!.message.replace(/\$(\d)/g, ""));
        expect(Object.keys(await syncCatalog(lang)).length).toBe(Object.keys(main).length + Object.keys(manage).length);
      }
    } finally {
      setLangChoice("en");
    }
  });
});
