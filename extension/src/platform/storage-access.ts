// Storage access level (TOTP-AUTOFILL §4.2 items 2 and 3). By default `chrome.storage.local` is readable and writable from
// content scripts as well as from the extension's own pages, and `chrome.storage.session` is not. The vault's slots,
// snapshots, keyring (sk_keyring) and PIN record (sk_pin) are in storage.local, and the unlocked key is in
// storage.session, so both areas are set to TRUSTED_CONTEXTS (extension pages and the service worker only). Nothing here
// may ever pass the other level, TRUSTED_AND_UNTRUSTED_CONTEXTS (test/unit/autofill-pre-storage.test.ts reads the source).
//
// storage.session is set explicitly as well as being the default: the call is cheap and idempotent, and it means the
// two areas are closed by the same code, so a later default change or a stray write of the other level is undone at the
// next start. `storage.local.setAccessLevel` exists only from Chrome 140 (Chromium commit a8f1f337), which is why Sixkey
// needs Chrome 140 or later (manifest.base.json minimum_chrome_version since wave 1b of the plugin platform:
// OWNER-DECISIONS/14 OQ1 (a)); before it, storage.local could not be closed to content scripts at all. The gate below
// stays as a second layer: a browser that still refuses the call (another Chromium, a policy, a regression) gets no
// injection. storage.session is closed by default on every version. The call is made at every worker start, not only on install, and a failure is returned, never
// thrown: the worker must still start. src/background/storage-access-first.ts calls this at load time and reports a
// failure to the diagnostics log. And because a page that Sixkey's script ran in could otherwise read and write
// storage.local, nothing is injected into a page unless both calls succeed just then: `storageClosed`, the gate that
// src/platform/autofill.ts (the only caller of chrome.scripting) awaits before every injection (STORAGEGATE).

/** The part of a storage area this needs. */
export type AccessArea = { setAccessLevel(o: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void> };
export type AccessAreas = { local?: AccessArea; session?: AccessArea; sync?: AccessArea };
/** Per area: whether the browser accepted the level. A missing area or API, or a rejection, is `false`. */
export type AccessResult = { local: boolean; session: boolean };

async function restrict(area: AccessArea | undefined): Promise<boolean> {
  try {
    if (!area) return false;
    await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); // a synchronous throw lands in the catch too
    return true;
  } catch {
    return false;
  }
}

/** Both calls are made at once, before any other work, and each one's failure leaves the other alone. */
export function restrictStorageAccess(
  storage: AccessAreas | undefined = globalThis.chrome?.storage,
): Promise<AccessResult> {
  return Promise.all([restrict(storage?.local), restrict(storage?.session)]).then(([local, session]) => ({
    local,
    session,
  }));
}

/** How long the gate waits for the browser's answer: a call that has not settled by then counts as a refusal. */
export const GATE_MS = 5000;

/**
 * storage.sync, where the backup in Chrome's sync storage keeps the encrypted vault (platform/csb-area.ts), is open to
 * content scripts by default, as storage.local was: they could read the copy and delete it. Closed the same way, by
 * this one function, apart from the other two: autofill's gate (closedBy, storageClosed) is about storage.local and
 * storage.session only, so no browser loses autofill over the sync area. Chromium 145 and 156 accept it and a content
 * script's read of the area is then refused; in 156 (test/e2e/csb-probe.spec.ts) its writes and its onChanged too,
 * the extension's own contexts still read and write it, and the level outlives a restart of the browser.
 * `true` only if the browser accepted the level within `ms` (GATE_MS, as closedBy waits): a refusal, a throw, a missing
 * API or area, or no answer in time is `false`, and this never rejects. The worker calls it at every start, beside the
 * other two (background/storage-access-first.ts), and runs the backup only on `true`; on `false` the backup does not run
 * or turn on in that worker's life, and the worker writes a diagnostics line (the maintainers' C7).
 */
export async function restrictSyncAccess(
  storage: AccessAreas | undefined = globalThis.chrome?.storage,
  ms: number = GATE_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((done) => (timer = setTimeout(() => done(false), ms)));
  try {
    return await Promise.race([restrict(storage?.sync), late]);
  } catch {
    return false; // (reaching storage.sync threw: a getter of a strange host; still a no, never a rejection)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The gate before any script of Sixkey's goes into a page: `true` only if the browser accepted TRUSTED_CONTEXTS for BOTH
 * storage.local and storage.session, asked now, within GATE_MS. A missing API (storage.local's before Chrome 140, which the
 * manifest no longer allows: a second layer), a throw, a rejection, no answer in time: `false`. Nothing is remembered (a later call asks again): an answer cannot
 * outlive a worker restart or a browser update, and the call is idempotent and cheap. It runs in the context that injects
 * (the popup, the side panel or the worker: each is a trusted context that may make the call).
 */
export async function storageClosed(): Promise<boolean> {
  try {
    return await closedBy(restrictStorageAccess());
  } catch {
    return false; // (a throw while reaching chrome.storage: not expected; still a no, never a rejection of the caller)
  }
}

/**
 * The gate's rule over an answer already asked for: both areas accepted, within GATE_MS of this call; anything else is
 * `false`, and this never rejects. storageClosed asks now; the worker's reconcile of autofill's sites
 * (platform/autofill-reconcile.ts) applies it to the call its own start made (background/storage-access-first.ts),
 * which an answer cannot outlive: every worker start asks again.
 */
export async function closedBy(answer: Promise<AccessResult>, ms: number = GATE_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)));
  try {
    const r = await Promise.race([answer, late]);
    return r !== null && r.local && r.session;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
