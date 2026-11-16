// Unlocking with Touch ID / Windows Hello (QUICK-UNLOCK §5.4 "PRF unlock" and "Gate unlock", Stage 2). Loaded lazily, with
// the ceremony, by the popup, the side panel and the settings page's unlock bar (src/ui/DeviceUnlock.tsx), so none of it,
// nor the crypto and WebAuthn it uses, is in the popup's counted bundle.
//
// It reuses the service's own steps, taken from the service itself by element access (as sync-flows.ts and pin-admin.ts
// do; TypeScript allows it for exactly this): the store and the keys its first read takes (`also`), the session, the
// settings, the clock and random source, the security record, the quick lock, the rules of the record (devicePlan), of the
// session quick unlock (quickUsable, dropIfSame) and finishUnlock, the very end of every unlock. So the session a device
// unlock starts is the password unlock's, with the lock epoch read before the ceremony: a lock during the OS dialog voids
// it. test/unit/m2-source-rules.test.ts allows this access in these files only. It imports no module of the popup's main
// chunk, only lazy ones and the leaf crypto-error.ts (a lazy chunk that does costs the popup's counted bundle:
// docs/design/notes/SHAMIR-NOTES.md §7, PRF-NOTES.md).
//
// Every rule is enforced here, in the service, not by which button a page shows (YR-14): the vault and the key, the 14
// days (Q3), the profile (the gate never in a shared one), the assertion's every clause (assertion.ts). A cancel records
// nothing; a PRF output that does not open its wrap, or an assertion that fails the check, records prf_failed (never
// unlock_failed: it is not a wrong password). The PRF output is zeroed once used; no assertion, challenge or key is kept or
// logged.
import { gateAssertionOk, parseAuthData, UV } from "../crypto/assertion";
import { CryptoError } from "../crypto/crypto-error";
import { credOk } from "../crypto/prf-check";
import type { PrfCred } from "../crypto/prf-record";
import { gateMacOk, openPrfWrap, unb64 } from "../crypto/prf";
import { notePasswordTyped } from "./prf-write";
import type { Vk } from "../crypto/vk";
import type { ViewLoad } from "../storage/store";
import type { ServiceCore, UnlockResult } from "./service-core";
import type { SettingsView } from "./types";
import { WebAuthnError, type Asserted, type WebAuthnPort } from "./webauthn-port";

/**
 * A device unlock's answer. `ok: false`:
 *   - "cancelled": the OS dialog was dismissed, timed out, or refused (a passkey removed in the OS looks the same, by
 *     design): nothing recorded; the master password is one tab stop away;
 *   - "failed": the authenticator's answer did not open Sixkey (recorded: prf_failed), or the ceremony failed otherwise;
 *   - "due": the 14 days are over: the master password once (Q3);
 *   - "paused": the credential's wrap is under an older key: the master password, then "turn back on" in Settings;
 *   - "ended": nothing to unlock with any more (no credential, the gate not armed or expired, a shared profile, no
 *     readable vault);
 *   - "locked": Sixkey locked during the ceremony: the new session was voided.
 */
export type DeviceUnlock =
  ({ ok: true } & UnlockResult) | { ok: false; reason: "cancelled" | "failed" | "due" | "paused" | "ended" | "locked" };

type Loaded = Extract<ViewLoad, { status: "ok" }>;
const no = (reason: Exclude<DeviceUnlock, { ok: true }>["reason"]): DeviceUnlock => ({ ok: false, reason });

export class DeviceUnlocker {
  constructor(
    private readonly s: ServiceCore,
    private readonly wa: WebAuthnPort,
  ) {}

  private quick<T>(fn: () => Promise<T>): Promise<T> {
    return this.s["quickLock"](fn);
  }

  /**
   * The master password has just unlocked Sixkey on this lock screen: its time, for the 14 days of the persistent device
   * unlock (prf-write.ts notePasswordTyped: at most once a day). The lock screen calls it after a master-password unlock,
   * never after a recovery key. Never throws.
   */
  notePasswordTyped(): Promise<void> {
    const prfs = this.s["prfs"];
    return prfs ? notePasswordTyped(prfs, this.s["now"]()) : Promise.resolve();
  }

  /** The ceremony; a WebAuthnError is a cancel ("cancelled") or another failure ("failed"), never recorded. */
  private async ask(o: Parameters<WebAuthnPort["get"]>[0]): Promise<Asserted | "cancelled" | "failed"> {
    try {
      return await this.wa.get(o);
    } catch (e) {
      if (e instanceof WebAuthnError) return e.code === "cancelled" ? "cancelled" : "failed";
      throw e;
    }
  }

  /** The lock epoch, the settings and the store as loadView reads it, the epoch first (a lock after it voids the end). */
  private async begin(): Promise<{ epoch: number; sv: SettingsView; r: Loaded | null }> {
    const epoch = await this.s["session"].lockEpoch();
    const sv = await this.s["settings"].getView();
    const r = await this.s["store"].loadView(this.s["also"]);
    return { epoch, sv, r: r.status === "ok" ? r : null };
  }

  /** The end of a device unlock: the password unlock's (no arming), then the lock epoch read before the ceremony. */
  private async finish(vk: Vk, r: Loaded, sv: SettingsView, epoch: number): Promise<DeviceUnlock> {
    const done = await this.s["finishUnlock"](vk, r, { sv, epoch });
    if ((await this.s["session"].lockEpoch()) !== epoch) {
      await this.s["session"].clear(); // locked during the ceremony: that lock wins
      return no("locked");
    }
    return { ok: true, ...done };
  }

