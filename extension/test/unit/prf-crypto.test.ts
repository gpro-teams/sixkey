// The device unlock's crypto and record (QUICK-UNLOCK §5.2, §7.1; Stage 2): the PRF wrap against an independent
// implementation (node:crypto), every AAD field and the key id after the unwrap; sk_prf's parse and its rules (the 14
// days, the once-a-day write, which credentials a device unlock may ask for); the gate's assertion check, clause by clause,
// with ES256 and RS256 keys made and signed by node:crypto; the DER signature reading.
import {
  createCipheriv,
  createHash,
  createHmac,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  b64url,
  clientDataOk,
  derToRaw,
  gateAssertionOk,
  parseAuthData,
  rpIdOk,
  signatureOk,
} from "../../src/core/crypto/assertion";
import { CryptoError } from "../../src/core/crypto/crypto-error";
import {
  b64,
  GATE_MAC_LABEL,
  GATE_TAG,
  gateMac,
  gateMacOk,
  newPrfSalt,
  openPrfWrap,
  PRF_KEK_LABEL,
  PRF_TAG,
  sealPrfWrap,
  unb64,
} from "../../src/core/crypto/prf";
import {
  gateCreds,
  hasGate,
  parsePrfRecord,
  passwordRecent,
  pausedCreds,
  prfCreds,
  prfFor,
  PRF_AHEAD_MS,
  PRF_MAX_CREDS,
  PRF_PASSWORD_MS,
  type PrfCred,
  type PrfMac,
  type PrfRecord,
} from "../../src/core/crypto/prf-record";
import { credOk, usableRecord } from "../../src/core/crypto/prf-check";
import { vkFromRaw } from "../../src/core/crypto/vk";
import { noteDue, PRF_NOTE_MS } from "../../src/core/service/prf-write";
import { rawToDer } from "../helpers/fake-webauthn";

const bytes = (n: number, from = 1) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const VAULT = "vault-id-0001";
const CRED = "Y3JlZGVudGlhbC1pZC0wMDAx";
const DAY = 86_400_000;

/** The wrap as node:crypto makes it: HKDF-SHA256(prf, ∅, label) → AES-256-GCM(iv, vk, AAD). */
function nodeWrap(prf: Uint8Array, vk: Uint8Array, iv: Uint8Array, aad: string): string {
  const kek = Buffer.from(hkdfSync("sha256", prf, Buffer.alloc(0), "sixkey/v1/kek-prf", 32));
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([c.update(vk), c.final(), c.getAuthTag()]).toString("base64");
}

