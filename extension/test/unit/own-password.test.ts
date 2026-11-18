// The master password is the user's own (OWNER-DECISIONS/15; docs/design/notes/OWN-PASSWORD-NOTES.md):
//   §1 below 50 bits is a warning with "Use anyway" (masterAccepts, meterView's own mode), the service's floor still blocks,
//      generated passwords are handled as before, backup files keep the bar;
//   §2 new master-password wraps at PBKDF2_PASSWORD_WRAP_ITERATIONS; a 600k wrap still opens and is re-wrapped only by the
//      next password change, never by an unlock; the PIN and backup files keep 600k (the server sync's engine, which
//      kept it too, went with its client: OWNER-DECISIONS/25, DV-0b);
//   §3 the lock screen's line for a PIN that needs the master password once: its conditions, never in a shared profile,
//      and no read more than before.
// The page's own wiring (the warning, the toggle, the order) is own-password-dom.test.ts's; the browser's is
// test/e2e/own-password.spec.ts's.
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackup } from "../../src/core/backup/backup";
import {
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  PBKDF2_PASSWORD_WRAP_ITERATIONS,
  newPbkdf2Params,
} from "../../src/core/crypto/kdf";
import { createKeyring, rekey, setPassword, unlockWithPassword, type Keyring } from "../../src/core/crypto/keyring";
import { checkPasswordPolicy } from "../../src/core/crypto/password-policy";
import { PinAdmin } from "../../src/core/service/pin-admin";
import { pinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { notePassword as pinStepsNote, unlock as pinStepsUnlock } from "../../src/core/service/pin-restart-steps";
import { ServiceError } from "../../src/core/service/service-error";
import { VaultService } from "../../src/core/service/service";
import { emptyVault } from "../../src/core/vault/model";
import { createRuntime } from "../../src/platform/runtime";
import { buildRuntime, createPopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen } from "../../src/popup/load";
import {
  GPU_ITERATIONS_PER_SECOND,
  masterAccepts,
  MIN_GUESS_BITS,
  measure,
  meterView,
  MIN_BITS,
  offlineSeconds,
  roughTime,
  suggestPassphrase,
  suggestPassword,
  type Strength,
} from "../../src/ui/strength";
import { codeOf, legacyDeviceVault, NO_PAGE, resetWithCode, STRONG } from "../helpers/vaults";

const SRC = join(__dirname, "../../src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** The owner's own attempt at the 50-bit bar (OWNER-DECISIONS/15): 13 characters, about 34 bits. Passes the floor. */
const OWN = "JennyLovesTea";
const PIN = "246813";

function area() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, keys: [] as string[][], sets: [] as string[][] };
  const a = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(ks);
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      c.sets.push(Object.keys(items));
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
  return { data, c, area: a as unknown as chrome.storage.StorageArea };
}

/** A profile: its two storage areas, and runtimes over them as each kind of page builds one. */
function profile() {
  const local = area();
  const session = area();
  const o = { local: local.area, session: session.area, mirror: null };
  return {
    local,
    session,
    page: () => createRuntime(o),
    popup: () => createPopupRuntime(o),
    /** A runtime as a version before OWNER-DECISIONS/15 built it: its new wraps at 600k (the test hook). */
    older: () => buildRuntime(o, (deps) => new VaultService({ ...deps, kdfIterations: 600_000 })),
    zero() {
      for (const x of [local.c, session.c]) {
        x.gets = 0;
        x.keys = [];
        x.sets = [];
      }
    },
  };
}
type Profile = ReturnType<typeof profile>;

async function keyringOf(p: Profile): Promise<Keyring> {
  const r = await p.page().store.load();
  if (r.status !== "ok") throw new Error(r.status);
  return r.gen.keyring;
}
const wrapIterations = (k: Keyring) => {
  const w = k.wraps.find((x) => x.method === "password");
  return w?.kdf?.name === "PBKDF2" ? w.kdf.iterations : null;
};
const opens = (k: Keyring, pw: string) =>
  unlockWithPassword(k, pw).then(
    () => true,
    () => false,
  );