  /**
   * The persistent device unlock (§5.4 "PRF unlock"): one get() for every PRF credential of this vault whose wrap is under
   * the current key, each with its own salt (evalByCredential). In a shared profile too (§5.8: asked at every opening).
   *   1. the lock epoch, the settings, and the store as loadView reads it (sk_prf with the pointer);
   *   2. no credential whose wrap opens this key: "paused" when one waits for "turn back on", else "ended"; nothing
   *      tried, nothing recorded (YUBIKEY §1.2.5);
   *   3. the master password not typed in the last 14 days, or a time "in the future": "due" (Q3, enforced here);
   *   4. the ceremony; the answer must be one of the credentials asked for, with the user verified (UV) and a PRF output;
   *   5. the KEK, the unwrap, the vault key's id; anything wrong: prf_failed recorded, "failed";
   *   6. the same session start as a password unlock, with the epoch of step 1. It never arms the session quick unlock:
   *      the 12 hours count from the root secret, and this unlock needs none.
   */
  async unlockWithPrf(): Promise<DeviceUnlock> {
    const { epoch, sv, r } = await this.begin();
    if (!r) return no("ended");
    const k = r.gen.keyring;
    const plan = this.s["devicePlan"](r, sv.settings, this.s["now"]());
    const creds = plan.prf.filter(credOk); // every field checked before it is used (prf-check.ts)
    if (!creds.length) return no(plan.paused ? "paused" : "ended");
    if (!plan.recent) return no("due");
    const a = await this.ask({
      challenge: this.s["rng"](32),
      allow: creds.map((c) => c.id),
      prf: Object.fromEntries(creds.map((c) => [c.id, unb64(c.salt!)])),
    });
    if (typeof a === "string") return no(a);
    const cred = creds.find((c) => c.id === a.id);
    const flags = parseAuthData(a.authData)?.flags ?? 0;
    let vk: Vk | null = null;
    try {
      if (cred && a.prf && flags & UV)
        vk = await openPrfWrap(cred.wrap!, k.vaultId, cred.id, a.prf, (raw) => this.s["vkOf"](raw));
    } catch (e) {
      if (!(e instanceof CryptoError)) throw e;
    } finally {
      a.prf?.fill(0);
    }
    if (!vk || vk.id !== k.vkId) {
      await this.s["record"]("prf_failed");
      return no("failed");
    }
    return this.finish(vk, r, sv, epoch);
  }

  /**
   * The session gate (§5.4 "Gate unlock"): sk_quick armed for the gate, and a user-verified assertion of one of this
   * vault's gate credentials that Sixkey checks itself (assertion.ts) against the public key it stored.
   *   1. the lock epoch, the settings, the store as loadView reads it;
   *   2. sk_quick: the gate's arming, usable (quickUsable: not past its 12 hours, the clock not set back, the vault, the key
   *      and the wraps still the arming's, the gate still the session method), and a gate credential of this vault and key
   *      in a solo profile (devicePlan) whose MAC checks under the key the arming parked (prf.ts gateMacOk: one written
   *      past Sixkey, a planted public key, is never asked for); else "ended", and the arming deleted if it is still this one;
   *   3. the ceremony with a fresh challenge; the check: the credential asked for, the client data, the RP ID hash, UP and
   *      UV, the signature. Failed: prf_failed recorded, "failed";
   *   4. the arming must still be there (a hard lock, a key change or a removal meanwhile ends it: "ended");
   *   5. the key it parked, its id checked, and the same session start as a password unlock, with the epoch of step 1.
   */
  async unlockWithGate(): Promise<DeviceUnlock> {
    const { epoch, sv, r } = await this.begin();
    const q = await this.quick(() => this.s["session"].getQuick());
    if (!q) return no("ended");
    const held = q.vk;
    const now = this.s["now"]();
    const plan = r ? this.s["devicePlan"](r, sv.settings, now).gates.filter(credOk) : [];
    const parked = await this.s["vkOf"](unb64(held));
    const gates: PrfCred[] = [];
    if (r && parked) for (const c of plan) if (await gateMacOk(parked, r.gen.keyring.vaultId, c)) gates.push(c);
    if (r && !gates.length) {
      // nothing here can answer for the gate (no gate credential, none of Sixkey's own under this key: a planted one,
      // REVIEW-r2 G2): its arming goes, so the lock screen offers no button that can never open (armed anew meanwhile:
      // left alone)
      await this.s["dropIfSame"](q);
      return no("ended");
    }
    if (!r) return no("ended"); // a store that cannot be read now is not the arming's fault: it stays
    if (!this.s["quickUsable"](q, r.gen.keyring, r.also, now)) {
      await this.s["dropIfSame"](q);
      return no("ended");
    }
    const challenge = this.s["rng"](32);
    const a = await this.ask({ challenge, allow: gates.map((c) => c.id) });
    if (typeof a === "string") return no(a);
    const cred = gates.find((c) => c.id === a.id);
    const ok =
      cred !== undefined &&
      (await gateAssertionOk(
        a,
        { spki: unb64(cred.publicKey!), alg: cred.alg! },
        { challenge, origin: this.wa.origin, rpId: this.wa.origin },
      ));
    if (!ok) {
      await this.s["record"]("prf_failed");
      return no("failed");
    }
    const still = await this.quick(async () => {
      const cur = await this.s["session"].getQuick();
      return !!cur && cur.vk === held && cur.armedAt === q.armedAt && cur.vkId === q.vkId && cur.wraps === q.wraps;
    });
    const vk = still ? parked : null;
    if (!vk || vk.id !== q.vkId || vk.id !== r.gen.keyring.vkId) return no("ended");
    return this.finish(vk, r, sv, epoch);
  }
}
