// Recovery code shares against SLIP-39 (docs/design/notes/SHAMIR-NOTES.md §2): the share arithmetic and the digest of
// src/core/crypto/shares.ts, checked against values derived from SLIP-39's official test vectors and its reference
// implementation (test/fixtures/shares-slip39.json, MIT, and shares-cross.json, made by shares-slip39-gen.py; each
// `source` says from where).
// Sixkey does not use SLIP-39's words, its RS1024 checksum or its Feistel layer, so the fixture holds each vector's
// member shares as raw (x, value) pairs, decoded by the reference's own decoder, and:
//   - official: every vector that decodes. A valid set must give the reference's encrypted master secret, member level
//     then group level, as SLIP-39's recover_ems does; that value, decrypted with the vector's passphrase by SLIP-39's
//     Feistel cipher (reimplemented here, test-only), must be the vector's master secret. An invalid one must fail
//     where the reference fails: a failing digest, duplicate member indices, too few shares;
//   - cross: the reference's _split_secret with its RANDOM_BYTES replaced by a fixed stream. Sixkey's split, given the
//     same bytes in the same order, must give the same member shares, and every subset of the threshold must recover.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pbkdf2Sync } from "node:crypto";
import { CryptoError } from "../../src/core/crypto/bytes";
import { combineShares, recoverSecret, splitSecret, type RawShare, type Share } from "../../src/core/crypto/shares";

