import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deserializeVault, parseVault, serializeVault, VaultError } from "../../src/core/vault/validate";
import { createClock } from "../../src/core/vault/hlc";
import { addEntry, deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { emptyVault } from "../../src/core/vault/model";

const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
function sample() {
  let v = emptyVault("vault-0123456789");
  v = addEntry(
    v,
    {
      type: "totp",
      issuer: "GitHub",
      label: "alice",
      secret: "jbswy3dp ehpk3pxp",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      domains: ["github.com"],
      group: "Work",
    },
    clock,
    { id: "entry-0000001" },
  ).vault;
  v = addEntry(
    v,
    {
      type: "hotp",
      issuer: "Bank",
      label: "a",
      secret: "GEZDGNBVGY3TQOJQ",
      algorithm: "SHA256",
      digits: 8,
      period: 30,
      counter: 4,
    },
    clock,
    { id: "entry-0000002" },
  ).vault;
  return v;
}
const raw = () => JSON.parse(JSON.stringify(sample()));

describe("parseVault", () => {
  it("accepts what the ops produce, and stores secrets canonically", () => {
    const v = sample();
    expect(v.entries[0]!.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(parseVault(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  it("round-trips through bytes", () => {
    const v = sample();
    expect(deserializeVault(serializeVault(v))).toEqual(v);
  });
  it("serialisation is canonical: key order does not matter", () => {
    const v = sample();
    const shuffled = JSON.parse(JSON.stringify(v), (_, x) =>
      x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).reverse()) : x,
    );
    expect(Buffer.from(serializeVault(parseVault(shuffled)))).toEqual(Buffer.from(serializeVault(v)));
  });
  it("an empty secret is the marker of an erased entry: it loads, and is never alive", async () => {
    const { isAlive } = await import("../../src/core/vault/model");
    const r = raw();
    r.entries[0].secret = "";
    const v = parseVault(r);
    expect(isAlive(v.entries[0]!)).toBe(false);
  });
  it("keeps deleted and purged entries", () => {
    let v = sample();
    v = deleteEntry(v, "entry-0000001", clock);
    v = purgeEntry(v, "entry-0000002", clock);
    expect(parseVault(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  const mutations: [string, (r: any) => void][] = [
    ["schemaVersion 0", (r) => (r.schemaVersion = 0)],
    ["missing vaultId", (r) => delete r.vaultId],
    ["bad vaultId", (r) => (r.vaultId = "a|b")],
    ["entries not an array", (r) => (r.entries = {})],
    ["duplicate ids", (r) => (r.entries[1].id = r.entries[0].id)],
    ["id too short", (r) => (r.entries[0].id = "x")],
    ["bad type", (r) => (r.entries[0].type = "steam")],
    ["bad algorithm", (r) => (r.entries[0].algorithm = "MD5")],
    ["bad digits", (r) => (r.entries[0].digits = 7)],
    ["bad period", (r) => (r.entries[0].period = 0)],
    ["fractional period", (r) => (r.entries[0].period = 1.5)],
    ["bad hlc", (r) => (r.entries[0].hlc = "nope")],
    ["bad phlc", (r) => delete r.entries[0].phlc],
    ["bad order", (r) => (r.entries[0].order = "a0")],
    ["secret not canonical", (r) => (r.entries[0].secret = "jbswy3dp")],
    ["secret not base32", (r) => (r.entries[0].secret = "JBSW!Y3D")],
    ["negative counter", (r) => (r.entries[1].counter = -1)],
    ["too many domains", (r) => (r.entries[0].domains = Array(17).fill("a.com"))],
    ["domain not a string", (r) => (r.entries[0].domains = [1])],
    ["issuer too long", (r) => (r.entries[0].issuer = "x".repeat(257))],
    ["deleted not boolean", (r) => (r.entries[0].deleted = "yes")],
    ["bad dhlc", (r) => (r.entries[0].dhlc = 5)],
    ["createdAt negative", (r) => (r.entries[0].createdAt = -1)],
    ["entry is null", (r) => (r.entries[0] = null)],
  ];
  for (const [name, mutate] of mutations) {
    it(`rejects: ${name}`, () => {
      const r = raw();
      mutate(r);
      expect(() => parseVault(r)).toThrow(VaultError);
    });
  }

  it("refuses data from a newer schema without touching it", () => {
    const r = raw();
    r.schemaVersion = 2;
    try {
      parseVault(r);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(VaultError);
      expect((e as VaultError).code).toBe("newer_schema");
    }
  });
  it("garbage never throws anything but VaultError", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        try {
          parseVault(x);
        } catch (e) {
          expect(e).toBeInstanceOf(VaultError);
        }
      }),
      { numRuns: 500 },
    );
    expect(() => deserializeVault(new Uint8Array([0xff, 0xfe]))).toThrow(VaultError);
    expect(() => deserializeVault(new TextEncoder().encode("{not json"))).toThrow(VaultError);
  });
});

describe("an account's note (the owner's report of 2026-11-18: two accounts of one name told apart)", () => {
  it("is kept through bytes, may be absent, and is refused past its limit or when it is not text", () => {
    const v = addEntry(
      emptyVault("vault-0123456789"),
      {
        type: "totp",
        issuer: "NbdPay OTC",
        label: "admin",
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        note: "Shop A",
      },
      clock,
      { id: "entry-0000009" },
    ).vault;
    expect(deserializeVault(serializeVault(v)).entries[0]!.note).toBe("Shop A");
    expect(parseVault(raw()).entries.every((e) => e.note === undefined)).toBe(true);
    const long = raw();
    long.entries[0].note = "x".repeat(65);
    expect(() => parseVault(long)).toThrow(VaultError);
    const notText = raw();
    notText.entries[0].note = 7;
    expect(() => parseVault(notText)).toThrow(VaultError);
  });
});
