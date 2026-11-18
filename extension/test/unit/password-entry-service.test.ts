// A generated master password typed back loosely, through the real runtime over counting storage (docs/design/notes/
// PASSWORD-SETUP-NOTES.md §7, §8): every prompt that checks the master password takes it, a wrong one is one failure
// and one record (one key derivation more at most, and only for a generated shape), the PIN's tries are untouched, the
// stored password never changes; and the input hint (sk_pw_format), written only for a generator spelling, learnt at an
// unlock, read from chrome.storage.session by the settings page and by the popup's lock screen (its view), and never
// trusted for anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as kdf from "../../src/core/crypto/kdf";
import type { Keyring } from "../../src/core/crypto/keyring";
import { PinAdmin } from "../../src/core/service/pin-admin";
import { pinKit } from "../../src/core/service/pin-kit";
import { restartOffer } from "../../src/core/service/pin-restart-count";
import { unlock as viaRecord } from "../../src/core/service/pin-restart-steps";
import { formatFor, formatRecord, PW_FORMAT_KEY } from "../../src/core/service/pw-format";
import type { VaultService } from "../../src/core/service/service";
import { createRuntime, passwordFormat } from "../../src/platform/runtime";
import { createPopupRuntime } from "../../src/platform/runtime-base";
import { loadScreen } from "../../src/popup/load";
import { codeOf, createProtected, NO_PAGE, resetWithCode } from "../helpers/vaults";

const GEN = "JDXT-NBSG-6JQG-XBTV";
const LOOSE = "jdxt nbsg 6jqg xbtv";
const WRONG = "jdxtnbsg6jqgxbtw"; // the shape, one symbol off
const WORDS = "acorn-banjo-canyon-dwelling-eagle";
const OWN = "tulip-orbit-lantern-84"; // a password of the user's own: no generated shape
const PIN = "246813";
afterEach(() => vi.restoreAllMocks());

function countingArea() {
  const data = new Map<string, unknown>();
  const c = { gets: 0, keys: [] as string[][], sets: [] as string[][], removes: [] as string[][] };
  const area = {
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      c.gets++;
      c.keys.push(keys == null ? ["*"] : ks); // a get of every key (a listing) is not a read of any one
      return Object.fromEntries(ks.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items: Record<string, unknown>) {
      c.sets.push(Object.keys(items));
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      const ks = Array.isArray(keys) ? keys : [keys];
      c.removes.push(ks);
      for (const k of ks) data.delete(k);
    },
  };
  return { data, c, area: area as unknown as chrome.storage.StorageArea };
}

async function world(password: string) {
  const local = countingArea();
  const session = countingArea();
  /** A new page (a popup, a settings tab) over the same storage. */
  const page = () => createRuntime({ local: local.area, session: session.area, mirror: null });
  /** A new popup, with the popup's own wiring (ServiceCore). */
  const popup = () => createPopupRuntime({ local: local.area, session: session.area, mirror: null });
  const rt = page();
  const { recoveryCode } = await createProtected(rt.service, password);
  const log = async () => rt.security.read();
  const failures = async () => (await log()).entries.filter((e) => e.kind === "unlock_failed").length;
  const keyring = (): Keyring => {
    const active = local.data.get("sk_active") as string;
    return (local.data.get(`sk_slot_${active}`) as { keyring: Keyring }).keyring;
  };
  const passwordWrap = () => JSON.stringify(keyring().wraps.find((w) => w.method === "password"));
  const hint = () => formatFor(session.data.get(PW_FORMAT_KEY), keyring());
  const salt = () => keyring().wraps.find((x) => x.method === "password")!.kdf!.salt;
  return {
    local,
    session,
    page,
    popup,
    rt,
    svc: rt.service,
    recoveryCode,
    log,
    failures,
    keyring,
    passwordWrap,
    hint,
    salt,
  };
}
const derivations = () => vi.spyOn(kdf, "deriveKekFromPassword");
const opens = async (svc: Pick<VaultService, "unlockWithPassword">, pw: string) =>
  (await svc.unlockWithPassword(pw)).view.state === "unlocked";