afterEach(() => vi.useRealTimers());

describe("§1 below 50 bits: a warning and 'Use anyway', never the floor", () => {
  const S = (bits: number, floorOk = true, generated = false): Strength => ({
    bits,
    floorOk,
    generated,
    ok: floorOk && bits >= MIN_BITS,
  });

  it("masterAccepts: the floor and 10^6 guesses always; MIN_BITS or 'Use anyway'", () => {
    expect(MIN_GUESS_BITS).toBe(Math.log2(1e6)); // OWNER-DECISIONS/15 item 1: "少于 10⁶ 次猜测"
    expect(masterAccepts(null, true)).toBe(false);
    expect(masterAccepts(S(34), false)).toBe(false);
    expect(masterAccepts(S(34), true)).toBe(true);
    expect(masterAccepts(S(64), false)).toBe(true);
    expect(masterAccepts(S(70, false), true)).toBe(false); // refused by the floor, whatever was pressed
    expect(masterAccepts(S(20, false), true)).toBe(false);
    expect(masterAccepts(S(13.9), true)).toBe(false); // Password1234: under 10^6 guesses, "Use anyway" or not
    expect(masterAccepts(S(Math.log2(1e6) - 1e-9), true)).toBe(false);
    expect(masterAccepts(S(Math.log2(1e6)), true)).toBe(true);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.boolean(), fc.boolean(), (bits, floorOk, anyway) => {
        const s = S(bits, floorOk);
        expect(masterAccepts(s, anyway)).toBe(floorOk && bits >= MIN_GUESS_BITS && (bits >= MIN_BITS || anyway));
        if (!anyway) expect(masterAccepts(s, false)).toBe(s.ok); // without the press: exactly the old bar
      }),
    );
  });

  it("too easy to guess, refused outright: the reviewer's common passwords, under 10^6 guesses; above it, the warning", async () => {
    // OWNER-DECISIONS/15 item 1; the independent review's floor probe (F1)
    for (const pw of ["Password1234", "password1234", "Passw0rd1234", "Football1234", "Iloveyou2024", "Password123!"]) {
      expect(checkPasswordPolicy(pw).ok, pw).toBe(true); // the service's short list lets them through
      const s = await measure(pw);
      expect(s.bits, pw).toBeLessThan(MIN_GUESS_BITS);
      expect(masterAccepts(s, true), pw).toBe(false);
      expect(meterView(pw, s, true), pw).toMatchObject({ msg: { key: "strengthCommon" }, warn: false, offer: true });
    }
    for (const pw of ["Letmein2024!", "Summer2024!!", OWN]) {
      const s = await measure(pw);
      expect(s.bits, pw).toBeGreaterThanOrEqual(MIN_GUESS_BITS);
      expect(masterAccepts(s, false), pw).toBe(false);
      expect(masterAccepts(s, true), pw).toBe(true);
      expect(meterView(pw, s, true), pw).toMatchObject({ msg: { key: "strengthLowOwn" }, warn: true });
    }
  });

  it("the owner's 13-character password, about 34 bits: past the floor, below the bar, accepted only with 'Use anyway'", async () => {
    expect(OWN).toHaveLength(13);
    expect(checkPasswordPolicy(OWN)).toEqual({ ok: true, reasons: [] });
    const s = await measure(OWN);
    expect(s).toMatchObject({ floorOk: true, ok: false, generated: false });
    expect(s.bits).toBeGreaterThan(30);
    expect(s.bits).toBeLessThan(40);
    expect(masterAccepts(s, false)).toBe(false);
    expect(masterAccepts(s, true)).toBe(true);
    expect(meterView(OWN, s, true)).toEqual({
      on: Math.floor((s.bits / MIN_BITS) * 10),
      tone: "fair",
      msg: { key: "strengthLowOwn", subs: [Math.floor(s.bits), 50] },
      offer: true,
      warn: true,
    });
  });

  it("the floor still blocks, with 'Use anyway' too: too short, repeats, a sequence, a common password", async () => {
    const cases: [string, string][] = [
      ["Jenny2Loves", "too_short"], // 11 characters
      ["abababababab", "too_repetitive"],
      ["abcdefghijklmn", "sequence"],
      ["qwertyuiop12", "common"],
    ];
    for (const [pw, reason] of cases) {
      expect(checkPasswordPolicy(pw).reasons, pw).toContain(reason);
      const s = await measure(pw);
      expect(s.floorOk, pw).toBe(false);
      expect(masterAccepts(s, true), pw).toBe(false);
      const v = meterView(pw, s, true);
      expect(v.warn, pw).toBe(false); // no warning, so no "Use anyway"
      expect(v.msg.key, pw).toBe(reason === "too_short" ? "strengthShort" : "strengthFloor");
    }
    expect(meterView("Jenny2Loves", await measure("Jenny2Loves"), true).msg).toEqual({
      key: "strengthShort",
      subs: [12],
    });
  });

  it("the service refuses what the floor refuses at every place a master password is set, and takes the owner's", async () => {
    const p = profile();
    const svc = p.page().service;
    await expect(svc.prepareKeys("Jenny2Loves")).rejects.toMatchObject({ code: "weak_password" });
    const keys = await svc.prepareKeys(OWN); // no 50-bit rule in the service: never was, and none now
    await svc.create(keys);
    await expect(svc.changePassword(OWN, "Jenny2Loves")).rejects.toMatchObject({ code: "weak_password" });
    await expect(svc.prepareReset(keys.recoveryCode, "abababababab")).rejects.toMatchObject({ code: "weak_password" });
    await svc.changePassword(OWN, "Rosegarden99!"); // about 31 bits: the page's warning, the service's floor only
    const legacy = profile();
    await legacyDeviceVault(legacy.page().store);
    await expect(legacy.page().service.enableMasterPassword("qwertyuiop12", NO_PAGE)).rejects.toBeInstanceOf(
      ServiceError,
    );
    await legacy.page().service.enableMasterPassword(OWN, NO_PAGE);
    expect(await opens(await keyringOf(legacy), OWN)).toBe(true);
  });

  it("meterView's own mode: every bar exactly at the bar; the warning exactly past the floor and below it", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 200, noNaN: true }), fc.boolean(), fc.boolean(), (bits, floorOk, gen) => {
        const s = S(bits, floorOk, gen);
        const v = meterView("JennyLovesTea", s, true);
        expect(v.on === 10).toBe(s.ok);
        expect(v.warn).toBe(floorOk && !s.ok && bits >= MIN_GUESS_BITS);
        expect(v.offer).toBe(!s.ok);
        expect(v.tone === "good").toBe(s.ok);
        if (floorOk && bits < MIN_GUESS_BITS) expect(v.msg.key).toBe("strengthCommon");
      }),
    );
    expect(meterView("", null, true)).toEqual({
      on: 0,
      tone: "",
      msg: { key: "strengthHintOwn", subs: [12, 50] },
      offer: false,
      warn: false,
    });
  });

  it("generated passwords are unchanged: their known bits, accepted without a press, the same line on every page", async () => {
    for (const g of [suggestPassword(), await suggestPassphrase()]) {
      const s = await measure(g.value);
      expect(s).toMatchObject({ ok: true, floorOk: true, generated: true, bits: g.bits });
      expect(masterAccepts(s, false)).toBe(true);
      expect(meterView(g.value, s, true)).toEqual(meterView(g.value, s));
      expect(meterView(g.value, s, true)).toMatchObject({ on: 10, warn: false, msg: { key: "strengthGenerated" } });
    }
  });

  it("the warning's figure: 2^bits guesses at the new wraps' count, on one RTX 5090 (not halved)", () => {
    expect(GPU_ITERATIONS_PER_SECOND).toBe(1.1e10);
    expect(offlineSeconds(34)).toBeCloseTo((2 ** 34 * 2_000_000) / 1.1e10, 3);
    expect(offlineSeconds(34, 600_000) * (2_000_000 / 600_000)).toBeCloseTo(offlineSeconds(34), 3);
    const day = 86_400;
    expect(offlineSeconds(34) / day).toBeGreaterThan(30); // the owner's: about 36 days on one card
    expect(offlineSeconds(34) / day).toBeLessThan(40);
    expect(roughTime(offlineSeconds(34))).toEqual({ unit: "day", count: 36 });
    expect(roughTime(5)).toEqual({ unit: "second", count: 5 });
    expect(roughTime(2.7)).toEqual({ unit: "second", count: 3 }); // Password1234 at 2M (refused now, but said right)
    expect(roughTime(0.2)).toEqual({ unit: "second", count: 1 });
    expect(roughTime(90)).toEqual({ unit: "second", count: 90 });
    expect(roughTime(91)).toEqual({ unit: "minute", count: 2 });
    expect(roughTime(90 * 60)).toEqual({ unit: "minute", count: 90 });
    expect(roughTime(3 * 3_600)).toEqual({ unit: "hour", count: 3 });
    expect(roughTime(45 * day)).toEqual({ unit: "day", count: 45 });
    expect(roughTime(200 * day)).toEqual({ unit: "month", count: 7 });
    expect(roughTime(3_247 * 365.25 * day)).toEqual({ unit: "year", count: 3_200 });
    expect(roughTime(offlineSeconds(49.99))).toMatchObject({ unit: "year" });
    // never less than one of a unit, and the unit grows with the time
    const order = ["second", "minute", "hour", "day", "month", "year"];
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        fc.double({ min: 1, max: 1e12, noNaN: true }),
        (a, b) => {
          const [x, y] = [roughTime(Math.min(a, b)), roughTime(Math.max(a, b))];
          expect(x.count).toBeGreaterThanOrEqual(1);
          expect(order.indexOf(x.unit)).toBeLessThanOrEqual(order.indexOf(y.unit));
        },
      ),
    );
  });

  it("every call that sets a master password is gated by masterAccepts just before it, and there is no other", () => {
    // the service's methods that take a new master password, and which argument it is (OWNER-DECISIONS/15: the page
    // enforces the guess floor and the 50-bit warning, the service only checkPasswordPolicy)
    const SETS: Record<string, number> = {
      prepareKeys: 0,
      enableMasterPassword: 0,
      changePassword: 1,
      prepareReset: 1,
      // a cloud restore's keys (CLOUDBK patch 5): a new master password when given one ({ newPassword }); the typed one
      // ({ typed }) opened the restored wrap and sets nothing
      prepareRestoredKeys: 2,
    };
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const callers: string[] = [];
    for (const f of walk(".").map((x) => x.slice(2))) {
      const text = read(f);
      // a method call on anything (rt.service, a destructured service, this.s): never the service's own definitions
      for (const m of text.matchAll(
        /\.(prepareKeys|enableMasterPassword|changePassword|prepareReset|prepareRestoredKeys)\(/g,
      )) {
        const at = m.index!;
        let depth = 0;
        let end = at + m[0].length;
        for (; end < text.length; end++) {
          if (text[end] === "(" || text[end] === "{") depth++;
          else if (text[end] === "}") depth--;
          else if (text[end] === ")") {
            if (depth === 0) break;
            depth--;
          }
        }
        const args: string[] = [];
        let cur = "";
        depth = 0;
        for (const ch of text.slice(at + m[0].length, end)) {
          if (ch === "(" || ch === "{") depth++;
          if (ch === ")" || ch === "}") depth--;
          if (ch === "," && depth === 0) {
            args.push(cur.trim());
            cur = "";
          } else cur += ch;
        }
        args.push(cur.trim());
        let pw = args[SETS[m[1]!]!]!;
        if (m[1] === "prepareRestoredKeys") {
          const n = /^\{ newPassword: (\w+) \}$/.exec(pw);
          if (!n) continue; // { typed }: no new password
          pw = n[1]!;
        }
        callers.push(`${f} ${m[1]}(${pw})`);
        const before = text.slice(Math.max(0, at - 400), at);
        const gate = new RegExp(
          `if \\(!masterAccepts\\(await measure\\(${pw}\\), [^;]*\\)\\) throw new ServiceError\\("weak_password"\\);\\s*(?:const \\w+ = |setPending\\()?await [\\w.]+\\.${m[1]}\\($`,
        );
        expect(before + text.slice(at, at + m[0].length), `${f}: ${m[1]}`).toMatch(gate);
      }
    }
    expect(callers.sort()).toEqual([
      "options/FirstRun.tsx prepareKeys(pw)",
      "options/FirstRun.tsx prepareRestoredKeys(pw)",
      "options/Reset.tsx prepareReset(pw)",
      "options/csb/CsbFirstRun.tsx changePassword(pw)",
      "options/key-ops.ts changePassword(pw)",
      "options/key-ops.ts enableMasterPassword(pw)",
    ]);
  });

  it("backup files keep the bar: no 'Use anyway' reaches them", () => {
    const backup = read("options/Backup.tsx");
    expect(backup).not.toMatch(/anyway|masterAccepts/);
    expect(backup.match(/if \(!\(await measure\((pw|subPw)\)\)\.ok\) throw/g)).toHaveLength(2);
    // (the Sync section's key operations, which kept it too, are gone from every build with the server sync's client:
    // OWNER-DECISIONS/25, DV-0b) the service-level floor stays where it was
    expect(read("core/backup/backup.ts")).toMatch(/if \(!checkPasswordPolicy\(password\)\.ok\) throw new BackupError/);
  });
});

