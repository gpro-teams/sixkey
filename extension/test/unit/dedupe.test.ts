// B3: the popup's dedupe rules (src/core/import/dedupe.ts). Keys are compared by the bytes they decode to; the three
// prompts; and "replace" moves the old account to the trash, key intact and restorable, in the same edit.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addOrReplace, keyBytes, verdictOf, verdicts, type Candidate } from "../../src/core/import/dedupe";
import { planImport } from "../../src/core/import/importer";
import { decodeBase32, encodeBase32, normalizeBase32 } from "../../src/core/totp/base32";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault, trashEntries, type Entry, type Vault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, purgeEntry, restoreEntry, setGroup, type NewEntry } from "../../src/core/vault/ops";
import { parseVault, serializeVault } from "../../src/core/vault/validate";

const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
const S1 = "JBSWY3DPEHPK3PXP";
const S2 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// 26 characters carry 130 bits: the last 2 bits of the last character are not part of the 16-byte key, so these two
// different strings are the same key. normalizeBase32 leaves them different.
const T1 = "JBSWY3DPEHPK3PXPJBSWY3DPEA";
const T2 = "JBSWY3DPEHPK3PXPJBSWY3DPED";

const totp = (issuer: string, label: string, secret: string): NewEntry => ({
  type: "totp",
  issuer,
  label,
  secret,
  algorithm: "SHA1",
  digits: 6,
  period: 30,
});
function vaultOf(...items: NewEntry[]): Vault {
  let v = emptyVault("vault-0123456789");
  for (const x of items) v = addEntry(v, x, clock).vault;
  return v;
}
const c = (issuer: string, label: string, secret: string): Candidate => ({ issuer, label, secret });
const NEW = "00000000-0000-4000-8000-00000000000a"; // ids as the popup makes them (crypto.randomUUID)
const N2 = "00000000-0000-4000-8000-00000000000b";
const KEEP = "00000000-0000-4000-8000-00000000000c";

describe("keys are compared by their bytes", () => {
  it("two strings that normalize differently but decode the same are the same key", () => {
    expect(normalizeBase32(T1)).not.toBe(normalizeBase32(T2));
    expect(decodeBase32(T1)).toEqual(decodeBase32(T2));
    expect(keyBytes(T1)).toBe(keyBytes(T2));
    const v = vaultOf(totp("GitHub", "alice", T1));
    expect(verdictOf(c("GitHub", "alice", T2), aliveEntries(v)).k).toBe("exists");
  });
  it("case, spaces, hyphens and padding do not matter", () => {
    const v = vaultOf(totp("GitHub", "alice", S1));
    for (const s of [S1.toLowerCase(), "JBSW Y3DP EHPK 3PXP", "JBSW-Y3DP-EHPK-3PXP", `${S1}======`])
      expect(verdictOf(c("GitHub", "alice", s), aliveEntries(v)).k).toBe("exists");
  });
  it("any key re-encoded from its bytes is the same key (property)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 10, maxLength: 64 }), (bytes) => {
        const s = encodeBase32(bytes);
        expect(keyBytes(s)).toBe(keyBytes(s.toLowerCase().replace(/(.{4})/g, "$1 ")));
        expect(decodeBase32(s)).toEqual(bytes);
      }),
    );
  });
  it("an empty or invalid key matches nothing", () => {
    expect(keyBytes("")).toBeNull();
    expect(keyBytes("not base32!")).toBeNull();
    const v = vaultOf(totp("", "", S1));
    expect(verdictOf(c("", "", "not base32!"), aliveEntries(v)).k).toBe("new");
  });
});

describe("the three prompts", () => {
  const v = vaultOf(totp("GitHub", "alice@example.com", S1), totp("AWS", "root", S2));
  const live = aliveEntries(v);
  const gh = live.find((e) => e.issuer === "GitHub")!;

  it("same key, same issuer: exists (the account label and the issuer's case do not matter)", () => {
    expect(verdictOf(c("GitHub", "alice@example.com", S1), live)).toEqual({ k: "exists", entry: gh });
    expect(verdictOf(c("github", "someone else", S1), live)).toEqual({ k: "exists", entry: gh });
    expect(verdictOf(c(" ＧｉｔＨｕｂ ", "", S1), live).k).toBe("exists"); // full-width, as Chinese input methods type it
  });
  it("same key, another name: same_key, naming the account that has it", () => {
    expect(verdictOf(c("GitLab", "alice@example.com", S1), live)).toEqual({ k: "same_key", entry: gh });
    expect(verdictOf(c("", "", S1), live)).toEqual({ k: "same_key", entry: gh });
  });
  it("same issuer and account, another key: rebind", () => {
    expect(verdictOf(c("GitHub", "alice@example.com", T1), live)).toEqual({ k: "rebind", entry: gh });
    expect(verdictOf(c("GITHUB", "ALICE@example.com", T1), live)).toEqual({ k: "rebind", entry: gh });
  });
  it("same issuer but another account is new, and so is anything else", () => {
    expect(verdictOf(c("GitHub", "bob", T1), live)).toEqual({ k: "new" });
    expect(verdictOf(c("Zoom", "team", T1), live)).toEqual({ k: "new" });
  });
  it("an unnamed key is never a rebind of an unnamed account", () => {
    const u = aliveEntries(vaultOf(totp("", "", S1)));
    expect(verdictOf(c("", "", S2), u)).toEqual({ k: "new" });
  });
  it("only live accounts count: one in the trash is neither a duplicate nor something to replace, and a purged one is gone", () => {
    const trashed = deleteEntry(v, gh.id, clock);
    expect(verdictOf(c("GitHub", "alice@example.com", S1), trashed.entries)).toEqual({ k: "new" });
    expect(verdictOf(c("GitHub", "alice@example.com", T1), trashed.entries)).toEqual({ k: "new" });
    const purged = purgeEntry(v, gh.id, clock);
    expect(verdictOf(c("", "", ""), purged.entries)).toEqual({ k: "new" });
  });
  it("prefers exists over same_key when two accounts share the key", () => {
    const twice = aliveEntries(vaultOf(totp("Other", "x", S1), totp("GitHub", "y", S1)));
    expect(verdictOf(c("GitHub", "alice", S1), twice).k).toBe("exists");
  });
});