describe("the lock screen takes a generated password typed loosely", () => {
  it("without hyphens, in lower case, with spaces, exactly: each opens; nothing is re-wrapped or re-encrypted", async () => {
    const w = await world(GEN);
    const wrap = w.passwordWrap();
    const slot = JSON.stringify(w.local.data.get(`sk_slot_${w.local.data.get("sk_active") as string}`));
    for (const typed of ["jdxtnbsg6jqgxbtv", "JDXTNBSG6JQGXBTV", LOOSE, " Jdxt-Nbsg 6jqg-xbtv ", GEN]) {
      await w.svc.lock();
      expect(await opens(w.page().service, typed), typed).toBe(true);
    }
    expect(w.passwordWrap()).toBe(wrap);
    expect(JSON.stringify(w.local.data.get(`sk_slot_${w.local.data.get("sk_active") as string}`))).toBe(slot);
    expect(await w.failures()).toBe(0);
  });

  it("the words with spaces, underscores or capitals", async () => {
    const w = await world(WORDS);
    for (const typed of ["acorn banjo canyon dwelling eagle", "Acorn_Banjo_Canyon_Dwelling_Eagle", WORDS]) {
      await w.svc.lock();
      expect(await opens(w.page().service, typed), typed).toBe(true);
    }
  });

  it("a wrong password is one failure and one record; one key derivation more only for a generated shape", async () => {
    const w = await world(GEN);
    await w.svc.lock();
    const svc = w.page().service;
    const spy = derivations();
    for (const [typed, n] of [
      [WRONG, 2], // the shape: as typed, then the spelling
      ["JDXT-NBSG-6JQG-XBTW", 1], // already the spelling
      ["not the password at all", 1], // any other shape: as before
    ] as const) {
      const before = (await w.log()).failed;
      await expect(svc.unlockWithPassword(typed)).rejects.toMatchObject({ code: "wrong_secret" });
      expect(spy, typed).toHaveBeenCalledTimes(n);
      expect((await w.log()).failed - before, typed).toBe(1);
      spy.mockClear();
    }
    expect(await w.failures()).toBe(3);
    await expect(svc.unlockWithPassword("")).rejects.toMatchObject({ code: "empty_password" }); // a typo, not a guess
    expect(await w.failures()).toBe(3);
  });

  it("a user's own password opens as itself only: no loose spelling of it does", async () => {
    const w = await world(OWN);
    await w.svc.lock();
    const svc = w.page().service;
    for (const typed of ["Tulip-Orbit-Lantern-84", "tulip orbit lantern 84", "tulip_orbit_lantern_84"])
      await expect(svc.unlockWithPassword(typed), typed).rejects.toMatchObject({ code: "wrong_secret" });
    expect(await opens(svc, OWN)).toBe(true);
  });

  it("the PIN's tries and its set-up are untouched by a wrong master password, loose or not", async () => {
    const w = await world(GEN);
    await new PinAdmin(w.svc).setPin(LOOSE, PIN); // the PIN box's master password, loosely
    await w.svc.lock();
    const record = JSON.stringify(w.local.data.get("sk_pin_restart"));
    const pin = JSON.stringify(w.local.data.get("sk_pin"));
    const svc = w.page().service;
    await expect(svc.unlockWithPassword(WRONG)).rejects.toMatchObject({ code: "wrong_secret" });
    expect(JSON.stringify(w.local.data.get("sk_pin_restart"))).toBe(record);
    expect(JSON.stringify(w.local.data.get("sk_pin"))).toBe(pin);
    expect((await loadScreen(w.page())).k).toBe("locked");
    await svc.openView(); // the lock screen's look, on this page
    expect(restartOffer(svc, pinKit)).toMatchObject({ state: "pin", field: { triesLeft: 5 } });
    expect((await viaRecord(svc, PIN, pinKit)).ok).toBe(true);
  });
});