describe("§2 new master-password wraps at the new count; older ones still open; the rest at 600k", () => {
  it("the counts: the new one within the read-time range; the default (PIN, backup files) unchanged", () => {
    expect(PBKDF2_PASSWORD_WRAP_ITERATIONS).toBe(2_000_000);
    expect(PBKDF2_DEFAULT_ITERATIONS).toBe(600_000);
    expect(PBKDF2_MIN_ITERATIONS).toBe(600_000);
    expect(PBKDF2_MAX_ITERATIONS).toBe(20_000_000);
    expect(PBKDF2_PASSWORD_WRAP_ITERATIONS).toBeGreaterThan(PBKDF2_MIN_ITERATIONS);
    expect(PBKDF2_PASSWORD_WRAP_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
    expect(newPbkdf2Params().iterations).toBe(600_000);
  });

  it("a new vault, a restore's keys, the reset, turning the password on and a rotation: the password wrap at 2M", async () => {
    const p = profile();
    const svc = p.page().service;
    const keys = await svc.prepareKeys(OWN);
    await svc.create(keys);
    const k1 = await keyringOf(p);
    expect(wrapIterations(k1)).toBe(2_000_000);
    expect(k1.wraps.find((w) => w.method === "recovery")!.kdf!.name).toBe("HKDF"); // the recovery key's wrap: as it was
    const code = await codeOf((d) => svc.rotateKey(OWN, d));
    expect(wrapIterations(await keyringOf(p))).toBe(2_000_000);
    await resetWithCode(svc, code, "Rosegarden99!");
    const k2 = await keyringOf(p);
    expect(wrapIterations(k2)).toBe(2_000_000);
    expect(await opens(k2, "Rosegarden99!")).toBe(true);
    const legacy = profile();
    await legacyDeviceVault(legacy.page().store);
    await legacy.page().service.enableMasterPassword(OWN, NO_PAGE);
    expect(wrapIterations(await keyringOf(legacy))).toBe(2_000_000);
  });

  it("a 600k wrap from before still opens, everywhere, and an unlock never re-wraps it; the next change does, at 2M", async () => {
    const p = profile();
    const old = p.older().service;
    await old.create(await old.prepareKeys(OWN));
    await new PinAdmin(old).setPin(OWN, PIN);
    const before = await keyringOf(p);
    expect(wrapIterations(before)).toBe(600_000);
    await old.lock();
    // this version: the lock screen, the settings page's checks, the PIN box: all open it, and nothing is re-wrapped
    p.zero();
    const popup = p.popup();
    expect((await loadScreen(popup)).k).toBe("locked");
    await popup.service.unlockWithPassword(OWN);
    // the lock screen's note: the PIN's record, made at the older count, made again at this version's (PINR-02)
    await pinStepsNote(popup.service, pinKit);
    const page = p.page().service;
    await page.verifyPassword(OWN);
    await page.lock();
    const r = await pinStepsUnlock(p.popup().service, PIN, pinKit);
    expect(r.ok).toBe(true);
    const after = await keyringOf(p);
    expect(after).toEqual(before); // byte for byte: no side write on an unlock
    expect(p.local.c.sets.flat().filter((k) => /^sk_(slot|keyring|active|ptr)/.test(k))).toEqual([]);
    // the next password change re-wraps, at 2M, the old password no longer opens, the new one does
    await page.changePassword(OWN, "Rosegarden99!");
    const changed = await keyringOf(p);
    expect(wrapIterations(changed)).toBe(2_000_000);
    expect(changed.wraps.find((w) => w.method === "password")!.kdf).not.toEqual(
      before.wraps.find((w) => w.method === "password")!.kdf,
    );
    expect(await opens(changed, OWN)).toBe(false);
    expect(await opens(changed, "Rosegarden99!")).toBe(true);
    await page.lock();
    await p.popup().service.unlockWithPassword("Rosegarden99!");
  });

  it("the PIN's set-up and a backup file stay at 600k", async () => {
    const p = profile();
    const svc = p.page().service;
    await svc.create(await svc.prepareKeys(STRONG));
    await new PinAdmin(svc).setPin(STRONG, PIN);
    const pin = p.local.data.get("sk_pin") as { kdf: { iterations: number } };
    expect(pin.kdf.iterations).toBe(600_000);
    const file = await createBackup(emptyVault("vault-aaaaaaaa"), STRONG);
    expect(file.kdf.iterations).toBe(600_000);
    expect(read("core/service/pin-admin.ts")).toMatch(/newPinKdf\(this\.s\["rng"\], this\.s\["iterations"\]\)/);
  });

  it("only the service's own key operations name the new count: the keyring's default wraps keep 600k", async () => {
    // a wrap made without the service's count (what the PIN's and the backup file's paths rely on) is at the default
    const { keyring, vk } = await createKeyring();
    const rng = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const now = () => 1_800_000_000_000;
    expect(wrapIterations(await setPassword(keyring, vk, STRONG, { now, rng }))).toBe(600_000);
    expect(wrapIterations((await rekey(keyring, vk, STRONG, { now, rng })).keyring)).toBe(600_000);
    for (const f of ["core/crypto/pin.ts", "core/backup/backup.ts"])
      expect(read(f), f).not.toMatch(/PBKDF2_PASSWORD_WRAP_ITERATIONS/);
    expect(read("core/service/service.ts")).toMatch(
      /iterations: this\.iterations \?\? PBKDF2_PASSWORD_WRAP_ITERATIONS/,
    );
  });

  it("the test hook is the tests' alone: no shipped code passes kdfIterations, so production uses the shipped counts", () => {
    const walk = (dir: string): string[] =>
      readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
      );
    const files = walk(".").map((f) => f.slice(2));
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter((f) => /kdfIterations/.test(read(f)));
    expect(naming).toEqual(["core/service/service-core.ts"]); // its declaration and the constructor's one read
    expect(read("core/service/service-core.ts").match(/kdfIterations/g)).toHaveLength(2);
  });
});