describe("the PRF wrap (prf.ts)", () => {
  it("is exactly HKDF-SHA256(PRF output, empty salt, sixkey/v1/kek-prf) and AES-256-GCM with the AAD of §5.2", async () => {
    expect(PRF_KEK_LABEL).toBe("sixkey/v1/kek-prf");
    expect(PRF_TAG).toBe("sixkey-prf|1|");
    const vk = await vkFromRaw(bytes(32, 0x40));
    const prf = bytes(32, 1);
    const iv = bytes(12, 0x90);
    const w = await sealPrfWrap(vk, VAULT, CRED, prf, () => iv);
    expect(w.vkId).toBe(vk.id);
    expect(w.iv).toBe(Buffer.from(iv).toString("base64"));
    expect(w.wrapped).toBe(nodeWrap(prf, vk.raw, iv, `sixkey-prf|1|${VAULT}|${vk.id}|${CRED}`));
    // and a wrap made by node opens
    const theirs = {
      vkId: vk.id,
      iv: w.iv,
      wrapped: nodeWrap(prf, vk.raw, iv, `sixkey-prf|1|${VAULT}|${vk.id}|${CRED}`),
    };
    expect((await openPrfWrap(theirs, VAULT, CRED, prf, vkFromRaw)).raw).toEqual(vk.raw);
  });

  it("a known answer (pinned bytes): the label, the empty salt and the AAD cannot change unnoticed", async () => {
    const vk = await vkFromRaw(new Uint8Array(32));
    const w = await sealPrfWrap(
      vk,
      "vault-id-0000",
      "AAAAAAAAAAAAAAAAAAAAAA",
      new Uint8Array(32),
      () => new Uint8Array(12),
    );
    expect(createHash("sha256").update(w.wrapped).digest("hex").slice(0, 16)).toBe(
      createHash("sha256")
        .update(
          nodeWrap(
            new Uint8Array(32),
            new Uint8Array(32),
            new Uint8Array(12),
            `sixkey-prf|1|vault-id-0000|${vk.id}|AAAAAAAAAAAAAAAAAAAAAA`,
          ),
        )
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("does not open with another PRF output, vault, key id, credential, IV, or tampered bytes; the key id is checked after", async () => {
    const vk = await vkFromRaw(randomBytes(32));
    const prf = new Uint8Array(randomBytes(32));
    const w = await sealPrfWrap(vk, VAULT, CRED, prf);
    const fails = async (p: Promise<unknown>) => expect(p).rejects.toEqual(new CryptoError("unwrap_failed"));
    await fails(openPrfWrap(w, VAULT, CRED, new Uint8Array(randomBytes(32)), vkFromRaw));
    await fails(openPrfWrap(w, "vault-id-0002", CRED, prf, vkFromRaw));
    await fails(openPrfWrap(w, VAULT, "b3RoZXItY3JlZGVudGlhbA", prf, vkFromRaw));
    await fails(openPrfWrap({ ...w, vkId: "0123456789abcdef" }, VAULT, CRED, prf, vkFromRaw));
    await fails(openPrfWrap({ ...w, iv: b64(bytes(12, 7)) }, VAULT, CRED, prf, vkFromRaw));
    const ct = unb64(w.wrapped);
    ct[3]! ^= 1;
    await fails(openPrfWrap({ ...w, wrapped: b64(ct) }, VAULT, CRED, prf, vkFromRaw));
    await fails(openPrfWrap(w, VAULT, CRED, prf.slice(0, 31), vkFromRaw)); // not a PRF output
    // the key id: another key sealed under a wrap that names it consistently opens, and is refused by its id
    const other = await vkFromRaw(randomBytes(32));
    const forged = await sealPrfWrap(other, VAULT, CRED, prf);
    await fails(openPrfWrap({ ...forged, vkId: vk.id }, VAULT, CRED, prf, vkFromRaw));
    const lying = async () => ({ ...other, id: "0000000000000000" });
    await fails(openPrfWrap(forged, VAULT, CRED, prf, lying)); // whatever vkOf says, the id must be the wrap's
    expect((await openPrfWrap(w, VAULT, CRED, prf, vkFromRaw)).id).toBe(vk.id);
  });

  it("a salt is 32 fresh random bytes; the base64 is bytes.ts's, strictly", () => {
    const a = newPrfSalt();
    const b = newPrfSalt();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(b64(bytes(5))).toBe(Buffer.from(bytes(5)).toString("base64"));
    expect(unb64("AQID")).toEqual(Uint8Array.from([1, 2, 3]));
    for (const bad of ["AQI", "AQ-D", "AQID=", "AQ ID"]) expect(() => unb64(bad), bad).toThrow(CryptoError);
  });
});

describe("a gate credential's MAC (prf.ts; REVIEW S1)", () => {
  /** As node:crypto makes it: HMAC-SHA256(HKDF-SHA256(vk, ∅, label), tag ‖ vault|id|alg|key). */
  const nodeMac = (vk: Uint8Array, data: string) =>
    createHmac("sha256", Buffer.from(hkdfSync("sha256", vk, Buffer.alloc(0), "sixkey/v1/gate-mac", 32)))
      .update(data, "utf8")
      .digest("base64");
  const gate = { id: "Z2F0ZS1jcmVkZW50aWFsLTAx", alg: -7 as const, publicKey: b64(bytes(91)) };

  it("is exactly HMAC-SHA256 under HKDF-SHA256(the vault key, empty salt, sixkey/v1/gate-mac) of the vault, id, algorithm, key", async () => {
    expect(GATE_MAC_LABEL).toBe("sixkey/v1/gate-mac");
    expect(GATE_TAG).toBe("sixkey-gate|1|");
    const vk = await vkFromRaw(bytes(32, 0x40));
    const m = await gateMac(vk, VAULT, gate);
    expect(m.vkId).toBe(vk.id);
    expect(m.tag).toBe(nodeMac(vk.raw, `sixkey-gate|1|${VAULT}|${gate.id}|-7|${gate.publicKey}`));
    expect(await gateMacOk(vk, VAULT, { ...gateCredOf(gate), mac: m })).toBe(true);
    // one made by node checks too
    const theirs = { vkId: vk.id, tag: nodeMac(vk.raw, `sixkey-gate|1|${VAULT}|${gate.id}|-7|${gate.publicKey}`) };
    expect(await gateMacOk(vk, VAULT, { ...gateCredOf(gate), mac: theirs })).toBe(true);
  });

  it("refuses, never throwing: another vault, id, algorithm, public key or vault key; none; a tag that is not one", async () => {
    const vk = await vkFromRaw(bytes(32, 0x40));
    const other = await vkFromRaw(bytes(32, 0x41));
    const mac = await gateMac(vk, VAULT, gate);
    const c = { ...gateCredOf(gate), mac };
    expect(await gateMacOk(vk, VAULT, c)).toBe(true);
    expect(await gateMacOk(vk, "vault-id-0002", c)).toBe(false);
    expect(await gateMacOk(vk, VAULT, { ...c, id: "b3RoZXItY3JlZGVudGlhbC0x" })).toBe(false);
    expect(await gateMacOk(vk, VAULT, { ...c, alg: -257 })).toBe(false);
    expect(await gateMacOk(vk, VAULT, { ...c, publicKey: b64(bytes(91, 2)) })).toBe(false); // a key planted in its place
    expect(await gateMacOk(other, VAULT, c)).toBe(false); // the key changed: paused until it is turned back on
    expect(await gateMacOk(vk, VAULT, { ...c, mac: undefined })).toBe(false);
    expect(await gateMacOk(vk, VAULT, { ...c, mac: { vkId: vk.id, tag: "not base64!" } })).toBe(false);
    expect(await gateMacOk(vk, VAULT, { ...c, mac: { vkId: vk.id, tag: b64(bytes(32)) } })).toBe(false);
  });
});

const gateCredOf = (g: { id: string; alg: -7 | -257; publicKey: string }): PrfCred => ({
  kind: "platform",
  mode: "gate",
  name: "Touch ID",
  synced: false,
  createdAt: 1,
  ...g,
});

// ---- sk_prf -------------------------------------------------------------------------------------------------------

const prfCred = (o: Partial<PrfCred> = {}): PrfCred => ({
  id: "cHJmLWNyZWRlbnRpYWwtMDE",
  kind: "platform",
  mode: "prf",
  name: "Touch ID",
  synced: false,
  createdAt: 1,
  salt: b64(bytes(32)),
  wrap: { vkId: "0123456789abcdef", iv: b64(bytes(12)), wrapped: b64(bytes(48)) },
  ...o,
});
const gateCred = (o: Partial<PrfCred> = {}): PrfCred => ({
  id: "Z2F0ZS1jcmVkZW50aWFsLTAx",
  kind: "platform",
  mode: "gate",
  name: "Touch ID",
  synced: false,
  createdAt: 1,
  publicKey: b64(bytes(91)),
  alg: -7,
  mac: { vkId: "0123456789abcdef", tag: b64(bytes(32)) },
  ...o,
});
const rec = (o: Partial<PrfRecord> = {}): PrfRecord => ({
  v: 1,
  vaultId: VAULT,
  creds: [prfCred(), gateCred()],
  lastPasswordAt: 1_000_000,
  ...o,
});

describe("sk_prf (prf-record.ts)", () => {
  it("the popup's shape check: absent is null; not even shaped like a record is damaged; the rest is left to prf-check", () => {
    expect(parsePrfRecord(undefined)).toBeNull();
    expect(parsePrfRecord(null)).toBeNull();
    expect(parsePrfRecord(rec())).toEqual(rec());
    expect(parsePrfRecord(rec({ creds: [] }))).toEqual(rec({ creds: [] }));
    expect(parsePrfRecord(rec({ lastPasswordAt: undefined }))).not.toBe("damaged");
    for (const x of [
      "x",
      7,
      { ...rec(), v: 2 },
      { ...rec(), vaultId: 5 },
      { ...rec(), creds: "x" },
      { ...rec(), creds: Array.from({ length: PRF_MAX_CREDS + 1 }, () => prfCred()) },
      { ...rec(), lastPasswordAt: "1" },
    ])
      expect(parsePrfRecord(x), JSON.stringify(x).slice(0, 80)).toBe("damaged");
    // a credential that is not one is kept by the shape check and never used: the filters leave it out
    const junk = rec({ creds: [null as unknown as PrfCred, { id: 1 } as unknown as PrfCred, prfCred()] });
    expect(parsePrfRecord(junk)).toEqual(junk);
    expect(prfCreds(junk, "0123456789abcdef")).toHaveLength(1);
    expect(hasGate(junk, "0123456789abcdef")).toBe(false);
  });

  it("prf-check: every field of each credential; the record keeps only the usable ones, and says it left some out", () => {
    const ok = (r: PrfRecord) =>
      expect(usableRecord(r), JSON.stringify(r).slice(0, 80)).toEqual({ rec: r, dropped: false });
    ok(rec());
    ok(rec({ creds: [] }));
    ok(rec({ lastPasswordAt: undefined }));
    ok(rec({ creds: [prfCred({ wrap: null })] })); // paused
    ok(rec({ creds: [prfCred({ name: "指".repeat(40) })] })); // code points
    ok(rec({ creds: [gateCred({ alg: -257 })] }));
    ok(rec({ creds: [gateCred({ mac: undefined })] })); // no MAC yet: paused, "turn back on"
    expect(usableRecord(undefined)).toBeNull();
    for (const x of ["x", { ...rec(), v: 2 }, { ...rec(), vaultId: "short" }, { ...rec(), creds: "x" }])
      expect(usableRecord(x), JSON.stringify(x).slice(0, 80)).toBe("damaged");
    // each unusable credential is left out (beside a good one, which is kept), and the record says so
    const badCreds: PrfCred[] = [
      prfCred({ id: "short" }),
      prfCred({ kind: "phone" as "platform" }),
      prfCred({ mode: "other" as "prf" }),
      prfCred({ name: "x".repeat(41) }),
      prfCred({ synced: "no" as unknown as boolean }),
      prfCred({ provider: "nowhere" as "icloud" }),
      prfCred({ salt: b64(bytes(31)) }),
      prfCred({ salt: undefined }),
      prfCred({ wrap: { vkId: "xyz", iv: b64(bytes(12)), wrapped: b64(bytes(48)) } }),
      prfCred({ wrap: { vkId: "0123456789abcdef", iv: b64(bytes(11)), wrapped: b64(bytes(48)) } }),
      prfCred({ wrap: { vkId: "0123456789abcdef", iv: b64(bytes(12)), wrapped: b64(bytes(47)) } }),
      prfCred({ publicKey: b64(bytes(91)) }), // a PRF credential holds no public key
      gateCred({ publicKey: undefined }),
      gateCred({ publicKey: b64(bytes(63)) }),
      gateCred({ alg: -8 as -7 }),
      gateCred({ wrap: null }), // a gate holds no wrap
      gateCred({ mac: { vkId: "xyz", tag: b64(bytes(32)) } }),
      gateCred({ mac: { vkId: "0123456789abcdef", tag: b64(bytes(31)) } }),
      gateCred({ mac: null as unknown as PrfMac }),
      prfCred({ mac: { vkId: "0123456789abcdef", tag: b64(bytes(32)) } }), // a PRF credential holds no MAC
      prfCred({ createdAt: 1.5 }),
      null as unknown as PrfCred,
    ];
    const good = gateCred({ id: "Z29vZC1nYXRlLWNyZWRlbnRpYWw" });
    for (const c of badCreds) {
      expect(credOk(c), JSON.stringify(c)).toBe(false);
      expect(usableRecord(rec({ creds: [c, good] })), JSON.stringify(c)).toEqual({
        rec: rec({ creds: [good] }),
        dropped: true,
      });
    }
    // the first of an id seen twice; at most 10; an unusable time, or a field it does not know (an earlier draft's
    // session choice), left out
    expect(usableRecord(rec({ creds: [prfCred(), prfCred({ name: "again" })] }))).toEqual({
      rec: rec({ creds: [prfCred()] }),
      dropped: true,
    });
    const many = Array.from({ length: PRF_MAX_CREDS + 1 }, (_, i) => prfCred({ id: `Y3JlZGVudGlhbC0w${i}xx` }));
    expect(usableRecord(rec({ creds: many }))).toEqual({ rec: rec({ creds: many.slice(0, 10) }), dropped: true });
    expect(usableRecord({ ...rec(), lastPasswordAt: -1 })).toEqual({
      rec: rec({ lastPasswordAt: undefined }),
      dropped: true,
    });
    expect(usableRecord({ ...rec(), session: "pin" })).toEqual({ rec: rec(), dropped: true });
  });

  it("prfFor: this vault's record only", () => {
    expect(prfFor(rec(), { vaultId: VAULT })).toEqual(rec());
    expect(prfFor(rec(), { vaultId: "vault-id-0002" })).toBeNull();
    expect(prfFor({ v: 9 }, { vaultId: VAULT })).toBeNull();
  });

  it("which credentials a device unlock may ask for: PRF ones under this key; paused ones; gates of this key", () => {
    const r = rec({
      creds: [
        prfCred({ id: "YWFhYWFhYWFhYWFhYWFhYQ" }),
        prfCred({ id: "YmJiYmJiYmJiYmJiYmJiYg", wrap: null }),
        prfCred({ id: "Y2NjY2NjY2NjY2NjY2NjYw", wrap: { ...prfCred().wrap!, vkId: "fedcba9876543210" } }),
        prfCred({ id: "ZGRkZGRkZGRkZGRkZGRkZA", kind: "security-key" }),
        gateCred(),
        gateCred({ id: "ZWVlZWVlZWVlZWVlZWVlZQ", kind: "security-key" }),
        gateCred({ id: "ZmZmZmZmZmZmZmZmZmZmZg", mac: { vkId: "fedcba9876543210", tag: b64(bytes(32)) } }), // a key change
        gateCred({ id: "Z2dnZ2dnZ2dnZ2dnZ2dnZw", mac: undefined }), // none yet
        gateCred({ id: "aGhoaGhoaGhoaGhoaGhoaA", publicKey: 5 as unknown as string }), // not even a key (REVIEW S2)
      ],
    });
    const K = "0123456789abcdef";
    expect(prfCreds(r, K).map((c) => c.id)).toEqual(["YWFhYWFhYWFhYWFhYWFhYQ"]);
    expect(pausedCreds(r, K).map((c) => c.id)).toEqual([
      "YmJiYmJiYmJiYmJiYmJiYg",
      "Y2NjY2NjY2NjY2NjY2NjYw",
      "ZmZmZmZmZmZmZmZmZmZmZg",
      "Z2dnZ2dnZ2dnZ2dnZ2dnZw",
    ]);
    expect(gateCreds(r, K).map((c) => c.id)).toEqual([gateCred().id]); // a MAC of this key, a public key
    expect(gateCreds(r, "fedcba9876543210").map((c) => c.id)).toEqual(["ZmZmZmZmZmZmZmZmZmZmZg"]);
    expect(hasGate(r, K)).toBe(true);
    expect(hasGate(rec({ creds: [prfCred()] }), K)).toBe(false);
    expect(hasGate(rec({ creds: [gateCred({ mac: undefined })] }), K)).toBe(false); // paused: not armed
    expect(hasGate(rec({ creds: [gateCred({ publicKey: undefined })] }), K)).toBe(false);
  });

  it("the 14 days (Q3): exactly 14 days still counts, one more millisecond does not; a day ahead counts, more does not", () => {
    const at = 1_000_000_000;
    const r = rec({ lastPasswordAt: at });
    expect(PRF_PASSWORD_MS).toBe(14 * DAY);
    expect(PRF_AHEAD_MS).toBe(DAY);
    expect(passwordRecent(r, at)).toBe(true);
    expect(passwordRecent(r, at + 14 * DAY)).toBe(true);
    expect(passwordRecent(r, at + 14 * DAY + 1)).toBe(false);
    expect(passwordRecent(r, at - DAY)).toBe(true);
    expect(passwordRecent(r, at - DAY - 1)).toBe(false);
    expect(passwordRecent(rec({ lastPasswordAt: undefined }), at)).toBe(false);
  });

  it("the master password's time is written at most once a day, and when it is ahead of the clock", () => {
    const at = 5_000_000_000;
    const r = rec({ lastPasswordAt: at });
    expect(PRF_NOTE_MS).toBe(DAY);
    expect(noteDue(r, at)).toBe(false);
    expect(noteDue(r, at + DAY - 1)).toBe(false);
    expect(noteDue(r, at + DAY)).toBe(true);
    expect(noteDue(r, at - 1)).toBe(true); // ahead: written again (the clock went back)
    expect(noteDue(rec({ lastPasswordAt: undefined }), at)).toBe(true);
    expect(noteDue(rec({ creds: [] }), at + 30 * DAY)).toBe(false); // nothing enrolled: nothing written
  });
});

// ---- the gate's assertion check ---------------------------------------------------------------------------------------

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const sha = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

function authData(o: { flags?: number; rp?: string; aaguid?: Uint8Array } = {}): Uint8Array {
  const flags = o.flags ?? 0x05;
  return Uint8Array.from([...sha(o.rp ?? ORIGIN), flags, 0, 0, 0, 7, ...(o.aaguid ? [...o.aaguid, 0, 1, 9] : [])]);
}
function clientData(o: Record<string, unknown> = {}, challenge = bytes(32, 3)): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: ORIGIN, crossOrigin: false, ...o }),
  );
}
const keys = {
  es: generateKeyPairSync("ec", { namedCurve: "P-256" }),
  rs: generateKeyPairSync("rsa", { modulusLength: 2048 }),
};
const spki = (k: { publicKey: { export(o: { type: "spki"; format: "der" }): Buffer } }) =>
  new Uint8Array(k.publicKey.export({ type: "spki", format: "der" }));
