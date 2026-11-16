// Touch ID / Windows Hello in Settings › Security (QUICK-UNLOCK §5.3, §5.6, §6.3; Stage 2): enrol a credential, remove
// one, "turn back on" after a key change (one touch right after this page's own key change: OWNER-DECISIONS/17 Q3), make
// a synced gate one that also works after a restart (Q4), end the session quick unlock, and what the box shows. Only the settings page builds it (src/options/DeviceBox.tsx, a lazy chunk): enrolment always runs in a tab
// (§0A.5 item 3: the popup can vanish during a Chrome-profile create()), so none of it is in the popup's bundle.
//
// It reuses the service's own steps by element access (as pin-admin.ts does): the store, the settings, the session, the
// clock and random source, the security record, the quick lock, requireVk, the PIN's and the device unlock's stores; and
// verifyPassword itself, so the master password typed again is checked, answered and recorded exactly as everywhere.
//
// Classification is by what the authenticator returned, never by the OS (§5.3 steps 3–4; docs/design/notes/PRF-NOTES.md):
//   - a PRF result from the verification get() (`results.first`, never `prf.enabled`) and the BE flag clear: "prf";
//   - a PRF result and BE set (a passkey that syncs): "prf" marked synced only if the user ticked the opt-in (Q2), else
//     "gate" ("synced" refused: the screen says why, prfSyncedRefused);
//   - no PRF result: "gate" (Touch ID through the Chrome profile has none), whatever the opt-in ("no_prf" when it was
//     ticked: the restarts it asked for cannot be had with this passkey).
// A credential the check below refuses is never saved; the passkey it left in the OS is the user's to delete there (the
// text says where). Every refusal and every cancel saves nothing and records nothing.
import { BE, clientDataOk, gateAssertionOk, parseAuthData, rpIdOk, UP, UV } from "../crypto/assertion";
import { fromB64, toB64 } from "../crypto/bytes";
import { armDevice, quickLive, wrapsTag } from "../crypto/pin";
import { gateMac, gateMacOk, newPrfSalt, sealPrfWrap } from "../crypto/prf";
import { usableRecord } from "../crypto/prf-check";
import { activeKeyring } from "../sync/local/records";
import {
  gateCreds,
  hasGate,
  passwordRecent,
  pausedCreds,
  prfCreds,
  PRF_MAX_CREDS,
  type PrfCred,
  type PrfRecord,
} from "../crypto/prf-record";
import type { Keyring } from "../crypto/keyring";
import type { Vk } from "../crypto/vk";
import { rotatedBy } from "./rotated";
import type { VaultService } from "./service";
import { hasDevice } from "./service-core";
import { updatePrf } from "./prf-write";
import { ServiceError } from "./service-error";
import { profileOf } from "./types";
import { WebAuthnError, type Asserted, type WebAuthnFailure, type WebAuthnPort } from "./webauthn-port";

/** One credential as the box lists it. `paused`: a PRF credential whose wrap a key change set aside ("turn back on"). */
export type DeviceCred = Pick<PrfCred, "id" | "name" | "mode" | "synced" | "createdAt" | "provider"> & {
  paused: boolean;
};

/**
 * What the box shows. `available`: "ok", or why there is no device unlock here: no readable vault, a Phase 0 vault without
 * a master password, a runtime without the record. `platform`: this computer has a platform authenticator (else only the
 * PIN is offered). `pin`: a PIN is set up for this vault and key (armed with the gate: OWNER-DECISIONS/17 Q1). `armed`:
 * the gate opens Sixkey now. `due`: the persistent unlock waits for the master password (the
 * 14 days are over). `full`: no room for another credential.
 */
export type DeviceState = {
  available: "ok" | "no_vault" | "no_password" | "off";
  platform: boolean;
  shared: boolean;
  creds: DeviceCred[];
  pin: boolean;
  armed: boolean;
  due: boolean;
  full: boolean;
};

/**
 * An enrolment's answer. `ok: false`: the ceremony's ("cancelled", "exists": this passkey is registered already,
 * "unsupported": WebAuthn or this kind of authenticator cannot be used here, "failed"), or the credential failed Sixkey's
 * own check ("refused": not a platform authenticator, no user verification, another origin, a key it cannot check).
 * `refused` with ok: what the user asked for and did not get (see the classification above).
 */
