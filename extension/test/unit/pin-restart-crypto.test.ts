// The PIN after a restart's crypto and record (OWNER-DECISIONS/20; docs/design/notes/PIN-RESTART-NOTES.md §2): the wrap
// against an independent implementation (node:crypto: PBKDF2-SHA256 of pinKek, AES-256-GCM with the AAD), every field the
// AAD binds, tampering; the MAC (HKDF-SHA256 and HMAC-SHA256) and each field it binds; the full field check; the KDF's
// count, never below the master password's; the labels, apart from every other; what the record offers (restartState).
import { createCipheriv, createHash, createHmac, hkdfSync, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError } from "../../src/core/crypto/crypto-error";
import { PBKDF2_MIN_ITERATIONS, PBKDF2_PASSWORD_WRAP_ITERATIONS } from "../../src/core/crypto/kdf";
import { PIN_CFG_LABEL, PIN_TAG, QUICK_TRIES, type PinRecord } from "../../src/core/crypto/pin";
import { GATE_MAC_LABEL, GATE_TAG, PRF_KEK_LABEL, PRF_TAG } from "../../src/core/crypto/prf";
import { PRF_AHEAD_MS, PRF_PASSWORD_MS } from "../../src/core/crypto/prf-record";
import { parseRestart, restartState, type RestartRecord } from "../../src/core/crypto/pin-restart";
import {
  newRestartId,
  openRestart,
  RESTART_ITERATIONS,
  RESTART_MAC_LABEL,
  RESTART_MAC_TAG,
  RESTART_TAG,
  restartIterations,
  restartMac,
  restartMacOk,
  restartOk,
  sealRestart,
  type RestartHead,
} from "../../src/core/crypto/pin-restart-wrap";
import { vkFromRaw } from "../../src/core/crypto/vk";

const bytes = (n: number, from = 1) => Uint8Array.from({ length: n }, (_, i) => (from + i) & 0xff);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const IT = PBKDF2_MIN_ITERATIONS; // the tests' count (the floor); the shipped one is held below
const DAY = 86_400_000;
const head = (o: Partial<RestartHead> = {}): RestartHead => ({
  vaultId: "vault-id-0001",
  vkId: "0123456789abcdef",
  id: b64(bytes(16, 0x10)),
  setup: b64(bytes(16, 0x20)),
  wraps: "AAAA,BBBB",
  ...o,
});
const aadOf = (h: RestartHead) => `sixkey-pin-restart|1|${h.vaultId}|${h.vkId}|${h.id}|${h.setup}|${h.wraps}`;