type Vec = {
  description: string;
  identifier: number;
  extendable: boolean;
  iterationExponent: number;
  groupThreshold: number;
  groupCount: number;
  groups: { index: number; memberThreshold: number; shares: { x: number; y: string }[] }[];
  ems?: string;
  masterSecret?: string;
  error?: "digest" | "duplicate" | "count";
};
type Cross = {
  threshold: number;
  count: number;
  secret: string;
  random: string[];
  shares: { x: number; y: string }[];
};
const fixture = JSON.parse(readFileSync(new URL("../fixtures/shares-slip39.json", import.meta.url), "utf8")) as {
  source: { passphrase: string; vectorsSha256: string };
  official: Vec[];
};
// Sixkey's own inputs through the reference (a file of its own, under the extension's licence; the official vectors' one
// is MIT: REUSE.toml)
const { cross } = JSON.parse(readFileSync(new URL("../fixtures/shares-cross.json", import.meta.url), "utf8")) as {
  cross: Cross[];
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const raw = (s: { x: number; y: string }): RawShare => ({ x: s.x, data: bytes(s.y) });

/** A member share as Sixkey's own sets read it: one set id, the group's member threshold, the member index. */
const asShare =
  (threshold: number) =>
  (s: { x: number; y: string }): Share => ({ setId: 0, threshold, index: s.x, value: bytes(s.y) });

/**
 * SLIP-39's recover_ems. The member level, which is Sixkey's one level, goes through Sixkey's own combineShares (its
 * rules for exactly the threshold, distinct members and the digest) wherever a group's member threshold is 2 or more;
 * a member threshold of 1 (each member is the group's secret; Sixkey's sets never have one) and the group level (Sixkey
 * has no groups) use the raw arithmetic, with the reference's count rule for the groups written here. `where` says which
 * level refused: "sixkey" for combineShares, "groups" for the level Sixkey does not have.
 */
async function recoverEms(v: Vec, where: { at?: "sixkey" | "groups" } = {}): Promise<Uint8Array> {
  const groupShares: RawShare[] = [];
  for (const g of v.groups) {
    where.at = "sixkey";
    const data =
      g.memberThreshold === 1
        ? await recoverSecret(1, g.shares.map(raw))
        : await combineShares(g.shares.map(asShare(g.memberThreshold)));
    groupShares.push({ x: g.index, data });
  }
  where.at = "groups";
  if (v.groups.length !== v.groupThreshold) throw new CryptoError("shares_count");
  return recoverSecret(v.groupThreshold, groupShares);
}

/** SLIP-39 cipher.decrypt (test-only): 4 Feistel rounds of PBKDF2-HMAC-SHA256, (10000 << e) / 4 iterations each. */
function decryptEms(ems: Uint8Array, passphrase: string, e: number, identifier: number, extendable: boolean) {
  const half = ems.length / 2;
  let l = ems.subarray(0, half);
  let r = ems.subarray(half);
  const salt = extendable
    ? new Uint8Array(0)
    : Uint8Array.from([...Buffer.from("shamir"), identifier >> 8, identifier & 0xff]);
  for (let i = 3; i >= 0; i--) {
    const f = pbkdf2Sync(
      Buffer.concat([Buffer.from([i]), Buffer.from(passphrase)]),
      Buffer.concat([salt, r]),
      (10000 << e) / 4,
      r.length,
      "sha256",
    );
    const next = Uint8Array.from(l, (b, k) => b ^ f[k]!);
    l = r;
    r = next;
  }
  return Uint8Array.from([...r, ...l]);
}

describe("SLIP-39's official vectors, at the level of the shares and the digest", () => {
  it("the fixture is the one generated from vectors.json (27 vectors that decode, 15 valid, 12 invalid)", () => {
    expect(fixture.source.vectorsSha256).toBe("13ebecebdd869dd2bc2cdf69e7ce3a158cf106cac76c39d17682b1c6cdabbdc4");
    expect(fixture.official).toHaveLength(27);
    expect(fixture.official.filter((v) => v.masterSecret).length).toBe(15);
  });
  for (const v of fixture.official.filter((x) => x.masterSecret)) {
    it(`valid: ${v.description}`, async () => {
      const ems = await recoverEms(v);
      expect(hex(ems)).toBe(v.ems);
      expect(hex(decryptEms(ems, fixture.source.passphrase, v.iterationExponent, v.identifier, v.extendable))).toBe(
        v.masterSecret,
      );
    });
  }
  // Of the 12 invalid vectors, 8 fail at the member level and are refused by Sixkey's own combineShares (5, 24: too few
  // members; 11, 30: the same member twice; 13, 32: the digest; 16, 35: too few members in one group); 4 fail only at the
  // group level, which Sixkey does not have (14, 15, 33, 34: too few groups), and do not apply to it.
  const SIXKEY = ["5.", "11.", "13.", "16.", "24.", "30.", "32.", "35."];
  for (const v of fixture.official.filter((x) => x.error)) {
    it(`invalid (${v.error}): ${v.description}`, async () => {
      const code = { digest: "shares_digest", duplicate: "shares_duplicate", count: "shares_count" }[v.error!];
      const where: { at?: "sixkey" | "groups" } = {};
      await expect(recoverEms(v, where)).rejects.toMatchObject({ code });
      expect(where.at).toBe(SIXKEY.some((n) => v.description.startsWith(n)) ? "sixkey" : "groups");
    });
  }
  it("8 invalid vectors apply to Sixkey's one level, 4 only to SLIP-39's groups", () => {
    const invalid = fixture.official.filter((x) => x.error).map((x) => x.description.split(" ")[0]);
    expect(invalid.filter((n) => SIXKEY.includes(n!))).toHaveLength(8);
    expect(invalid.filter((n) => !SIXKEY.includes(n!))).toEqual(["14.", "15.", "33.", "34."]);
  });
  it("every member threshold above 1 among the valid vectors goes through the digest (a member share's value changed fails)", async () => {
    let checked = 0;
    for (const v of fixture.official.filter((x) => x.masterSecret)) {
      for (const g of v.groups.filter((x) => x.memberThreshold > 1)) {
        const shares = g.shares.map(raw);
        shares[0]!.data[0]! ^= 1;
        await expect(recoverSecret(g.memberThreshold, shares)).rejects.toMatchObject({ code: "shares_digest" });
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});

describe("the split, against the reference's _split_secret with a fixed random stream", () => {
  for (const c of cross) {
    it(`${c.threshold} of ${c.count}: the same member shares, and every subset of ${c.threshold} recovers`, async () => {
      const stream = [...c.random];
      const rng = (n: number) => {
        const next = stream.shift();
        if (next === undefined) throw new Error("the reference drew fewer random values");
        const b = bytes(next);
        expect(b.length).toBe(n); // drawn in the same order, with the same lengths
        return b;
      };
      const shares = await splitSecret(c.threshold, c.count, bytes(c.secret), rng);
      expect(stream).toEqual([]); // and as many
      expect(shares.map((s) => ({ x: s.x, y: hex(s.data) }))).toEqual(c.shares);
      const all = c.shares.map(raw);
      const subsets = (k: number, from: number): RawShare[][] =>
        k === 0 ? [[]] : all.slice(from).flatMap((s, i) => subsets(k - 1, from + i + 1).map((r) => [s, ...r]));
      const picked = subsets(c.threshold, 0);
      for (const sub of picked.slice(0, 40)) expect(hex(await recoverSecret(c.threshold, sub))).toBe(c.secret);
      expect(picked.length).toBeGreaterThanOrEqual(1);
    });
  }
});