export type Enrolment =
  | { ok: true; mode: "prf" | "gate"; synced: boolean; refused?: "synced" | "no_prf" }
  | { ok: false; reason: WebAuthnFailure | "refused" };

/** Where a passkey lives, from its AAGUID (passkeydeveloper/passkey-authenticator-aaguids [transcribed]; QUICK-UNLOCK §0A). */
const PROVIDER_OF: Record<string, PrfCred["provider"]> = {
  ea9b8d664d011d213ce4b6b48cb575d4: "google",
  fbfc3007154e4ecc8c0b6e020557d7bd: "icloud",
  dd4ec289e01d41c9bb8970fa845d4bf2: "icloud",
  adce000235bcc60a648b0b25f1f05503: "chrome",
  "08987058cadc4b81b6e130de50dcbe96": "windows",
  "9ddd1817af5a4672a2b93e3dd95000a9": "windows",
  "6028b017b1d44c02b4b3afcdafc96bb2": "windows",
};

/** How long after this page's own key change "turn back on" needs no master password again (OWNER-DECISIONS/17 Q3). */
const ROTATED_MS = 10 * 60_000;

const protectedBy = (k: Keyring) => !hasDevice(k) && k.wraps.some((w) => w.method === "password");
/** The record of this vault with its usable credentials only (prf-check.ts usableRecord); anything else counts as none. */
function forVault(r: PrfRecord | "damaged" | null, vaultId: string): PrfRecord | null {
  const u = r && r !== "damaged" ? usableRecord(r) : null;
  return u && u !== "damaged" && u.rec.vaultId === vaultId ? u.rec : null;
}

export class DeviceAdmin {
  constructor(
    private readonly s: VaultService,
    private readonly wa: WebAuthnPort,
  ) {}

  private get prfs() {
    const p = this.s["prfs"];
    if (!p) throw new ServiceError("quick_off");
    return p;
  }
  private quick<T>(fn: () => Promise<T>): Promise<T> {
    return this.s["quickLock"](fn);
  }

  /** The ceremony, its failures as the port's codes. */
  private async ask(o: Parameters<WebAuthnPort["get"]>[0]): Promise<Asserted | WebAuthnFailure> {
    try {
      return await this.wa.get(o);
    } catch (e) {
      if (e instanceof WebAuthnError) return e.code;
      throw e;
    }
  }

  /**
   * The vault, unlocked here, with a master password, and the master password typed again (verifyPassword: a wrong one
   * is refused with wrong_secret and recorded as unlock_failed; "" is a typo). Returns the keyring and the vault key.
   * `null` in place of the password: this page's own key change, to this very key, in the last 10 minutes (the master
   * password was typed for it: VaultService `rotated`; OWNER-DECISIONS/17 Q3); else wrong_secret, nothing recorded.
   */
  private async target(password: string | null): Promise<{ keyring: Keyring; vk: Vk }> {
    if (!this.s["prfs"]) throw new ServiceError("quick_off");
    const r = await this.s["store"].load();
    if (r.status !== "ok") throw new ServiceError("bad_state", r.status);
    const keyring = r.gen.keyring;
    if (!protectedBy(keyring)) throw new ServiceError("not_protected");
    const vk = await this.s["requireVk"](keyring); // unlocked (QUICK-UNLOCK §5.3: requirements)
    if (password !== null) await this.s.verifyPassword(password);
    else if (!this.justRotated(keyring)) throw new ServiceError("wrong_secret");
    return { keyring, vk };
  }

  /** This page changed the vault key to `keyring`'s in the last 10 minutes (the one-touch "turn back on" after it). */
  justRotated(keyring: Pick<Keyring, "vkId">): boolean {
    const t = rotatedBy(this.s);
    const age = t ? this.s["now"]() - t.at : -1;
    return !!t && t.vkId === keyring.vkId && age >= 0 && age <= ROTATED_MS;
  }

  /**
   * The session gate with this page's key, from now (the master password was just typed: an enrolment, "turn back on"):
   * only when a gate credential of this key is enrolled, in a solo profile. In place of whatever was armed. `at`: when the
   * master password was typed, if not now (the one touch after this page's key change: the 12 hours count from that). The
   * PIN, beside it on the lock screen (OWNER-DECISIONS/17 Q1), is its own record's (pin-restart.ts), not armed here.
   */
  private async armGate(vk: Vk, keyring: Keyring, rec: PrfRecord, shared: boolean, at?: number): Promise<void> {
    if (shared || !hasGate(rec, vk.id)) return;
    const q = armDevice(vk, keyring.vaultId, at ?? this.s["now"](), wrapsTag(keyring));
    try {
      await this.quick(() => this.s["session"].setQuick(q));
    } catch (e) {
      this.s["diag"]("device gate not armed", e);
    }
  }

