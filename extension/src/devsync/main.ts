// The developer sync page: dev and e2e builds only. scripts/build.mjs leaves it out of a prod build (and fails one whose
// module graph reaches it), and scripts/check-dist.mjs fails a prod build that contains it. The settings page's Sync
// section (M6) is how users turn sync on; this page stays for the end-to-end tests that drive the engine's flows directly
// (test/regression/network.spec.ts, test/sync/), and for the approving side of an approval join until the section has
// it (approverList, approverStart, approverPairingCode, approverPoll, approverSas), so a test can approve a device that
// joins through the section.
//
// It runs the engine in a page exactly as the settings page will (platform/sync-engine.ts over the page's runtime, the
// bridge to the service worker for the network), and offers the engine's own flows to the console and to end-to-end
// tests as globalThis.sixkeyDevSync. No shortcut and no test hook: turning sync on is §3.1's first upload or §3.3's
// recovery-code join, against whichever server the build's API origin names. The account session stays in this page's
// memory; nothing it returns holds a key, a token or an account name, and the only code it returns is the pairing code
// that the approving screen would show (approverPairingCode, for the console and the tests of this dev and e2e page).
//
// The API host permission (§4.9, §7; revision 21) is handled as the settings page will (M5-NOTES, the hand-off to M6):
// asked for by a click (the "Grant API access" button: requestApiPermission is the first thing its handler does, before
// any await), removed when turning sync off, and removed when a first upload or a join ends any way but "done" or
// "unconfirmed" (an exception, or a result such as vault_exists or keyring_changed) while sync is not on. The e2e build
// declares it as required: always granted, and removing it does nothing.
import type { AccountSession } from "../core/sync/engine/api";
import { Approver, commitJoin, firstUpload, joinWithRecoveryCode } from "../core/sync/engine/enroll";
import { turnSyncOff } from "../core/sync/engine/keys";
import { apiPermissionGranted, removeApiPermission, requestApiPermission } from "../platform/api-permission";
import { BridgeTransport, SYNC_CHANGED_MESSAGE } from "../platform/bridge-page";
import { createRuntime } from "../platform/runtime";
import { createSyncEngine } from "../platform/sync-engine";

/** The marker check-dist looks for (and refuses in a prod build). */
const MARKER = "sixkey-dev-sync";

const rt = createRuntime();
const { engine } = createSyncEngine({ rt, transport: new BridgeTransport() });
let session: AccountSession | null = null;
let approver: Approver | null = null;
/** The page's one approval ends (its machine and the pairing secret with it, MUST 10) at a new pick and when the page goes. */
const dropApprover = (): void => {
  approver?.discard();
  approver = null;
};
globalThis.addEventListener?.("pagehide", dropApprover);

/** The worker brings the badge and its periodic alarm up to date after this page changed sync's state. */
const changed = (): Promise<unknown> =>
  chrome.runtime.sendMessage({ type: SYNC_CHANGED_MESSAGE }).catch(() => undefined);

function signedIn(): AccountSession {
  if (!session) throw new Error("not signed in: requestCode, then signIn");
  return session;
}

/** The permission back, unless sync is on now (§7). */
async function giveBack(): Promise<void> {
  if (!(await engine.view()).syncOn) await removeApiPermission();
}

/**
 * An enable or join flow keeps the permission only when it ended as "done" or "unconfirmed" (whose next round finishes
 * it); every other outcome, a result or an exception, gives it back (§7; the M6 rule, M5-NOTES §12).
 */
async function enabling<T>(flow: () => Promise<T>, kept: (r: T) => boolean): Promise<T> {
  let r: T;
  try {
    r = await flow();
  } catch (e) {
    await giveBack();
    throw e;
  }
  if (!kept(r)) await giveBack();
  return r;
}
const KEPT: ReadonlySet<string> = new Set(["done", "unconfirmed", "enrolled"]);