describe("every prompt that asks for the master password again takes the same loose spellings", () => {
  it("export (verifyPassword), clearing the log, a new recovery code, a permanent delete, the PIN, a rotation, a change", async () => {
    const w = await world(GEN);
    await w.svc.verifyPassword(LOOSE);
    await w.svc.requireMasterPassword("jdxtnbsg6jqgxbtv");
    await w.svc.newRecoveryCode(LOOSE, NO_PAGE);
    await w.svc.purgeForever([], LOOSE);
    const admin = new PinAdmin(w.svc);
    await admin.setPin(LOOSE, PIN);
    await admin.removePin("JDXTNBSG6JQGXBTV");
    await w.svc.clearSecurityLog(LOOSE);
    expect(await w.failures()).toBe(0);

    // the rotation re-wraps the password: with the stored spelling, never the loose one typed for it
    const salt = w.keyring().wraps.find((x) => x.method === "password")!.kdf!.salt;
    await w.svc.rotateKey(LOOSE, NO_PAGE);
    expect(w.keyring().wraps.find((x) => x.method === "password")!.kdf!.salt).not.toBe(salt); // a new wrap
    for (const typed of [GEN, LOOSE]) {
      await w.svc.lock();
      expect(await opens(w.page().service, typed), typed).toBe(true);
    }
    // the exact spelling is what is stored: the strict check (the sync engine's) takes it, and only it
    const { unlockWithPassword } = await import("../../src/core/crypto/keyring");
    expect((await unlockWithPassword(w.keyring(), GEN)).id).toBe(w.keyring().vkId);
    await expect(unlockWithPassword(w.keyring(), LOOSE)).rejects.toMatchObject({ code: "unwrap_failed" });

    // a change: the old one loosely, the new one stored exactly as given
    await w.svc.changePassword(LOOSE, OWN);
    await w.svc.lock();
    expect(await opens(w.page().service, OWN)).toBe(true);
    expect(await w.failures()).toBe(0);
  });

  it("a wrong one at any of them: one record, one failure, and nothing done", async () => {
    const w = await world(GEN);
    const admin = new PinAdmin(w.svc);
    const wrap = w.passwordWrap();
    const attempts: [string, () => Promise<unknown>][] = [
      ["verifyPassword", () => w.svc.verifyPassword(WRONG)],
      ["requireMasterPassword", () => w.svc.requireMasterPassword(WRONG)],
      ["newRecoveryCode", () => w.svc.newRecoveryCode(WRONG, NO_PAGE)],
      ["purgeForever", () => w.svc.purgeForever([], WRONG)],
      ["clearSecurityLog", () => w.svc.clearSecurityLog(WRONG)],
      ["setPin", () => admin.setPin(WRONG, PIN)],
      ["rotateKey", () => w.svc.rotateKey(WRONG, NO_PAGE)],
      ["changePassword", () => w.svc.changePassword(WRONG, OWN)],
    ];
    for (const [name, attempt] of attempts) {
      const before = await w.log();
      const spy = derivations();
      await expect(attempt(), name).rejects.toMatchObject({ code: "wrong_secret" });
      expect(spy, name).toHaveBeenCalledTimes(2); // as typed and the spelling, nothing more
      spy.mockRestore();
      const after = await w.log();
      expect(after.entries.length - before.entries.length, name).toBe(1);
      expect(after.entries[0]!.kind, name).toBe("unlock_failed");
      expect(after.failed - before.failed, name).toBe(1);
    }
    expect(w.passwordWrap()).toBe(wrap);
    expect(w.local.data.has("sk_pin")).toBe(false);
  });

  it("the password reset stores the new password exactly; a restored backup's keys likewise", async () => {
    const w = await world(OWN);
    await w.svc.lock();
    await resetWithCode(w.page().service, w.recoveryCode, GEN);
    await w.svc.lock();
    expect(await opens(w.page().service, LOOSE)).toBe(true);
    const { unlockWithPassword } = await import("../../src/core/crypto/keyring");
    expect((await unlockWithPassword(w.keyring(), GEN)).id).toBe(w.keyring().vkId);
  });
});

