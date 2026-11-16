// A code typed in a Chinese IME's full-width mode (全角: ＡＢＣ１２３, the hyphen －, the ideographic space) reads as the
// same code (core/crypto/crockford.ts normalizeCrockford: NFKC first, as pin.ts reads a PIN). Every way a code is typed
// goes through it, and each is here: the recovery key to unlock, to reset the master password, to restore a cloud
// backup, to make shares from and in the sync flows; recovery code shares; the pairing code; and the settings page's
// code fields, which show what was typed the way it is read. A TOTP secret typed by hand reads the same way
// (core/totp/base32.ts cleanBase32). For both readings, every code point that read before reads the same after
// (REVIEW-P5P6-r4, D3 and D4: the reviewer's per-code-point check).
import { describe, expect, it } from "vitest";
import { makeCloudBackup } from "../../src/core/cloud/format";
import { openCloudBackups } from "../../src/core/cloud/restore";
import { CROCKFORD, normalizeCrockford } from "../../src/core/crypto/crockford";
import { unlockWithRecoveryCode } from "../../src/core/crypto/keyring";
import { generatePairingCode, parsePairingCode } from "../../src/core/crypto/pairing-code";
import { formatRecoveryCode, generateRecoveryCode, parseRecoveryCode } from "../../src/core/crypto/recovery-code";
import { makeShareSet, parseShare, recoveryCodeFromShares } from "../../src/core/crypto/shares";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { cleanBase32, decodeBase32, encodeBase32, normalizeBase32 } from "../../src/core/totp/base32";
import { parseOtpauth, serializeOtpauth } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import { VaultStore } from "../../src/core/storage/store";
import { recoveryProof } from "../../src/core/sync/crypto/auth-proofs";
import { codeSymbols } from "../../src/options/code-text";
import { fullLength } from "../../src/options/sync/recovery";
import { account, candidate, protectedKeys, seal, vaultOf } from "../helpers/cloud";
import { createProtected, resetWithCode, STRONG } from "../helpers/vaults";

/** As a Chinese IME's full-width mode types it: every ASCII character in its full-width form, spaces ideographic. */
const fullWidth = (s: string) =>
  s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, "　");
const T0 = 1_900_000_000_000;
/** "ok", or the code it was refused with (recovery_length, recovery_char, ...): a refusal fails an assertion. */
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e?.code ?? "threw",
  );

/**
 * Every code point, one at a time: none that read before (its reading all of `alphabet`, or nothing) reads differently
 * now; and strings of such characters read the same (random, 20,000). `before` is d2e3411's reading, verbatim.
 */
function readsAsBefore(after: (s: string) => string, before: (s: string) => string, alphabet: string, pool: string[]) {
  const valid = (s: string) => [...s].every((c) => alphabet.includes(c));
  const changed: string[] = [];
  let readBefore = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    const b = before(c);
    if (!valid(b)) continue;
    readBefore++;
    if (after(c) !== b)
      changed.push(`U+${cp.toString(16).toUpperCase()} ${JSON.stringify(b)} -> ${JSON.stringify(after(c))}`);
  }
  expect(changed).toEqual([]);
  expect(readBefore).toBeGreaterThan(90); // ASCII, the white space, and the few toUpperCase folds (ı, ſ, ß, ﬁ, ...)
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const differ: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => pool[Math.floor(rnd() * pool.length)]!).join("");
    if (after(s) !== before(s)) differ.push(JSON.stringify(s));
  }
  expect(differ).toEqual([]);
}
/** What read before besides ASCII: the white space, and the toUpperCase folds (ı, ſ, ß, ﬀ, ﬁ, ﬂ, ﬅ). */
const OLD_EXTRAS = ["\u00a0", "\u3000", "\u2009", "\u0131", "\u017f", "\u00df", "\ufb00", "\ufb01", "\ufb02", "\ufb05"];