const devSync = Object.freeze({
  marker: MARKER,
  /** Unlocks the vault in this page (needed in "lock every time" mode, where the key lives only in a page). */
  async unlock(password: string): Promise<void> {
    await rt.service.unlockWithPassword(password);
  },
  /** §5.2: asks the server to mail a one-time code (the dev server's FakeAuthProvider writes it to its inbox file). */
  async requestCode(email: string): Promise<void> {
    await engine.api.otp(email);
  },
  /** The account session from the code (api.signIn), kept in this page only. Returns when it expires. */
  async signIn(email: string, code: string): Promise<{ expiresAt: number }> {
    const s = await engine.api.signIn(email, code);
    session = { token: s.token, sub: s.sub };
    return { expiresAt: s.expiresAt };
  },
  signOut(): void {
    session = null;
  },
  /** §3.1: this profile's vault becomes the account's first vault. */
  async firstUpload(o: { password: string; recoveryCode: string; deviceName: string; email: string }): Promise<string> {
    const r = await enabling(
      () => firstUpload(engine, { session: signedIn(), ...o }),
      (x) => KEPT.has(x.kind),
    );
    await changed();
    return r.kind;
  },
  /** §3.3: this profile joins the account's vault with the recovery code. */
  async joinWithRecoveryCode(o: { recoveryCode: string; deviceName: string; email: string }): Promise<string> {
    const r = await enabling(
      async () => commitJoin(await joinWithRecoveryCode(engine, { session: signedIn(), ...o })),
      (x) => KEPT.has(x),
    );
    await changed();
    return r;
  },
  /** One round in this page (§4.2), as the user's "sync now". */
  async round(): Promise<{
    status: string;
    keyStatus?: string;
    pulled: boolean;
    merged: boolean;
    uploaded: boolean;
    pushedOutbox: boolean;
    error?: string;
  }> {
    const r = await engine.round({ explicit: true });
    await changed();
    return {
      status: r.status,
      ...(r.keyStatus ? { keyStatus: r.keyStatus } : {}),
      pulled: r.pulled,
      merged: r.merged,
      uploaded: r.uploaded,
      pushedOutbox: r.pushedOutbox,
      ...(r.error ? { error: r.error } : {}),
    };
  },
  /** What the sync panel would show (§6 O12): states, counts and codes only. */
  async view(): Promise<Record<string, unknown>> {
    const v = await engine.view();
    const s = v.state;
    return {
      syncOn: v.syncOn,
      status: s.status ?? null,
      keyStatus: s.keyStatus ?? null,
      lastErrorCode: s.lastErrorCode ?? null,
      failures: s.failures ?? 0,
      backoffUntil: s.backoffUntil ?? null,
      lastOkAt: s.lastOkAt ?? null,
      pendingEnrollments: s.pendingEnrollments ?? 0,
      serverOffsetMs: v.offsetMs,
      synced: v.lastSynced !== null,
      outbox: v.outbox !== null,
      mergeOnly: v.mergeOnly !== null,
      orphans: v.orphans.length,
      notices: (s.notices ?? []).map((n) => n.kind),
      apiPermission: await apiPermissionGranted(),
    };
  },
  /** §3.2 M2, the approving side: the open requests (ids, times and states only). */
  async approverList(): Promise<{ id: string; state: string }[]> {
    return (await Approver.list(engine)).map((r) => ({ id: r.request_id, state: r.state }));
  },
  /** §3.2 M2: picks request `rid` with the master password (the pre-send check, respond). */
  async approverStart(rid: string, password: string): Promise<void> {
    dropApprover();
    approver = await Approver.start(engine, rid, password);
  },
  /** §3.2 M2: the pairing code the approving screen shows once respond was accepted, to type on the new device. */
  approverPairingCode(): string {
    if (!approver) throw new Error("no request picked: approverStart first");
    return approver.pairingCode;
  },
  /** §3.2 M4: one poll of the picked request ("enter_sas" once the new device revealed; pairing_mismatch rejects it). */
  async approverPoll(password: string): Promise<string> {
    if (!approver) throw new Error("no request picked: approverStart first");
    const step = await approver.poll(password);
    return step.kind === "failed" ? `failed:${step.reason}` : step.kind;
  },
  /** §3.2 M4/M5: the six digits the new device shows; on a match, the approval is sent. */
  async approverSas(sas: string, password: string): Promise<{ kind: string }> {
    if (!approver) throw new Error("no request picked: approverStart first");
    return { kind: (await approver.submitSas(sas, password)).kind };
  },
  /** §3.10: revokes this device (with the master password) and turns sync off here, keeping the local vault. */
  async turnSyncOff(password: string): Promise<void> {
    await turnSyncOff(engine, password);
    await removeApiPermission(); // last, once sync is off (§3.10)
    await changed();
  },
});

Object.defineProperty(globalThis, "sixkeyDevSync", { value: devSync });
const out = document.getElementById("out")!;
document.getElementById("grant")!.addEventListener("click", () => {
  void requestApiPermission().then(
    (ok) => {
      out.textContent = `API access: ${ok ? "granted" : "declined"}`;
    },
    () => {
      out.textContent = "API access: not asked";
    },
  );
});
document.getElementById("revoke")!.addEventListener("click", () => {
  void removeApiPermission().then((ok) => {
    out.textContent = `API access: ${ok ? "removed" : "not removed"}`;
  });
});
out.textContent = `${MARKER}: ready`;