describe("the input hint (sk_pw_format): which field the prompts show, nothing more, and never on disk", () => {
  it("written, to chrome.storage.session only, when a vault is made with a generated password; never for a user's own", async () => {
    for (const [pw, format] of [
      [GEN, "gen16-v1"],
      [WORDS, "gen5words-v1"],
    ] as const) {
      const w = await world(pw);
      expect(w.session.data.get(PW_FORMAT_KEY), pw).toMatchObject({ v: 1, format });
      expect(w.local.data.has(PW_FORMAT_KEY), pw).toBe(false);
    }
    for (const own of [OWN, "jdxtnbsg6jqgxbtv", "Acorn Banjo Canyon Dwelling Eagle"]) {
      const w = await world(own); // the shape, but not the generator's spelling: not what a generator made
      expect(w.session.data.has(PW_FORMAT_KEY), own).toBe(false);
      await w.svc.lock();
      expect(await opens(w.page().service, own)).toBe(true);
      expect(w.session.data.has(PW_FORMAT_KEY), own).toBe(false); // nor learnt at an unlock
    }
  });

  it("follows the password: a change, a rotation (a new salt), a reset; a password of the user's own removes it", async () => {
    const w = await world(GEN);
    expect(w.hint()).toBe("gen16-v1");
    const code = await codeOf((d) => w.svc.rotateKey(LOOSE, d));
    expect(w.hint()).toBe("gen16-v1"); // written again, for the new wrap
    await w.svc.changePassword(GEN, WORDS);
    expect(w.hint()).toBe("gen5words-v1");
    await w.svc.changePassword(WORDS, OWN);
    expect(w.session.data.has(PW_FORMAT_KEY)).toBe(false);
    await w.svc.lock();
    await resetWithCode(w.page().service, code, GEN);
    expect(w.hint()).toBe("gen16-v1");
    expect(w.local.data.has(PW_FORMAT_KEY)).toBe(false);
  });

  it("survives a lock, not a browser restart; the first password unlock after it learns it again, then writes nothing", async () => {
    const w = await world(GEN);
    await w.svc.lock(); // the soft lock
    expect(w.hint()).toBe("gen16-v1");
    await w.page().service.updateSettings({ ...(await w.svc.getSettings()), autoLock: { mode: "session" } }); // hard
    expect(w.hint()).toBe("gen16-v1");
    w.session.data.clear(); // the browser closed: chrome.storage.session is memory only
    expect(await passwordFormat(w.page())).toBeNull(); // the plain field, until...
    w.session.c.sets.length = 0;
    expect(await opens(w.page().service, "jdxtnbsg6jqgxbtv")).toBe(true); // ...an unlock, loosely even
    expect(w.hint()).toBe("gen16-v1");
    expect(w.session.c.sets.filter((k) => k.includes(PW_FORMAT_KEY))).toHaveLength(1);
    for (const typed of [GEN, LOOSE]) {
      await w.svc.lock();
      w.session.c.sets.length = 0;
      w.session.c.removes.length = 0;
      expect(await opens(w.page().service, typed)).toBe(true);
      const touched = [...w.session.c.sets, ...w.session.c.removes].filter((k) => k.includes(PW_FORMAT_KEY));
      expect(touched, typed).toEqual([]); // the steady state writes nothing
    }
    expect(w.local.data.has(PW_FORMAT_KEY)).toBe(false);
  });

  it("reads: at the lock screen exactly sk_session, sk_quick and the hint from the session area, 3 local gets; one more at an unlock; the hint never from chrome.storage.local", async () => {
    const w = await world(GEN);
    await w.svc.lock();
    for (const c of [w.local.c, w.session.c]) {
      c.gets = 0;
      c.keys = [];
    }
    const rt = w.popup();
    expect(await loadScreen(rt)).toEqual({ k: "locked", format: "gen16-v1" });
    const named = (keys: string[][]) => keys.filter((k) => k.includes(PW_FORMAT_KEY)).length;
    // the lock screen, exactly (PASSWORD-SETUP-NOTES §8.3): the session, sk_quick and the hint, one get each, the last two
    // side by side (so compared sorted); and the three local gets of an open, none of them the hint
    expect(w.session.c.keys.map((k) => k.join(",")).sort()).toEqual(["sk_pw_format", "sk_quick", "sk_session"]);
    expect(w.local.c.gets).toBe(3);
    expect(named(w.local.c.keys)).toBe(0);
    const before = { local: w.local.c.gets, session: w.session.c.keys.length };
    expect(await opens(rt.service, LOOSE)).toBe(true);
    expect(named(w.local.c.keys)).toBe(0);
    expect(named(w.session.c.keys.slice(before.session))).toBe(1);
    expect(w.session.c.keys.slice(before.session).filter((k) => k.includes(PW_FORMAT_KEY))[0]).toEqual([PW_FORMAT_KEY]);
    // an open that finds a live session reads nothing of it
    w.session.c.keys = [];
    expect((await loadScreen(w.popup())).k).toBe("main");
    expect(named(w.session.c.keys) + named(w.local.c.keys)).toBe(0);
  });

  it("the settings page reads it against the keyring as stored now: a record for another wrap says nothing", async () => {
    const w = await world(GEN);
    expect(await passwordFormat(w.page())).toBe("gen16-v1");
    const stale = w.session.data.get(PW_FORMAT_KEY);
    await w.svc.changePassword(GEN, OWN);
    w.session.data.set(PW_FORMAT_KEY, stale); // left by an older page, or a password changed through sync
    expect(await passwordFormat(w.page())).toBeNull();
    w.session.data.set(PW_FORMAT_KEY, { v: 9, format: "gen16-v1", salt: "x" });
    expect(await passwordFormat(w.page())).toBeNull();
    // a record in chrome.storage.local (none is ever written there) is not read at all
    w.session.data.delete(PW_FORMAT_KEY);
    const salt = w.keyring().wraps.find((x) => x.method === "password")!.kdf!.salt;
    w.local.data.set(PW_FORMAT_KEY, { v: 1, format: "gen16-v1", salt });
    expect(await passwordFormat(w.page())).toBeNull();
  });

  it("is never trusted: a forged hint changes no answer and no cost, and the next unlock puts it right", async () => {
    const w = await world("supersecretpassw"); // the 16-symbol shape, but the user's own spelling
    const salt = w.keyring().wraps.find((x) => x.method === "password")!.kdf!.salt;
    expect(w.session.data.has(PW_FORMAT_KEY)).toBe(false);
    w.session.data.set(PW_FORMAT_KEY, { v: 1, format: "gen16-v1", salt }); // forged, for this very wrap
    await w.svc.lock();
    expect(await passwordFormat(w.page())).toBe("gen16-v1"); // the field changes, and only that
    const svc = w.page().service;
    const spy = derivations();
    // the hint never makes a spelling: the canonical form of the user's own password does not open it
    await expect(svc.unlockWithPassword("SUPE-RSEC-RETP-ASSW")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await expect(svc.unlockWithPassword("not the password")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(spy).toHaveBeenCalledTimes(1); // no extra derivation for a wrong password of another shape
    await expect(svc.verifyPassword("SUPE RSEC RETP ASSW")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(await w.failures()).toBe(3);
    expect(await opens(svc, "supersecretpassw")).toBe(true);
    expect(w.session.data.has(PW_FORMAT_KEY)).toBe(false); // put right by the unlock
  });

  it("formatRecord: only the generator's exact spelling, bound to the wrap's salt", async () => {
    const w = await world(GEN);
    const kr = w.keyring();
    const salt = kr.wraps.find((x) => x.method === "password")!.kdf!.salt;
    expect(formatRecord(kr, GEN)).toEqual({ v: 1, format: "gen16-v1", salt });
    expect(formatRecord(kr, WORDS)).toEqual({ v: 1, format: "gen5words-v1", salt });
    for (const pw of [LOOSE, "jdxtnbsg6jqgxbtv", "acorn banjo canyon dwelling eagle", OWN, ""])
      expect(formatRecord(kr, pw), pw).toBeNull();
    for (const bad of [null, 1, "gen16-v1", {}, { v: 1, format: "other", salt }, { v: 1, format: "gen16-v1" }])
      expect(formatFor(bad, kr)).toBeNull();
    expect(formatFor({ v: 1, format: "gen16-v1", salt }, kr)).toBe("gen16-v1");
  });
});

describe("the popup's lock screen: the hint picks its field (the view's format), and an unlock never depends on it", () => {
  const screen = async (w: Awaited<ReturnType<typeof world>>) => loadScreen(w.popup());

  it("present: the format the record names for this keyring's wrap; absent or for another wrap: none", async () => {
    for (const [pw, format] of [
      [GEN, "gen16-v1"],
      [WORDS, "gen5words-v1"], // the popup shows its plain field for words; the view says what the record says
    ] as const) {
      const w = await world(pw);
      await w.svc.lock();
      expect(await screen(w), pw).toEqual({ k: "locked", format });
    }
    const own = await world(OWN);
    await own.svc.lock();
    expect(await screen(own)).toEqual({ k: "locked" }); // no record: the plain field, as before
    // a record for an earlier password (changed in another page, or adopted through sync) says nothing
    const w = await world(GEN);
    const stale = w.session.data.get(PW_FORMAT_KEY);
    await w.svc.changePassword(GEN, OWN);
    w.session.data.set(PW_FORMAT_KEY, stale);
    await w.svc.lock();
    expect(await screen(w)).toEqual({ k: "locked" });
    // nor does a damaged one, one of another version, or one in chrome.storage.local (never read)
    for (const bad of [
      { v: 2, format: "gen16-v1", salt: w.salt() },
      "gen16-v1",
      { v: 1, format: "x", salt: w.salt() },
    ]) {
      w.session.data.set(PW_FORMAT_KEY, bad);
      expect(await screen(w), JSON.stringify(bad)).toEqual({ k: "locked" });
    }
    w.session.data.delete(PW_FORMAT_KEY);
    w.local.data.set(PW_FORMAT_KEY, { v: 1, format: "gen16-v1", salt: w.salt() });
    expect(await screen(w)).toEqual({ k: "locked" });
  });

  it("absent after a restart: the plain field, which takes the code typed loosely; that unlock brings the grouped input back", async () => {
    const w = await world(GEN);
    await w.svc.lock();
    w.session.data.clear(); // the browser closed: chrome.storage.session is memory only
    const rt = w.popup();
    expect(await loadScreen(rt)).toEqual({ k: "locked" });
    expect(await opens(rt.service, "jdxtnbsg6jqgxbtv")).toBe(true);
    await w.svc.lock();
    expect(await screen(w)).toEqual({ k: "locked", format: "gen16-v1" });
  });

  it("the grouped input's value (the groups joined by hyphens) opens it, whole or typed in lower case, from any box", async () => {
    const w = await world(GEN);
    for (const typed of ["jdxtnbsg6jqgxbtv", " JDXT nbsg-6jqg XBTV", GEN.toLowerCase()]) {
      await w.svc.lock();
      const rt = w.popup();
      expect(await loadScreen(rt)).toMatchObject({ format: "gen16-v1" });
      // what the boxes hand the form: the whole code pasted (pasteInto), or filled in (typedInto), joined by valueOf
      // (password-groups-dom.test.ts checks the component hands over exactly this, and the lock screen sends it)
      const { pasteInto, typedInto, valueOf } = await import("../../src/ui/PasswordGroups");
      for (const value of [
        valueOf(pasteInto("", 0, "", 0, 0, typed)!.code),
        valueOf(typedInto("", 0, typed, typed.length)!.code),
      ]) {
        expect(value, typed).toBe(GEN);
        await w.svc.lock();
        const spy = derivations();
        expect(await opens(w.popup().service, value), typed).toBe(true);
        expect(spy, typed).toHaveBeenCalledTimes(1); // the exact spelling: one key derivation, never the loose second
        spy.mockRestore();
      }
    }
    expect(await w.failures()).toBe(0);
  });

  it("wrong: a forged or mistaken hint changes the field and nothing else; the unlock takes the password, loosely, as ever", async () => {
    // a 16-symbol hint over the words: the grouped input cannot take them, so the screen's plain field does (one click)
    const words = await world(WORDS);
    words.session.data.set(PW_FORMAT_KEY, { v: 1, format: "gen16-v1", salt: words.salt() }); // forged, for this wrap
    await words.svc.lock();
    const rt = words.popup();
    expect(await loadScreen(rt)).toEqual({ k: "locked", format: "gen16-v1" });
    const spy = derivations();
    expect(await opens(rt.service, "Acorn Banjo Canyon Dwelling Eagle")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); // as typed, then the spelling: what it costs with no hint at all
    spy.mockRestore();
    expect(words.hint()).toBe("gen5words-v1"); // put right by the unlock
    // a words hint over a generated code (the popup: the plain field), typed without hyphens in lower case
    const gen = await world(GEN);
    gen.session.data.set(PW_FORMAT_KEY, { v: 1, format: "gen5words-v1", salt: gen.salt() });
    await gen.svc.lock();
    const pop = gen.popup();
    expect(await loadScreen(pop)).toEqual({ k: "locked", format: "gen5words-v1" });
    expect(await opens(pop.service, "jdxtnbsg6jqgxbtv")).toBe(true);
    expect(gen.hint()).toBe("gen16-v1");
    // a 16-symbol hint over a password of the user's own: it opens as itself, its "spelling" does not
    const own = await world("supersecretpassw");
    own.session.data.set(PW_FORMAT_KEY, { v: 1, format: "gen16-v1", salt: own.salt() });
    await own.svc.lock();
    const p2 = own.popup();
    expect(await loadScreen(p2)).toEqual({ k: "locked", format: "gen16-v1" });
    await expect(p2.service.unlockWithPassword("SUPE-RSEC-RETP-ASSW")).rejects.toMatchObject({ code: "wrong_secret" });
    expect(await opens(p2.service, "supersecretpassw")).toBe(true);
    expect(await own.failures()).toBe(1);
  });

  it("a hint that cannot be read is no hint: the lock screen, not an error; the PIN beside it as before", async () => {
    const w = await world(GEN);
    await new PinAdmin(w.svc).setPin(LOOSE, PIN);
    await w.svc.lock();
    expect(await screen(w)).toEqual({ k: "locked", format: "gen16-v1" });
    const get = w.session.area.get.bind(w.session.area);
    vi.spyOn(w.session.area, "get").mockImplementation((async (keys?: string | string[] | null) => {
      if (Array.isArray(keys) && keys.includes(PW_FORMAT_KEY)) throw new Error("session area gone");
      return get(keys as string[]);
    }) as unknown as typeof w.session.area.get);
    expect(await screen(w)).toEqual({ k: "locked" });
    const pop = w.popup().service;
    await pop.openView();
    expect(restartOffer(pop, pinKit)).toMatchObject({ state: "pin", field: { digits: 6, triesLeft: 5 } });
    expect((await viaRecord(pop, PIN, pinKit)).ok).toBe(true); // the PIN as before
  });
});

describe("source rules: the hint decides nothing, and is kept in chrome.storage.session only", () => {
  const read = (f: string) => readFileSync(join(__dirname, "../../src", f), "utf8");
  const body = (s: string, head: string) => {
    const at = s.indexOf(head);
    expect(at, head).toBeGreaterThanOrEqual(0);
    return s.slice(at, s.indexOf("\n  }\n", at));
  };
  it('"sk_pw_format" is spelled in pw-format.ts only; written by the service only; its store over the session area', () => {
    const files = [
      "core/service/service.ts",
      "core/service/service-core.ts",
      "core/service/pin-admin.ts",
      "core/crypto/keyring.ts",
      "core/backup/backup.ts",
      "platform/runtime.ts",
      "platform/runtime-base.ts",
      "options/MasterField.tsx",
      "ui/PasswordGroups.tsx",
      "options/Backup.tsx",
      "popup/screens/Locked.tsx",
      "popup/load.ts",
      "popup/App.tsx",
    ];
    expect(read("core/service/pw-format.ts")).toMatch(/PW_FORMAT_KEY = "sk_pw_format"/);
    for (const f of files) expect(read(f), f).not.toMatch(/"sk_pw_format"/);
    // saveFormat only, in the part of the service the popup builds too (service-core.ts); VaultService (service.ts) calls it
    expect(read("core/service/service-core.ts").match(/this\.formats\.write\(/g)).toHaveLength(1);
    expect(read("core/service/service.ts")).not.toMatch(/formats\.write\(/);
    // the store is made in the wiring every context shares (platform/runtime-base.ts), and nowhere else
    const rt = read("platform/runtime-base.ts");
    expect(rt).toMatch(/const hintArea = o\.session \?\? globalThis\.chrome\?\.storage\?\.session;/);
    expect(rt).toMatch(/const formats = hintArea && new PwFormatStore\(new ChromeLocalKV\(hintArea\)\);/); // fails closed
    expect(rt.match(/new PwFormatStore\(/g)).toHaveLength(1);
    expect(rt).not.toMatch(/formats\.write/);
    expect(read("platform/runtime.ts")).not.toMatch(/new PwFormatStore\(|formats\.write/);
    for (const f of ["options/MasterField.tsx", "ui/PasswordGroups.tsx", "options/Backup.tsx"])
      expect(read(f), f).not.toMatch(/formats\.write|PW_FORMAT_KEY\]:|storage\.local/);
    // the popup reads it through its view only (openView, below): no page code of its own looks at the record
    for (const f of ["popup/screens/Locked.tsx", "popup/load.ts", "popup/App.tsx", "ui/PasswordGroups.tsx"])
      expect(read(f), f).not.toMatch(/formats\.|PW_FORMAT_KEY|pw-format|storage\??\.local/);
  });
  it("no check of a password reads the hint: the keyring's, verifyPassword, the PIN box's, the backup's", () => {
    const kr = read("core/crypto/keyring.ts");
    expect(body(kr, "export async function openWithPassword(")).not.toMatch(/format|hint/i);
    expect(kr).not.toMatch(/pw-format/);
    const s = read("core/service/service.ts");
    const core = read("core/service/service-core.ts");
    for (const [text, head] of [
      [s, "  async verifyPassword("],
      [s, "  private async unlockWith2("],
      [core, "  private async unlockWith("],
    ] as const)
      expect(body(text, head), head).not.toMatch(/PW_FORMAT_KEY|formatFor|formats/);
    expect(s).not.toMatch(/PW_FORMAT_KEY/); // nor read with the pointer
    expect(core).not.toMatch(/PW_FORMAT_KEY/);
    expect(read("core/service/pin-admin.ts")).not.toMatch(/format/i);
    expect(read("core/backup/backup.ts")).not.toMatch(/pw-format|PW_FORMAT/);
  });
  it("the popup's lock screen: the grouped input for the master password only, under the hint, the plain field a click away", () => {
    const l = read("popup/screens/Locked.tsx");
    expect(l).toMatch(/import \{ PasswordGroups \} from "\.\.\/\.\.\/ui\/PasswordGroups";/); // the settings page's own
    expect(l).not.toMatch(/from "[^"]*options\//);
    expect(l).toMatch(/const groups = mode === "password" && format === "gen16-v1" && !plain;/);
    expect(l).toMatch(/\bgroups \? \(\s*<PasswordGroups/); // (after the shares' entry, which is the recovery code's)
    expect(l).toMatch(
      /<PasswordGroups\s+key="groups"\s+id="secret"\s+label=\{t\("passwordLabel"\)\}\s+labelledBy="lock-label"/,
    );
    expect(l).toMatch(/<label for=\{pin \? "pin" : "secret"\} id="lock-label">/);
    expect(l).toMatch(/invalid=\{!!error\}\s+showable=\{false\}\s+first=\{input\}/); // never shown in the popup
    expect(l).toMatch(
      /\{groups && \(\s*<div>\s*<button[^>]*id="secret-plain"[\s\S]*?setPlain\(true\);\s*setValue\(""\);\s*setError\(null\);[\s\S]*?t\("pwPlainField"\)/,
    );
    // (in the side panel only while the panel has the focus: docs/design/notes/SIDEPANEL-NOTES.md §3)
    expect(l).toMatch(
      /useEffect\(\(\) => \{\s*if \(!surface\.panel \|\| document\.hasFocus\(\)\) input\.current\?\.focus\(\);\s*\}, \[mode, plain\]\);/,
    );
    // the hint decides nothing: what the form sends never depends on it
    for (const head of ["  async function tryPin(", "  async function submit(", "  async function attempt("])
      expect(body(l, head), head).not.toMatch(/format|groups|plain/);
    // the plain field as it was: masked unless the recovery code's Show is ticked, autocomplete off
    expect(l).toMatch(/type=\{shown \? "text" : "password"\}/);
    expect(l).toMatch(/const shown = mode === "recovery" && show;/);
    expect(l.match(/autocomplete=/g)).toEqual(["autocomplete="]);
    expect(l).toMatch(/autocomplete="off"/);
    // the view: the record read once, in openView's locked branch only, and checked against the keyring it has read
    const core = read("core/service/service-core.ts");
    const open = body(core, "  async openView(");
    const at = open.indexOf("if (!vk) {");
    const locked = open.slice(at, open.indexOf("\n    }\n", at));
    expect(locked).toMatch(
      /this\.formats\s*\?\s*this\.formats\s*\.read\(\)\s*\.then\(\(raw\) => formatFor\(raw, r\.gen\.keyring\)\)\s*\.catch\(\(\) => null\)/,
    );
    expect(locked).toMatch(/\.\.\.\(format \? \{ format \} : \{\}\)/);
    expect(open.replace(locked, "")).not.toMatch(/format/i);
    expect(core.match(/this\.formats\s*\.read\(/g)).toHaveLength(2); // noteFormat's (after an unlock) and the lock screen's
  });

  it("every settings prompt for the master password is a MasterField, with the plain field one click away", () => {
    for (const [f, ids] of [
      ["options/UnlockBar.tsx", ["unlock-pw"]],
      ["options/Security.tsx", ["old-pw", "code-pw", "rot-pw"]],
      ["options/PinBox.tsx", ["pin-pw"]],
      ["options/Misc.tsx", ["trash-pw"]],
      ["options/SecurityCard.tsx", ["sec-log-pw"]],
      ["options/Backup.tsx", ["export-pw"]],
    ] as const) {
      const s = read(f);
      for (const id of ids) expect(s, `${f} ${id}`).toMatch(new RegExp(`<MasterField\\s+id="${id}"`));
      expect(s, f).not.toMatch(/autocomplete="current-password"/); // no plain master-password field left beside it
    }
    const m = read("options/MasterField.tsx");
    expect(m).toMatch(/groups && \(/);
    expect(m).toMatch(/t\("pwPlainField"\)/);
    expect(m).toMatch(/format === "gen16-v1" && !plain/);
    expect(m).toMatch(/if \(!p\.value\) setFormat\(hint\);/); // never swapped under the user's fingers (review m1)
  });
});