  /**
   * Enrol this computer's Touch ID / Windows Hello (§5.3). Needs Sixkey unlocked here, a master password (not a Phase 0
   * device-key vault: not_protected), room for one more (device_full is bad_state), and the master password typed again.
   * `allowSynced`: the opt-in of Q2, ticked after the notice; never in a profile declared shared (quick_off), where a
   * copy of the profile is likely (§5.8). `name`: what the list shows (at most 40 code points).
   *   1. create(): a platform credential, user verification required, the PRF salt evaluated at creation;
   *   2. its check: a platform authenticator, the user present and verified, our challenge, origin and RP ID, a public key
   *      of ES256 or RS256 (else "refused", nothing saved);
   *   3. one get() with the salt, which decides (YR-28): its assertion must pass the gate's own check with that public key
   *      (a gate saved here always opens), and a PRF output there makes it "prf" (see the classification above);
   *   4. one locked write of sk_prf, only while the vault and key are still the ones just checked, with the master
   *      password's time (the 14 days start now); prf_enrolled recorded;
   *   5. a gate that is the session method, in a solo profile, is armed at once (the master password was just typed),
   *      in place of whatever was armed (one method at a time).
   * The PRF output is zeroed once the wrap is made.
   */
  async enrol(password: string, o: { name: string; allowSynced: boolean }): Promise<Enrolment> {
    const shared = profileOf(await this.s["settings"].get()) === "shared";
    if (o.allowSynced && shared) throw new ServiceError("quick_off");
    const { keyring, vk } = await this.target(password);
    const cur = forVault(await this.prfs.read(), keyring.vaultId);
    if (cur && cur.creds.length >= PRF_MAX_CREDS) throw new ServiceError("bad_state", "device_full");
    const rng = this.s["rng"];
    const now = this.s["now"]();
    const salt = newPrfSalt(rng);
    const challenge = rng(32);
    let made;
    try {
      made = await this.wa.create({
        challenge,
        userId: rng(16),
        displayName: `Sixkey unlock · ${new Date(now).toISOString().slice(0, 10)}`,
        exclude: cur?.creds.map((c) => c.id) ?? [],
        prfSalt: salt,
      });
    } catch (e) {
      if (e instanceof WebAuthnError) return { ok: false, reason: e.code };
      throw e;
    }
    const ad = parseAuthData(made.authData);
    const origin = this.wa.origin;
    const alg = made.alg;
    if (
      !ad ||
      made.attachment === "cross-platform" ||
      !(ad.flags & UP) ||
      !(ad.flags & UV) ||
      !clientDataOk(made.clientDataJSON, { type: "webauthn.create", challenge, origin }) ||
      !(await rpIdOk(ad, origin)) ||
      !made.publicKey ||
      (alg !== -7 && alg !== -257)
    )
      return { ok: false, reason: "refused" };
    const check = rng(32);
    const a = await this.ask({ challenge: check, allow: [made.id], prf: { [made.id]: salt } });
    if (typeof a === "string") return { ok: false, reason: a };
    let cred: PrfCred;
    let mode: "prf" | "gate";
    const synced = (ad.flags & BE) !== 0;
    const gotPrf = a.prf?.length === 32;
    try {
      const ok =
        a.id === made.id &&
        (await gateAssertionOk(a, { spki: made.publicKey, alg }, { challenge: check, origin, rpId: origin }));
      if (!ok) return { ok: false, reason: "refused" };
      mode = gotPrf && (!synced || o.allowSynced) ? "prf" : "gate";
      const head = {
        id: made.id,
        kind: "platform" as const,
        mode,
        name: [...o.name].slice(0, 40).join(""),
        synced,
        ...(ad.aaguid && PROVIDER_OF[ad.aaguid] ? { provider: PROVIDER_OF[ad.aaguid] } : {}),
        createdAt: now,
      };
      if (mode === "prf")
        cred = { ...head, salt: toB64(salt), wrap: await sealPrfWrap(vk, keyring.vaultId, made.id, a.prf!, rng) };
      else {
        const gate: PrfCred = { ...head, publicKey: toB64(made.publicKey), alg };
        cred = { ...gate, mac: await gateMac(vk, keyring.vaultId, gate) }; // Sixkey's own, under this key
      }
    } finally {
      a.prf?.fill(0);
    }
    const saved = await updatePrf(
      this.prfs,
      (r, kr) => {
        if (!kr || kr.vaultId !== keyring.vaultId || kr.vkId !== vk.id) return undefined;
        const base: PrfRecord = forVault(r, kr.vaultId) ?? { v: 1, vaultId: kr.vaultId, creds: [] };
        if (base.creds.length >= PRF_MAX_CREDS || base.creds.some((c) => c.id === cred.id)) return undefined;
        return { ...base, creds: [...base.creds, cred], lastPasswordAt: now };
      },
      activeKeyring,
    );
    if (!saved) throw new ServiceError("bad_state", "keys changed meanwhile");
    await this.s["record"]("prf_enrolled");
    if (mode === "gate") await this.armGate(vk, keyring, saved, shared);
    // what was asked for and not had: a synced passkey with a PRF, without the opt-in; the opt-in, with no PRF
    const refused = gotPrf ? (mode === "gate" ? "synced" : undefined) : o.allowSynced ? "no_prf" : undefined;
    return { ok: true, mode, synced, ...(refused ? { refused } : {}) };
  }