describe("a whole paste or scan", () => {
  it("drops later items with a key an earlier item has, even when the strings differ", () => {
    const vs = verdicts([c("A", "", T1), c("B", "", T2), c("C", "", S2)], []);
    expect(vs.map((x) => x.k)).toEqual(["new", "repeat", "new"]);
  });
  it("the text importer alone would add both: that is why the popup compares bytes", () => {
    const { plan } = planImport(`otpauth://totp/A?secret=${T1}\notpauth://totp/A?secret=${T2}`, [], []);
    expect(plan.add).toHaveLength(2);
    expect(verdicts(plan.add, []).map((x) => x.k)).toEqual(["new", "repeat"]);
  });
  it("each item is also judged against the vault", () => {
    const live = aliveEntries(vaultOf(totp("GitHub", "alice", S1)));
    expect(
      verdicts([c("GitHub", "alice", S1), c("GitHub", "alice", S2), c("GitLab", "", S1)], live).map((x) => x.k),
    ).toEqual(["exists", "rebind", "repeat"]);
  });
});

describe("replace", () => {
  const start = (() => {
    let v = vaultOf(totp("First", "1", S2), totp("GitHub", "alice", S1), totp("Last", "2", "MFRGGZDFMZTWQ2LK"));
    const gh = aliveEntries(v).find((e) => e.issuer === "GitHub")!;
    v = setGroup(v, gh.id, "Work", clock);
    v = addOrReplace(v, { ...totp("Other", "", "GEZDGNBVGY3TQOJR") }, clock, { id: KEEP });
    return { v, old: aliveEntries(v).find((e) => e.issuer === "GitHub")! };
  })();
  const withSites = {
    ...start.v,
    entries: start.v.entries.map((e): Entry => (e.id === start.old.id ? { ...e, domains: ["github.com"] } : e)),
  };
  const replaced = addOrReplace(withSites, totp("GitHub", "alice", T1), clock, { id: NEW, replace: start.old.id });

  it("adds the new account and moves the old one to the trash in the same edit", () => {
    const live = aliveEntries(replaced);
    expect(live.map((e) => e.id)).toContain(NEW);
    expect(live.map((e) => e.id)).not.toContain(start.old.id);
    expect(live.find((e) => e.id === NEW)!.secret).toBe(normalizeBase32(T1));
    expect(trashEntries(replaced).map((e) => e.id)).toEqual([start.old.id]);
  });
  it("the old account keeps its key in the trash and can be restored", () => {
    const old = replaced.entries.find((e) => e.id === start.old.id)!;
    expect(old.secret).toBe(S1);
    expect(old.secret).not.toBe("");
    const back = restoreEntry(replaced, start.old.id, clock);
    expect(aliveEntries(back).find((e) => e.id === start.old.id)).toMatchObject({
      issuer: "GitHub",
      label: "alice",
      secret: S1,
      group: "Work",
    });
  });
  it("the new account takes the old one's group, sites and place", () => {
    const fresh = replaced.entries.find((e) => e.id === NEW)!;
    expect(fresh.group).toBe("Work");
    expect(fresh.domains).toEqual(["github.com"]);
    expect(aliveEntries(replaced).map((e) => e.issuer)).toEqual(["First", "GitHub", "Last", "Other"]);
  });
  it("adds a site chosen on the confirm page to the old one's, once", () => {
    const both = addOrReplace(
      withSites,
      { ...totp("GitHub", "alice", T1), domains: ["gist.github.com", "github.com"] },
      clock,
      { id: N2, replace: start.old.id },
    );
    expect(both.entries.find((e) => e.id === N2)!.domains).toEqual(["github.com", "gist.github.com"]);
  });
  it("the result is a valid vault that loads back", () => {
    expect(parseVault(JSON.parse(new TextDecoder().decode(serializeVault(replaced))))).toEqual(replaced);
  });
  it("without replace nothing is deleted (keep both)", () => {
    const kept = addOrReplace(start.v, totp("GitHub", "alice", T1), clock, { id: NEW });
    expect(trashEntries(kept)).toEqual([]);
    expect(aliveEntries(kept).filter((e) => e.issuer === "GitHub")).toHaveLength(2);
  });
  it("replacing an account that is gone or already in the trash changes nothing and throws", () => {
    const gone = deleteEntry(start.v, start.old.id, clock);
    expect(() => addOrReplace(gone, totp("GitHub", "alice", T1), clock, { id: NEW, replace: start.old.id })).toThrow();
    expect(() =>
      addOrReplace(start.v, totp("GitHub", "alice", T1), clock, { id: NEW, replace: "no-such-id" }),
    ).toThrow();
  });
  it("never purges: every entry of the vault before is still there afterwards, with its key", () => {
    for (const e of withSites.entries) expect(replaced.entries.find((x) => x.id === e.id)?.secret).toBe(e.secret);
  });
});