function sign(kind: "es" | "rs", ad: Uint8Array, cd: Uint8Array): Uint8Array {
  const s = createSign("sha256");
  s.update(Buffer.concat([ad, sha(cd)]));
  return new Uint8Array(
    kind === "es" ? s.sign({ key: keys.es.privateKey, dsaEncoding: "der" }) : s.sign(keys.rs.privateKey),
  );
}
const want = { challenge: bytes(32, 3), origin: ORIGIN, rpId: ORIGIN };

describe("the gate's assertion check (assertion.ts)", () => {
  it("ES256 (DER) and RS256 assertions of the right key, challenge, origin and RP ID, with UP and UV, pass", async () => {
    for (const kind of ["es", "rs"] as const) {
      const ad = authData();
      const cd = clientData();
      const ok = await gateAssertionOk(
        { authData: ad, clientDataJSON: cd, signature: sign(kind, ad, cd) },
        { spki: spki(keys[kind]), alg: kind === "es" ? -7 : -257 },
        want,
      );
      expect(ok, kind).toBe(true);
    }
  });

  it("each clause refuses on its own: UV, UP, challenge, origin, type, crossOrigin, RP ID hash, signature, key, algorithm", async () => {
    const good = { ad: authData(), cd: clientData() };
    const check = async (
      ad: Uint8Array,
      cd: Uint8Array,
      o: { sig?: Uint8Array; key?: Uint8Array; alg?: number } = {},
    ) =>
      gateAssertionOk(
        { authData: ad, clientDataJSON: cd, signature: o.sig ?? sign("es", ad, cd) },
        { spki: o.key ?? spki(keys.es), alg: o.alg ?? -7 },
        want,
      );
    expect(await check(good.ad, good.cd)).toBe(true);
    expect(await check(authData({ flags: 0x01 }), good.cd)).toBe(false); // UV 0
    expect(await check(authData({ flags: 0x04 }), good.cd)).toBe(false); // UP 0
    expect(await check(good.ad, clientData({}, bytes(32, 4)))).toBe(false); // another challenge
    expect(await check(good.ad, clientData({ origin: "https://evil.example" }))).toBe(false);
    expect(await check(good.ad, clientData({ type: "webauthn.create" }))).toBe(false);
    expect(await check(good.ad, clientData({ crossOrigin: true }))).toBe(false);
    expect(await check(good.ad, clientData({ crossOrigin: undefined }))).toBe(true); // absent: not cross-origin
    expect(await check(authData({ rp: "chrome-extension://another" }), good.cd)).toBe(false); // RP ID hash
    const sig = sign("es", good.ad, good.cd);
    sig[sig.length - 1]! ^= 1;
    expect(await check(good.ad, good.cd, { sig })).toBe(false); // an altered signature
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await check(good.ad, good.cd, { key: spki(other) })).toBe(false); // another key
    expect(await check(good.ad, good.cd, { alg: -257 })).toBe(false); // the wrong algorithm for the key
    expect(await check(good.ad, good.cd, { alg: -8 })).toBe(false); // an algorithm it does not take
    expect(await check(authData().slice(0, 36), good.cd)).toBe(false); // not authenticator data
    expect(await check(good.ad, new TextEncoder().encode("{not json"))).toBe(false);
    // the signature covers the authenticator data: flags edited after signing fail the signature
    const signed = sign("es", authData({ flags: 0x01 }), good.cd);
    expect(await check(authData(), good.cd, { sig: signed })).toBe(false);
  });

  it("the parts: client data, the RP ID hash, the AAGUID at creation", async () => {
    expect(clientDataOk(clientData(), { type: "webauthn.get", challenge: bytes(32, 3), origin: ORIGIN })).toBe(true);
    expect(
      clientDataOk(clientData({ type: "webauthn.create" }), {
        type: "webauthn.create",
        challenge: bytes(32, 3),
        origin: ORIGIN,
      }),
    ).toBe(true);
    expect(await rpIdOk(parseAuthData(authData())!, ORIGIN)).toBe(true);
    expect(await rpIdOk(parseAuthData(authData())!, "abcdefghijklmnopabcdefghijklmnop")).toBe(false); // the id alone is not it
    expect(parseAuthData(new Uint8Array(36))).toBeNull();
    const aaguid = Uint8Array.from(Buffer.from("fbfc3007154e4ecc8c0b6e020557d7bd", "hex"));
    expect(parseAuthData(authData({ flags: 0x45, aaguid }))!.aaguid).toBe("fbfc3007154e4ecc8c0b6e020557d7bd");
    expect(parseAuthData(authData())!.aaguid).toBeUndefined(); // no AT flag: no attested data
  });

  it("DER → raw: node's signatures, integers padded or short, and every malformed form refused", async () => {
    // a round trip over r, s with leading zeros (short integers) and top bits set (a padding zero in DER)
    for (const raw of [
      bytes(64, 0x80),
      Uint8Array.from([0, 0, ...bytes(30, 5), 0, ...bytes(31, 0x90)]),
      Uint8Array.from([...bytes(32, 0xf0), 0, 0, 0, ...bytes(29, 1)]),
      new Uint8Array(randomBytes(64)),
    ])
      expect(derToRaw(rawToDer(raw))).toEqual(raw);
    for (let i = 0; i < 20; i++) {
      const ad = authData();
      const cd = clientData();
      expect(await signatureOk(spki(keys.es), -7, ad, cd, sign("es", ad, cd))).toBe(true);
    }
    const der = rawToDer(bytes(64, 0x10)); // 30 44 02 20 .. 02 20 ..
    const bad = [
      Uint8Array.from([0x31, ...der.slice(1)]), // not a SEQUENCE
      Uint8Array.from([...der, 0]), // something after it
      Uint8Array.from([0x30, der[1]! + 1, ...der.slice(2), 0]), // something after the two integers, inside the SEQUENCE
      Uint8Array.from([der[0]!, der[1]! + 1, ...der.slice(2)]), // a length that does not match
      Uint8Array.from([0x30, 0x81, 0x44, ...der.slice(2)]), // a long-form length
      Uint8Array.from([0x30, 0x44, 0x03, ...der.slice(3)]), // not an INTEGER
      Uint8Array.from([0x30, 0x45, 0x02, 0x21, 0x00, ...der.slice(4)]), // a leading zero that is not needed
      Uint8Array.from([0x30, 0x44, 0x02, 0x20, 0x80, ...der.slice(5)]), // a negative integer
      Uint8Array.from([0x30, 0x24, 0x02, 0x00, 0x02, 0x20, ...der.slice(4, 36)]), // an empty integer
      Uint8Array.from([0x30, 0x46, 0x02, 0x22, 0x00, 0x00, ...der.slice(4)]), // 34 bytes
      new Uint8Array(4),
    ];
    for (const b of bad) expect(derToRaw(b), Buffer.from(b).toString("hex").slice(0, 16)).toBeNull();
  });
});