  /**
   * Remove a credential (§5.6), with the master password typed again. When it is the last gate credential of this key,
   * the gate's arming goes first (the gate cannot open any more); the PIN, its own record's, is not touched (REVIEW S3,
   * OWNER-DECISIONS/17 Q1). Another gate still opens the arming, and a PRF credential has none: either leaves the arming
   * alone. Then the credential (the
   * record goes with its last one), then prf_removed. A page closed in between leaves the credential listed (to be
   * removed again), never a removed one that opens anything. The passkey itself stays in the OS: the box says where.
   */
  async remove(password: string, id: string): Promise<void> {
    const { keyring } = await this.target(password);
    const rec = forVault(await this.prfs.read(), keyring.vaultId);
    const had = rec?.creds.some((c) => c.id === id) ?? false;
    const gates = rec ? gateCreds(rec, keyring.vkId) : [];
    if (gates.length === 1 && gates[0]!.id === id) await this.dropGateHalf();
    await updatePrf(this.prfs, (r) => {
      const cur = forVault(r, keyring.vaultId);
      if (!cur || !cur.creds.some((c) => c.id === id)) return undefined;
      const creds = cur.creds.filter((c) => c.id !== id);
      return creds.length ? { ...cur, creds } : null;
    });
    if (had) await this.s["record"]("prf_removed");
  }

  /** The gate's arming (sk_quick) taken away, in the quick lock: its last credential went. */
  private dropGateHalf(): Promise<void> {
    return this.quick(() => this.s["session"].clearQuick());
  }

  /**
   * "Turn back on" (YUBIKEY D13, §1.2.5): a credential a key change set aside, after the master password typed again and
   * one touch: a PRF one gets a new wrap under the current key, with a new salt; a gate one, whose assertion passes the
   * gate's check with its stored key, a new MAC under it (and is armed at once in a solo profile, as at enrolment). Its
   * answer: as an enrolment's ceremony ("refused" when the answer is not that credential's, or has no user verification,
   * or no PRF output for a PRF one). prf_enrolled recorded: a way in is back. `password` null: one touch right after this
   * page's own key change, without the master password typed again (OWNER-DECISIONS/17 Q3; target()).
   */
  async reenable(password: string | null, id: string): Promise<Enrolment> {
    const { keyring, vk } = await this.target(password);
    const rec = forVault(await this.prfs.read(), keyring.vaultId);
    const cred = rec?.creds.find((c) => c.id === id && c.kind === "platform");
    if (!cred) throw new ServiceError("bad_state", "no such credential");
    // when the master password was typed: now, or at this page's key change (the one touch: the hours never grow)
    const when = password === null ? rotatedBy(this.s)!.at : this.s["now"]();
    if (cred.mode === "gate") return this.reenableGate(cred, keyring, vk, when);
    const rng = this.s["rng"];
    const salt = newPrfSalt(rng);
    const a = await this.ask({ challenge: rng(32), allow: [id], prf: { [id]: salt } });
    if (typeof a === "string") return { ok: false, reason: a };
    let wrap;
    try {
      const flags = parseAuthData(a.authData)?.flags ?? 0;
      if (a.id !== id || a.prf?.length !== 32 || !(flags & UV)) return { ok: false, reason: "refused" };
      wrap = await sealPrfWrap(vk, keyring.vaultId, id, a.prf, rng);
    } finally {
      a.prf?.fill(0);
    }
    const saved = await updatePrf(
      this.prfs,
      (r, kr) => {
        const cur = forVault(r, keyring.vaultId);
        if (!cur || !kr || kr.vaultId !== keyring.vaultId || kr.vkId !== vk.id) return undefined;
        if (!cur.creds.some((c) => c.id === id && c.mode === "prf")) return undefined;
        const creds = cur.creds.map((c) => (c.id === id ? { ...c, salt: toB64(salt), wrap } : c));
        return { ...cur, creds, lastPasswordAt: when };
      },
      activeKeyring,
    );
    if (!saved) throw new ServiceError("bad_state", "keys changed meanwhile");
    await this.s["record"]("prf_enrolled");
    return { ok: true, mode: "prf", synced: cred.synced };
  }