describe("the reading every code shares (normalizeCrockford)", () => {
  it("every code point that read before reads the same now (NFKC changes no reading, only adds some)", () => {
    const before = (input: string) =>
      input
        .toUpperCase()
        .replace(/[\s\-_]/g, "")
        .replace(/O/g, "0")
        .replace(/[IL]/g, "1");
    const pool = [..."0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyzOoIiLl-_ \t", ...OLD_EXTRAS];
    readsAsBefore(normalizeCrockford, before, CROCKFORD, pool);
  });

  it("NFKC, not only the full-width block: the Roman numeral one, the script l, read as 1", async () => {
    expect(normalizeCrockford("\u2160")).toBe("1"); // Ⅰ
    expect(normalizeCrockford("\u2113")).toBe("1"); // ℓ
    let key = await generateRecoveryCode();
    while (!key.text.includes("1")) key = await generateRecoveryCode(); // one with a 1 in it, to type otherwise
    const { text, secret } = key;
    expect(await outcome(parseRecoveryCode(text.replace(/1/g, "\u2160")))).toBe("ok");
    expect(await parseRecoveryCode(text.replace(/1/g, "\u2113"))).toEqual(secret);
  });

  it("full-width letters, digits, hyphen and space read as their ASCII; the rest of the reading as before", () => {
    expect(normalizeCrockford("\u0131\u00df")).toBe("1SS"); // read before: as before
    expect(fullWidth("ab-c 1")).toBe("ａｂ－ｃ　１");
    expect(normalizeCrockford("ａｂ－ｃ　１")).toBe("ABC1");
    expect(normalizeCrockford(fullWidth("o0-iL_9z"))).toBe(normalizeCrockford("o0-iL_9z"));
    expect(normalizeCrockford(fullWidth("o0-iL_9z"))).toBe("0011" + "9Z");
    expect(normalizeCrockford("ＡＢＣ１２３")).toBe("ABC123");
  });
});

describe("the recovery key, typed full-width", () => {
  it("parses to the same secret, with or without its hyphens, in either case", async () => {
    const { text, secret } = await generateRecoveryCode();
    expect(await outcome(parseRecoveryCode(fullWidth(text)))).toBe("ok");
    expect(await parseRecoveryCode(fullWidth(text))).toEqual(secret);
    expect(await parseRecoveryCode(fullWidth(text.toLowerCase().replace(/-/g, " ")))).toEqual(secret);
  });

  it("unlock: the lock screen's recovery key opens the vault", async () => {
    const { svc, keyring, recoveryCode } = await protectedService();
    await svc.lock();
    expect(await outcome(svc.unlockWithRecoveryCode(fullWidth(recoveryCode)))).toBe("ok");
    expect((await svc.status()).state).toBe("unlocked");
    expect(await outcome(unlockWithRecoveryCode(keyring, fullWidth(recoveryCode)))).toBe("ok");
    expect((await unlockWithRecoveryCode(keyring, fullWidth(recoveryCode))).id).toBe(
      (await unlockWithRecoveryCode(keyring, recoveryCode)).id,
    );
  });

  it("reset: the master password set anew with it", async () => {
    const { svc, recoveryCode } = await protectedService();
    await svc.lock();
    const fresh = "brand-new-strong-passphrase-42";
    expect(await outcome(resetWithCode(svc, fullWidth(recoveryCode), fresh))).toBe("ok");
    await svc.lock();
    await svc.unlockWithPassword(fresh);
    expect((await svc.status()).state).toBe("unlocked");
  });

  it("restore: a cloud backup opened with it", async () => {
    const keys = await protectedKeys();
    const gen = await seal(keys, vaultOf(keys.keyring.vaultId, [account("GitHub", "JBSWY3DPEHPK3PXP")]), 3);
    const files = [candidate("A", await makeCloudBackup(gen, "both", "t"))];
    const opening = openCloudBackups(files, { recoveryKey: fullWidth(keys.recoveryCode) }, { now: T0, device: "d1" });
    expect(await outcome(opening)).toBe("ok");
    expect(await opening).toMatchObject({ needsPassword: true });
  });

  it("the sync flows: the same recovery proof as the code typed half-width", async () => {
    const { text } = await generateRecoveryCode();
    expect(await outcome(recoveryProof(fullWidth(text)))).toBe("ok");
    expect(await recoveryProof(fullWidth(text))).toEqual(await recoveryProof(text));
  });

  it("the settings page's code fields read it as the code (codeSymbols, the sync section's length check)", async () => {
    const { text } = await generateRecoveryCode();
    expect(codeSymbols(fullWidth(text))).toBe(codeSymbols(text));
    expect(fullLength(fullWidth(text))).toBe(true);
  });
});

describe("recovery code shares, typed full-width", () => {
  it("each share parses as typed half-width, and the shares rebuild the recovery key", async () => {
    const { secret, text } = await generateRecoveryCode();
    const set = await makeShareSet(secret.slice(), 2, 3);
    const share = set.shares[1]!;
    const a = await parseShare(share);
    expect(await outcome(parseShare(fullWidth(share)))).toBe("ok");
    const b = await parseShare(fullWidth(share));
    expect({ ...b, value: [...b.value] }).toEqual({ ...a, value: [...a.value] });
    const rebuilt = recoveryCodeFromShares([fullWidth(set.shares[0]!), fullWidth(set.shares[2]!)], formatRecoveryCode);
    expect(await outcome(rebuilt)).toBe("ok");
    expect(await rebuilt).toBe(text);
  });
});

