// The autofill list across computers (core/autofill-marks.ts; the owner's request of 2026-11-18): the sites marked on
// accounts in the vault, added to and taken off as an account's content, and merged as such.
import { describe, expect, it } from "vitest";
import { accountsOf, markedSites, markSite, unmarkSite } from "../../src/core/autofill-marks";
import { createClock } from "../../src/core/vault/hlc";
import { mergeVaults } from "../../src/core/vault/merge";
import { aliveEntries, emptyVault, type Vault } from "../../src/core/vault/model";
import { addEntry, moveEntry } from "../../src/core/vault/ops";
import { deserializeVault, parseVault, serializeVault, VaultError } from "../../src/core/vault/validate";

let t = 1_700_000_000_000;
const a = createClock("aaaa", { now: () => t });
const b = createClock("bbbb", { now: () => t });
const add = (v: Vault, issuer: string, id: string, domains?: string[]) =>
  addEntry(
    v,
    {
      type: "totp",
      issuer,
      label: "admin",
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      ...(domains ? { domains } : {}),
    },
    a,
    { id },
  ).vault;
function vault(): Vault {
  let v = emptyVault("vault-0123456789");
  v = add(v, "CSLink", "entry-0000001", ["cslink.vip"]);
  v = add(v, "CSLink", "entry-0000002", ["cslink.vip"]);
  v = add(v, "Other", "entry-0000003");
  return v;
}

describe("sites marked on accounts", () => {
  it("a site's accounts are those registered for it; marking adds it once to each, unmarking takes it off every one", () => {
    let v = vault();
    const ids = accountsOf(aliveEntries(v), "admin.cslink.vip").map((e) => e.id);
    expect(ids).toEqual(["entry-0000001", "entry-0000002"]);
    t += 1000;
    v = markSite(v, ids, "admin.cslink.vip", a);
    expect(markedSites(aliveEntries(v))).toEqual(["admin.cslink.vip"]);
    expect(markSite(v, ids, "admin.cslink.vip", a)).toBe(v); // already: no edit
    t += 1000;
    v = unmarkSite(v, "admin.cslink.vip", a);
    expect(markedSites(aliveEntries(v))).toEqual([]);
    expect(aliveEntries(v).every((e) => e.autofill === undefined)).toBe(true); // no empty field left
    expect(unmarkSite(v, "admin.cslink.vip", a)).toBe(v);
  });
  it("kept through bytes; refused past its limits; merged as the account's content: a mark on one computer and a move on another both survive", () => {
    let base = vault();
    t += 1000;
    const marked = markSite(base, ["entry-0000001"], "admin.cslink.vip", a);
    expect(deserializeVault(serializeVault(marked)).entries[0]!.autofill).toEqual(["admin.cslink.vip"]);
    t += 1000;
    const moved = moveEntry(base, "entry-0000001", 2, b);
    const m = mergeVaults(marked, moved);
    expect(markedSites(aliveEntries(m))).toEqual(["admin.cslink.vip"]);
    expect(aliveEntries(m).at(-1)!.id).toBe("entry-0000001");
    const raw = JSON.parse(JSON.stringify(marked));
    raw.entries[0].autofill = Array.from({ length: 17 }, (_, i) => `s${i}.example.com`);
    expect(() => parseVault(raw)).toThrow(VaultError);
    raw.entries[0].autofill = [7];
    expect(() => parseVault(raw)).toThrow(VaultError);
    base = vault();
  });
});