  /** "Turn back on" for a gate credential (reenable): its assertion, checked with its stored key, then a new MAC. */
  private async reenableGate(cred: PrfCred, keyring: Keyring, vk: Vk, when: number): Promise<Enrolment> {
    const challenge = this.s["rng"](32);
    const a = await this.ask({ challenge, allow: [cred.id] });
    if (typeof a === "string") return { ok: false, reason: a };
    const origin = this.wa.origin;
    const key = { spki: fromB64(cred.publicKey!), alg: cred.alg! };
    if (a.id !== cred.id || !(await gateAssertionOk(a, key, { challenge, origin, rpId: origin })))
      return { ok: false, reason: "refused" };
    const mac = await gateMac(vk, keyring.vaultId, cred);
    const saved = await updatePrf(
      this.prfs,
      (r, kr) => {
        const cur = forVault(r, keyring.vaultId);
        if (!cur || !kr || kr.vaultId !== keyring.vaultId || kr.vkId !== vk.id) return undefined;
        const same = (c: PrfCred) => c.id === cred.id && c.mode === "gate" && c.publicKey === cred.publicKey;
        if (!cur.creds.some(same)) return undefined;
        return { ...cur, creds: cur.creds.map((c) => (same(c) ? { ...c, mac } : c)), lastPasswordAt: when };
      },
      activeKeyring,
    );
    if (!saved) throw new ServiceError("bad_state", "keys changed meanwhile");
    await this.s["record"]("prf_enrolled");
    await this.armGate(vk, keyring, saved, profileOf(await this.s["settings"].get()) === "shared", when);
    return { ok: true, mode: "gate", synced: cred.synced };
  }