describe("the pairing code, typed full-width", () => {
  it("parses to the same secret", async () => {
    const { text, secret } = await generatePairingCode();
    expect(await outcome(parsePairingCode(fullWidth(text)))).toBe("ok");
    expect(await parsePairingCode(fullWidth(text))).toEqual(secret);
    expect(fullLength(fullWidth(text))).toBe(true); // the join's field says it is whole
  });
});

/** A vault with a master password, as first run makes it; its recovery key and keyring. */
async function protectedService() {
  const kv = new MemoryKV();
  const store = new VaultStore({ lock: createMutex(), kv, now: () => T0 });
  const svc = new VaultService({
    store,
    session: new MemorySession(),
    settings: new KvSettingsStore(kv),
    now: () => T0,
  });
  const { recoveryCode } = await createProtected(svc, STRONG);
  const keyring = (await svc.currentGeneration())!.keyring;
  return { svc, keyring, recoveryCode };
}

describe("a TOTP secret typed by hand, full-width (core/totp/base32.ts; REVIEW-P5P6-r4, D4)", () => {
  const SECRET = "JBSWY3DPEHPK3PXP"; // RFC 4648's own alphabet: A-Z and 2-7
  /** "ok", or what it was refused with ("invalid base32 character"): a refusal fails an assertion. */
  const reads = (f: () => unknown) => {
    try {
      f();
      return "ok";
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("every code point that read before reads the same now; only its own alphabet's foldings are added", () => {
    const before = (input: string) => input.replace(/[\s\-=]/g, "").toUpperCase();
    const pool = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ234567abcdefghijklmnopqrstuvwxyz-= \t", ...OLD_EXTRAS];
    readsAsBefore(cleanBase32, before, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", pool);
    // 0, 1, 8 and 9 are not base32: full-width, they stay refused; the Roman numeral one and the script l are I and L
    for (const d of ["\uff10", "\uff11", "\uff18", "\uff19"])
      expect(() => normalizeBase32(`JBSW${d}`), d).toThrow("invalid base32 character");
    expect(cleanBase32("\u2160\u2113\uff12")).toBe("IL2");
  });

  it("decodes to the same key, spaced in groups of four as sites print it", () => {
    const typed = fullWidth("jbsw y3dp ehpk 3pxp");
    expect(reads(() => normalizeBase32(typed))).toBe("ok");
    expect(reads(() => decodeBase32(typed))).toBe("ok");
    expect(normalizeBase32(typed)).toBe(SECRET);
    expect(decodeBase32(typed)).toEqual(decodeBase32(SECRET));
    expect(encodeBase32(decodeBase32(typed))).toBe(SECRET);
  });

  it("the settings page's Add account by hand (an otpauth link made from the fields, read back): taken, stored canonical", () => {
    const fields = {
      type: "totp",
      issuer: "GitHub",
      label: "alice",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    } as const;
    let uri = "";
    expect(() => (uri = serializeOtpauth({ ...fields, secret: fullWidth(SECRET) }))).not.toThrow();
    const r = parseOtpauth(uri);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.secret).toBe(SECRET);
    // an otpauth link whose secret was typed full-width
    const typedLink = parseOtpauth(`otpauth://totp/GitHub:alice?secret=${encodeURIComponent(fullWidth(SECRET))}`);
    expect(typedLink.ok && typedLink.value.secret).toBe(SECRET);
  });

  it("a secret of nothing but padding and separators is missing, full-width as in ASCII (REVIEW-r5, E2)", () => {
    const why = (secret: string) => {
      const r = parseOtpauth(`otpauth://totp/GitHub:alice?secret=${encodeURIComponent(secret)}`);
      return r.ok ? "ok" : r.error;
    };
    for (const nothing of ["==", "- =", "\t"]) {
      expect(why(nothing), JSON.stringify(nothing)).toBe("missing_secret");
      expect(why(fullWidth(nothing)), JSON.stringify(fullWidth(nothing))).toBe("missing_secret");
    }
    expect(why("\u3000")).toBe("missing_secret"); // the ideographic space alone
    expect(why("\u207c\ufe66")).toBe("missing_secret"); // superscript and small "=": NFKC's "=" too
    // something left that base32 does not take is still invalid, as before
    expect(why("\uff10\uff11")).toBe("invalid_secret"); // full-width 0 and 1
    expect(why("01")).toBe("invalid_secret");
  });

  it("an account added with it keeps the canonical key", () => {
    const entry = { type: "totp", issuer: "GitHub", label: "alice", secret: fullWidth(SECRET) } as const;
    const add = () =>
      addEntry(emptyVault("v1"), { ...entry, algorithm: "SHA1", digits: 6, period: 30 }, createClock("aaaa"));
    expect(reads(add)).toBe("ok");
    expect(add().entry.secret).toBe(SECRET);
  });
});