/** The wrap as node:crypto makes it: PBKDF2-SHA256(pinKek, salt, it, 32) → AES-256-GCM(iv, vk, AAD). */
function nodeWrap(pinKek: Uint8Array, salt: Uint8Array, it: number, vk: Uint8Array, iv: Uint8Array, aad: string) {
  const kek = pbkdf2Sync(pinKek, salt, it, 32, "sha256");
  const c = createCipheriv("aes-256-gcm", kek, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([c.update(vk), c.final(), c.getAuthTag()]).toString("base64");
}
/** A fixed random source: salt (16) then IV (12), as sealRestart draws them. */
const fixed = (salt: Uint8Array, iv: Uint8Array) => {
  const q = [salt, iv];
  return (n: number) => {
    const b = q.shift()!;
    expect(b.length).toBe(n);
    return b;
  };
};

describe("the wrap (pin-restart-wrap.ts)", () => {
  it("is exactly PBKDF2-SHA256(pinKek, its own salt, the count) and AES-256-GCM with the AAD of PIN-RESTART-NOTES §2", async () => {
    expect(RESTART_TAG).toBe("sixkey-pin-restart|1|");
    const vk = bytes(32, 0x40);
    const pinKek = bytes(32, 0x60);
    const salt = bytes(16, 0x70);
    const iv = bytes(12, 0x90);
    const h = head();
    const w = await sealRestart(vk, h, pinKek, IT, fixed(salt, iv));
    expect(w.kdf).toEqual({ name: "PBKDF2", hash: "SHA-256", iterations: IT, salt: b64(salt), v: 1 });
    expect(w.iv).toBe(b64(iv));
    expect(w.wrapped).toBe(nodeWrap(pinKek, salt, IT, vk, iv, aadOf(h)));
    // and a wrap made by node opens
    const theirs = { ...w, wrapped: nodeWrap(pinKek, salt, IT, vk, iv, aadOf(h)) };
    expect(await openRestart(theirs, h, pinKek)).toEqual(vk);
  });

  it("a known answer (pinned bytes): the KDF, the salt's use and the AAD cannot change unnoticed", async () => {
    const z = (n: number) => new Uint8Array(n);
    const h = head({ id: b64(z(16)), setup: b64(z(16)), wraps: "AAAA" });
    const w = await sealRestart(z(32), h, z(32), IT, fixed(z(16), z(12)));
    expect(createHash("sha256").update(w.wrapped).digest("hex").slice(0, 16)).toBe("341cb5e11a34da12");
  });

  it("does not open with another pinKek, or any field the AAD binds changed: vault, key, record, PIN set-up, wraps", async () => {
    const vk = new Uint8Array(randomBytes(32));
    const pinKek = new Uint8Array(randomBytes(32));
    const h = head();
    const w = await sealRestart(vk, h, pinKek, IT);
    expect(await openRestart(w, h, pinKek)).toEqual(vk);
    const fails = (p: Promise<unknown>) => expect(p).rejects.toEqual(new CryptoError("unwrap_failed"));
    await fails(openRestart(w, h, new Uint8Array(randomBytes(32))));
    await fails(openRestart(w, { ...h, vaultId: "vault-id-0002" }, pinKek));
    await fails(openRestart(w, { ...h, vkId: "0123456789abcdee" }, pinKek));
    await fails(openRestart(w, { ...h, id: b64(bytes(16, 0x11)) }, pinKek));
    await fails(openRestart(w, { ...h, setup: b64(bytes(16, 0x21)) }, pinKek));
    await fails(openRestart(w, { ...h, wraps: "AAAA,BBBC" }, pinKek));
  });

  it("does not open when its own bytes are changed: the IV, the ciphertext, the salt, the count", async () => {
    const vk = new Uint8Array(randomBytes(32));
    const pinKek = new Uint8Array(randomBytes(32));
    const h = head();
    const w = await sealRestart(vk, h, pinKek, IT);
    const flip = (s: string) => {
      const b = Buffer.from(s, "base64");
      b[0] = b[0]! ^ 1;
      return b.toString("base64");
    };
    const fails = (p: Promise<unknown>) => expect(p).rejects.toEqual(new CryptoError("unwrap_failed"));
    await fails(openRestart({ ...w, iv: flip(w.iv) }, h, pinKek));
    await fails(openRestart({ ...w, wrapped: flip(w.wrapped) }, h, pinKek));
    await fails(openRestart({ ...w, kdf: { ...w.kdf, salt: flip(w.kdf.salt) } }, h, pinKek));
    await fails(openRestart({ ...w, kdf: { ...w.kdf, iterations: IT + 1 } }, h, pinKek));
    // a count below kdf.ts's floor is not even derived
    await fails(openRestart({ ...w, kdf: { ...w.kdf, iterations: IT - 1 } }, h, pinKek));
  });

  it("each wrap has a salt and an IV of its own; the record id is 16 fresh bytes", async () => {
    const vk = new Uint8Array(randomBytes(32));
    const pinKek = new Uint8Array(randomBytes(32));
    const a = await sealRestart(vk, head(), pinKek, IT);
    const b = await sealRestart(vk, head(), pinKek, IT);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(Buffer.from(a.kdf.salt, "base64")).toHaveLength(16);
    expect(Buffer.from(newRestartId(), "base64")).toHaveLength(16);
    expect(newRestartId()).not.toBe(newRestartId());
  });
});

describe("the KDF's count: the master password's, never weaker", () => {
  it("a new wrap gets the count of a new master-password wrap (kdf.ts), at least the read floor", () => {
    expect(RESTART_ITERATIONS).toBe(PBKDF2_PASSWORD_WRAP_ITERATIONS);
    expect(RESTART_ITERATIONS).toBeGreaterThanOrEqual(2_000_000);
    expect(RESTART_ITERATIONS).toBeGreaterThan(PBKDF2_MIN_ITERATIONS);
    expect(restartIterations(undefined, { wraps: [] })).toBe(PBKDF2_PASSWORD_WRAP_ITERATIONS);
  });

  it("and never fewer than any password wrap of this keyring carries; another wrap's KDF does not count", () => {
    const pw = (it: number) => ({ method: "password", kdf: { iterations: it } });
    expect(restartIterations(undefined, { wraps: [pw(600_000)] })).toBe(2_000_000);
    expect(restartIterations(undefined, { wraps: [pw(3_000_000)] })).toBe(3_000_000);
    expect(restartIterations(undefined, { wraps: [{ method: "recovery", kdf: { iterations: 9_000_000 } }] })).toBe(
      2_000_000,
    );
    // the tests' hook, with the tests' keyrings (600k): the floor
    expect(restartIterations(600_000, { wraps: [pw(600_000)] })).toBe(600_000);
    expect(restartIterations(600_000, { wraps: [pw(700_000)] })).toBe(700_000);
  });
});

describe("the MAC: Sixkey's own record for this vault key", () => {
  it("is exactly HMAC-SHA256(HKDF-SHA256(vault key, empty salt, its label), its tag and the bound fields)", async () => {
    expect(RESTART_MAC_LABEL).toBe("sixkey/v1/pin-restart-mac");
    expect(RESTART_MAC_TAG).toBe("sixkey-pin-restart-mac|1|");
    const vk = bytes(32, 0x40);
    const h = head();
    const key = Buffer.from(hkdfSync("sha256", vk, Buffer.alloc(0), "sixkey/v1/pin-restart-mac", 32));
    const want = createHmac("sha256", key)
      .update(`sixkey-pin-restart-mac|1|${h.vaultId}|${h.vkId}|${h.id}|${h.setup}|${h.wraps}`)
      .digest("base64");
    expect(await restartMac(vk, h)).toBe(want);
    expect(await restartMacOk(vk, h, want)).toBe(true);
  });

  it("refuses another vault key, any bound field changed, an edited or malformed tag", async () => {
    const vk = new Uint8Array(randomBytes(32));
    const h = head();
    const mac = await restartMac(vk, h);
    expect(await restartMacOk(new Uint8Array(randomBytes(32)), h, mac)).toBe(false);
    for (const o of [
      { vaultId: "vault-id-0002" },
      { vkId: "0123456789abcdee" },
      { id: b64(bytes(16, 0x11)) },
      { setup: b64(bytes(16, 0x21)) },
      { wraps: "AAAA" },
    ])
      expect(await restartMacOk(vk, { ...h, ...o }, mac), JSON.stringify(o)).toBe(false);
    const b = Buffer.from(mac, "base64");
    b[5] = b[5]! ^ 1;
    expect(await restartMacOk(vk, h, b.toString("base64"))).toBe(false);
    expect(await restartMacOk(vk, h, "not base64!")).toBe(false);
  });
});

describe("the labels are this record's own", () => {
  it("distinct from the PRF's, the gate's, the PIN set-up's, the old session PIN's and the vault key's, and none a prefix of another", () => {
    const all = [
      RESTART_TAG,
      RESTART_MAC_LABEL,
      RESTART_MAC_TAG,
      PRF_KEK_LABEL,
      PRF_TAG,
      GATE_MAC_LABEL,
      GATE_TAG,
      PIN_CFG_LABEL,
      PIN_TAG,
      "sixkey-quick|1|", // the session PIN's, retired on 2026-10-30: never reused
      "sixkey/v1/vault-enc",
      "sixkey/v1/vk-id",
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const a of all) for (const b of all) if (a !== b) expect(b.startsWith(a), `${a} / ${b}`).toBe(false);
  });
});

/** A whole record, every field as the admin and the steps write it. */
async function whole(o: Partial<RestartRecord> = {}): Promise<RestartRecord> {
  const h = head();
  const wrap = await sealRestart(bytes(32, 0x40), h, bytes(32, 0x60), IT);
  return { v: 1, ...h, mac: b64(bytes(32)), lastPasswordAt: 1_700_000_000_000, fails: 0, wrap, ...o };
}

describe("the full field check (restartOk)", () => {
  it("takes a whole record, with a wrap or with it set aside", async () => {
    expect(restartOk(await whole())).toBe(true);
    expect(restartOk(await whole({ wrap: null }))).toBe(true);
    expect(restartOk(await whole({ fails: QUICK_TRIES }))).toBe(true);
  });

  it("refuses each field out of shape, a field it does not know, a count out of kdf.ts's range", async () => {
    const w = await whole();
    const bad: Record<string, unknown>[] = [
      { v: 2 },
      { id: b64(bytes(15)) },
      { vaultId: "x" },
      { vkId: "0123456789ABCDEF" },
      { setup: b64(bytes(8)) },
      { wraps: "" },
      { wraps: "a|b" },
      { mac: b64(bytes(31)) },
      { lastPasswordAt: -1 },
      { lastPasswordAt: 1.5 },
      { fails: -1 },
      { fails: QUICK_TRIES + 1 },
      { wrap: undefined },
      { wrap: { ...w.wrap, extra: 1 } },
      { wrap: { ...w.wrap!, iv: b64(bytes(16)) } },
      { wrap: { ...w.wrap!, wrapped: b64(bytes(32)) } },
      { wrap: { ...w.wrap!, kdf: { ...w.wrap!.kdf, iterations: PBKDF2_MIN_ITERATIONS - 1 } } },
      { wrap: { ...w.wrap!, kdf: { ...w.wrap!.kdf, iterations: 20_000_001 } } },
      { wrap: { ...w.wrap!, kdf: { ...w.wrap!.kdf, hash: "SHA-1" } } },
      { wrap: { ...w.wrap!, kdf: { ...w.wrap!.kdf, salt: b64(bytes(8)) } } },
      { session: "pin" },
    ];
    for (const o of bad) expect(restartOk({ ...w, ...o }), JSON.stringify(Object.keys(o))).toBe(false);
    expect(restartOk(null)).toBe(false);
    expect(restartOk("record")).toBe(false);
  });
});

const KEYRING = {
  vaultId: "vault-id-0001",
  vkId: "0123456789abcdef",
  wraps: [{ wrapped: "AAAA" }, { wrapped: "BBBB" }],
};
const PIN_SET = {
  vaultId: "vault-id-0001",
  vkId: "0123456789abcdef",
  kdf: { salt: b64(bytes(16, 0x20)) },
} as PinRecord;
const NOW = 1_700_000_000_000;

describe("what the PIN offers (pin-restart.ts restartState)", () => {
  it("the shape the popup reads: none, damaged, a record", async () => {
    expect(parseRestart(undefined)).toBeNull();
    expect(parseRestart(null)).toBeNull();
    expect(parseRestart({ v: 1 })).toBe("damaged");
    expect(parseRestart("x")).toBe("damaged");
    const w = await whole();
    expect(parseRestart(w)).toEqual(w);
  });

  it("nothing: a shared profile, no PIN set up for this vault and key (whatever the record)", async () => {
    const r = await whole();
    expect(restartState(r, KEYRING, PIN_SET, false)).toBe("pin");
    for (const x of [r, null, undefined, "damaged"]) {
      expect(restartState(x, KEYRING, PIN_SET, true)).toBeNull();
      expect(restartState(x, KEYRING, null, false)).toBeNull();
      expect(restartState(x, KEYRING, "damaged", false)).toBeNull();
      expect(restartState(x, KEYRING, { ...PIN_SET, vkId: "fedcba9876543210" }, false)).toBeNull();
      expect(restartState(x, KEYRING, { ...PIN_SET, vaultId: "vault-id-0002" }, false)).toBeNull();
    }
  });

  it("wait, with a PIN set up: no record (a PIN set before 2026-10-30), one not even shaped like one, another vault's", async () => {
    const r = await whole();
    for (const x of [null, undefined, "damaged", { v: 2 }, { ...r, vaultId: "vault-id-0002" }])
      expect(restartState(x, KEYRING, PIN_SET, false), JSON.stringify(x)).toBe("wait");
  });

  it("paused: another vault key, another set of wraps (any re-wrap), another PIN set-up", async () => {
    const r = await whole();
    expect(restartState({ ...r, vkId: "fedcba9876543210" }, KEYRING, PIN_SET, false)).toBe("paused");
    expect(restartState({ ...r, wraps: "AAAA,CCCC" }, KEYRING, PIN_SET, false)).toBe("paused");
    expect(restartState({ ...r, setup: b64(bytes(16, 0x21)) }, KEYRING, PIN_SET, false)).toBe("paused");
    expect(restartState({ ...r, vkId: "fedcba9876543210", wrap: null }, KEYRING, PIN_SET, false)).toBe("paused");
  });

  it("wait: its wrap set aside, its tries spent; no time is looked at (no 14 days, OWNER-DECISIONS/20, 2026-10-30)", async () => {
    const r = await whole();
    expect(restartState({ ...r, wrap: null }, KEYRING, PIN_SET, false)).toBe("wait");
    expect(restartState({ ...r, fails: QUICK_TRIES }, KEYRING, PIN_SET, false)).toBe("wait");
    expect(restartState({ ...r, fails: QUICK_TRIES - 1 }, KEYRING, PIN_SET, false)).toBe("pin");
    for (const at of [0, NOW - 365 * DAY, NOW - PRF_PASSWORD_MS - 1, NOW + PRF_AHEAD_MS + DAY])
      expect(restartState({ ...r, lastPasswordAt: at }, KEYRING, PIN_SET, false), `${at}`).toBe("pin");
  });

  it("the PIN's length is not looked at: a set-up of 4 to 8 digits offers alike (OWNER-DECISIONS/20, 2026-10-30)", async () => {
    const r = await whole();
    expect(parseRestart(r)).toEqual(r); // the record has no length of its own: the same shape for every PIN
    expect(restartOk(r)).toBe(true);
    for (const digits of [4, 5, 6, 7, 8]) {
      const set = { ...PIN_SET, digits } as PinRecord;
      expect(restartState(r, KEYRING, set, false), `${digits}`).toBe("pin");
      expect(restartState({ ...r, wrap: null }, KEYRING, set, false), `${digits}`).toBe("wait");
      expect(restartState({ ...r, vkId: "fedcba9876543210" }, KEYRING, set, false), `${digits}`).toBe("paused");
    }
  });

  it("the restated constants agree with their sources: the tries", () => {
    expect(QUICK_TRIES).toBe(5);
  });
});