describe("§3 the lock screen's line: a PIN that needs the master password once", () => {
  /** A vault with a PIN (and its record), then soft-locked: the PIN works. */
  async function withPin() {
    const p = profile();
    const svc = p.page().service;
    await svc.create(await svc.prepareKeys(STRONG));
    await new PinAdmin(svc).setPin(STRONG, PIN);
    await svc.lock();
    return { p, svc };
  }
  /** The popup's lock screen: the view's screen, with what the PIN offers folded in (Locked.tsx: restartOffer). */
  const screen = async (p: Profile) => {
    const rt = p.popup();
    const s = await loadScreen(rt);
    const o = s.k === "locked" ? restartOffer(rt.service, pinKit) : null;
    return o ? { ...s, pin: o.state, ...(o.field ? { field: o.field } : {}) } : s;
  };
  /** The master password on the popup's lock screen, and its note (Locked.tsx). */
  const password = async (p: Profile) => {
    const svc = p.popup().service;
    await svc.unlockWithPassword(STRONG);
    await pinStepsNote(svc, pinKit);
    await p.page().service.lock();
  };

  it("a PIN that opens Sixkey: the PIN screen, no line; after End quick unlock or 5 wrong tries: the line; a restart keeps the PIN", async () => {
    const { p } = await withPin();
    expect(await screen(p)).toEqual({ k: "locked", pin: "pin", field: { digits: 6, triesLeft: 5 } });
    await new PinAdmin(p.page().service).endQuickUnlock(); // "End quick unlock and lock"
    expect(await screen(p)).toEqual({ k: "locked", pin: "wait" });
    // the master password brings the PIN back, and the line goes
    await password(p);
    expect(await screen(p)).toMatchObject({ k: "locked", pin: "pin", field: { triesLeft: 5 } });
    p.session.data.clear(); // the browser restarted (or the extension reloaded): the PIN still opens Sixkey
    expect(await screen(p)).toMatchObject({ k: "locked", pin: "pin", field: { triesLeft: 5 } });
    for (let i = 0; i < 5; i++) expect((await pinStepsUnlock(p.popup().service, "135792", pinKit)).ok).toBe(false);
    expect(await screen(p)).toEqual({ k: "locked", pin: "wait" });
  });

  it("no time limit (OWNER-DECISIONS/20, 2026-10-30): after 12 hours, and after 15 days, still the PIN screen", async () => {
    const { p } = await withPin();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 12 * 3_600_000 + 1_000);
    expect(await screen(p)).toMatchObject({ k: "locked", pin: "pin" });
    vi.setSystemTime(Date.now() + 15 * 86_400_000);
    expect(await screen(p)).toMatchObject({ k: "locked", pin: "pin" });
  });

  it("never without a PIN, for a PIN of other keys or a damaged one, or in a profile declared shared", async () => {
    const none = profile();
    await none.page().service.create(await none.page().service.prepareKeys(STRONG));
    await none.page().service.lock();
    expect(await screen(none)).toEqual({ k: "locked" });

    const { p } = await withPin();
    await new PinAdmin(p.page().service).endQuickUnlock();
    const rec = p.local.data.get("sk_pin") as { vkId: string; vaultId: string };
    p.local.data.set("sk_pin", { ...rec, vkId: rec.vkId.replace(/^./, (c) => (c === "0" ? "1" : "0")) });
    expect(await screen(p)).toEqual({ k: "locked" }); // set up for another key: a password unlock would not make it
    p.local.data.set("sk_pin", { ...rec, vaultId: "another-vault-id-0001" });
    expect(await screen(p)).toEqual({ k: "locked" });
    p.local.data.set("sk_pin", { ...rec, digits: "six" });
    expect(await screen(p)).toEqual({ k: "locked" }); // damaged
    p.local.data.set("sk_pin", rec);
    expect(await screen(p)).toEqual({ k: "locked", pin: "wait" });

    // declared shared (the security mode): no PIN there, and the lock screen says nothing of it
    const page = p.page().service;
    await page.unlockWithPassword(STRONG);
    await page.updateSettings({ ...(await page.getSettings()), profile: "shared" });
    expect(p.local.data.has("sk_pin")).toBe(true); // still set up, for a return to "only me"
    expect(await screen(p)).toEqual({ k: "locked" });
    // and by the older marker too: the three settings of the shared mode without an explicit profile
    const s = await page.getSettings();
    const { profile: _marker, ...unmarked } = s;
    const older = { ...unmarked, autoLock: { mode: "always" }, lockOnScreenLock: true };
    p.local.data.set("sk_settings", { ...older, display: { ...s.display, hideCodes: true } });
    expect(await screen(p)).toEqual({ k: "locked" });
    p.local.data.set("sk_settings", { ...older, display: { ...s.display, hideCodes: false } }); // "Custom": not shared
    expect(await screen(p)).toEqual({ k: "locked", pin: "wait" }); // its record went with the shared profile
  });

  it("nothing of a PIN that cannot be used leaves: the view says nothing of the PIN, the offer only that it waits", async () => {
    const { p } = await withPin();
    await new PinAdmin(p.page().service).endQuickUnlock();
    const svc = p.popup().service;
    const view = await svc.openView();
    expect(Object.keys(view).sort()).toEqual(["events", "state"]);
    expect(restartOffer(svc, pinKit)).toEqual({ state: "wait" });
    expect(JSON.stringify(view)).not.toMatch(/digits|tries|expires|vaultId|vkId/);
  });

  it("no read more than before: 3 local gets, sk_pin, its record and the settings inside the pointer's; the same session reads", async () => {
    const { p } = await withPin();
    await new PinAdmin(p.page().service).endQuickUnlock();
    p.zero();
    expect(await screen(p)).toEqual({ k: "locked", pin: "wait" });
    expect(p.local.c.gets).toBe(3); // the pointer, the active slot, the settings in the session router: as before
    expect(p.local.c.keys[0]).toEqual(expect.arrayContaining(["sk_pin", "sk_pin_restart", "sk_settings"]));
    expect(p.local.c.keys.filter((k) => k.includes("sk_pin"))).toHaveLength(1);
    expect(p.session.c.keys.map((k) => k.join(",")).sort()).toEqual(["sk_pw_format", "sk_quick", "sk_session"]);
    // and the same with the PIN usable
    await password(p);
    p.zero();
    expect(await screen(p)).toHaveProperty("field");
    expect(p.local.c.gets).toBe(3);
    expect(p.session.c.keys.map((k) => k.join(",")).sort()).toEqual(["sk_pw_format", "sk_quick", "sk_session"]);
    // nothing written by a look at the lock screen
    expect([...p.local.c.sets, ...p.session.c.sets]).toEqual([]);
  });

  it("the settings page's unlock bar and the popup's lock screen show the line when a PIN set up does not open Sixkey now", () => {
    const bar = read("options/UnlockBar.tsx");
    expect(bar).toMatch(/setWaiting\(s\.available === "ok" && s\.pin !== null && !opens\)/);
    expect(bar).toMatch(
      /\{!pin && waiting && \(\s+<p class="muted" id="unlock-pin-waiting">\s+\{t\("lockPinWaiting"\)\}/,
    );
    const locked = read("popup/screens/Locked.tsx");
    expect(locked).toMatch(
      /\{mode === "password" && \(\(offer && !field\) \|\| waitingNow\) && \(\s+<p class="muted" id="pin-waiting">\s+\{t\("lockPinWaiting"\)\}/,
    );
  });
});