  /**
   * "Also after a restart" (OWNER-DECISIONS/17 Q4): a synced gate credential (a passkey that syncs, added without the
   * opt-in) made a PRF one, with the master password typed again, after the box showed the synced notice (Q2): one get()
   * with a new salt, whose answer must be that credential's (its assertion passes the gate's check with its stored key),
   * with user verification and a PRF output; then the wrap under the current key, the gate's fields gone, the 14 days
   * start, prf_enrolled. No new passkey, none left behind in the provider. Never in a profile declared shared
   * (quick_off). When it was the last gate credential, the gate's arming goes.
   */
  async alsoAfterRestart(password: string, id: string): Promise<Enrolment> {
    if (profileOf(await this.s["settings"].get()) === "shared") throw new ServiceError("quick_off");
    const { keyring, vk } = await this.target(password);
    const rec = forVault(await this.prfs.read(), keyring.vaultId);
    const cred = rec?.creds.find((c) => c.id === id && c.kind === "platform" && c.mode === "gate" && c.synced);
    if (!cred) throw new ServiceError("bad_state", "no such credential");
    // Sixkey's own, under this key (prf.ts gateMac): a planted or paused one is not made persistent here
    if (!(await gateMacOk(vk, keyring.vaultId, cred))) return { ok: false, reason: "refused" };
    const rng = this.s["rng"];
    const salt = newPrfSalt(rng);
    const challenge = rng(32);
    const a = await this.ask({ challenge, allow: [id], prf: { [id]: salt } });
    if (typeof a === "string") return { ok: false, reason: a };
    const origin = this.wa.origin;
    let wrap;
    try {
      const key = { spki: fromB64(cred.publicKey!), alg: cred.alg! };
      if (a.id !== id || !(await gateAssertionOk(a, key, { challenge, origin, rpId: origin })))
        return { ok: false, reason: "refused" };
      // its provider gives no key of its own for Sixkey: it stays what it is, a gate, and the box says why (dvNoPrf)
      if (a.prf?.length !== 32) return { ok: true, mode: "gate", synced: true, refused: "no_prf" };
      wrap = await sealPrfWrap(vk, keyring.vaultId, id, a.prf, rng);
    } finally {
      a.prf?.fill(0);
    }
    const last = rec ? gateCreds(rec, keyring.vkId).every((c) => c.id === id) : false;
    const now = this.s["now"]();
    const saved = await updatePrf(
      this.prfs,
      (r, kr) => {
        const cur = forVault(r, keyring.vaultId);
        if (!cur || !kr || kr.vaultId !== keyring.vaultId || kr.vkId !== vk.id) return undefined;
        const same = (c: PrfCred) => c.id === id && c.mode === "gate" && c.publicKey === cred.publicKey;
        if (!cur.creds.some(same)) return undefined;
        const creds = cur.creds.map((c) => {
          if (!same(c)) return c;
          const { publicKey: _k, alg: _a, mac: _m, ...head } = c;
          return { ...head, mode: "prf" as const, salt: toB64(salt), wrap };
        });
        return { ...cur, creds, lastPasswordAt: now };
      },
      activeKeyring,
    );
    if (!saved) throw new ServiceError("bad_state", "keys changed meanwhile");
    await this.s["record"]("prf_enrolled");
    if (last) await this.dropGateHalf();
    return { ok: true, mode: "prf", synced: true };
  }

  /** "End quick unlock now" in this box too, for one with the gate and no PIN (REVIEW S9): PinAdmin.endQuickUnlock's. */
  async endQuickUnlock(): Promise<void> {
    const had = (await this.s["session"].getQuick()) !== null;
    await this.s["hardLock"]();
    if (had) await this.s["record"]("quick_ended");
  }

  /** What the box shows: one load, one read each of sk_prf, sk_pin and the settings, one of sk_quick. */
  async state(): Promise<DeviceState> {
    const none = { platform: false, shared: false, creds: [], pin: false, armed: false, due: false, full: false };
    const r = await this.s["store"].load();
    if (r.status !== "ok") return { available: "no_vault", ...none };
    const keyring = r.gen.keyring;
    if (!protectedBy(keyring)) return { available: "no_password", ...none };
    if (!this.s["prfs"]) return { available: "off", ...none };
    const shared = profileOf(await this.s["settings"].get()) === "shared";
    const rec = forVault(await this.prfs.read(), keyring.vaultId);
    const pinRaw = await this.s["pins"]?.read();
    const pin = !!pinRaw && pinRaw !== "damaged" && pinRaw.vaultId === keyring.vaultId && pinRaw.vkId === keyring.vkId;
    const q = rec && !shared ? await this.s["session"].getQuick() : null;
    const now = this.s["now"]();
    const gate = rec !== null && gateCreds(rec, keyring.vkId).length > 0;
    const paused = new Set(rec ? pausedCreds(rec, keyring.vkId).map((c) => c.id) : []);
    return {
      available: "ok",
      platform: await this.wa.available(),
      shared,
      creds: (rec?.creds ?? [])
        .filter((c) => c.kind === "platform")
        .map((c) => ({
          id: c.id,
          name: c.name,
          mode: c.mode,
          synced: c.synced,
          createdAt: c.createdAt,
          ...(c.provider ? { provider: c.provider } : {}),
          paused: paused.has(c.id),
        })),
      pin,
      armed:
        gate &&
        !!q &&
        quickLive(q, now) &&
        q.vaultId === keyring.vaultId &&
        q.vkId === keyring.vkId &&
        q.wraps === wrapsTag(keyring),
      due: !!rec && prfCreds(rec, keyring.vkId).length > 0 && !passwordRecent(rec, now),
      full: (rec?.creds.length ?? 0) >= PRF_MAX_CREDS,
    };
  }
}
