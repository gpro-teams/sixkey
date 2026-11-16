// The grant store's reads and writes (the records: grants.ts). It holds the built-in autofill's switch. Until the
// plugin platform was removed it held every plugin's approval as well; the plugin SDK's specification of it is in the
// history before that removal (docs/audit/README.md lists the removed paths; the section numbers in this file are
// its own), and docs/design/proposals/MOD-PLATFORM.md keeps its design. Every write is one critical section under the
// vault lock (webLock("sixkey-vault")), so that it never interleaves with another context's write, nor with a key
// change's commit; nothing inside it calls the vault store or the service.
//   - A tagged write (the switch, and the merge of the overlay) needs the vault key. Its order is what makes a crash at
//     any point safe (test/fault/plugin-grants-crash.test.ts): the new record first; then the session's epoch; then the
//     overlay it merged taken out; then the record an earlier version kept aside, removed. A crash between any two
//     steps leaves either the old record and everything it needs, or the new one with a stale overlay entry, which is
//     harmless (it is older than the entry's last loosening, grants.ts withOverlay), or a kept record that the next
//     write removes.
//   - Without the key (locked) nothing is written but an overlay entry, which can only tighten (beforeNewVault). The
//     worker holds the session's key while unlocked: the built-in autofill's gate uses it for its verified read, which,
//     like any verified read, may merge a pending overlay: a tagged write (platform/plugins/autofill-gate.ts).
//   - A tag that does not verify (a damaged or forged record, a rollback, a record of another vault) never wipes the
//     user's Off: nothing else is drawn from it, the record stays as it is, and the next tagged write starts a new
//     record, which keeps the built-in autofill's Off if the failed one said Off (read from it tighten-only).
//   - A key change: a read verifies under the current vault key only. A previous key counts only inside the key-change
//     cleanup: the one cleanup entry point (service-core.ts finishKeyChanges) calls reencrypt() below as one of its
//     VkRecords (platform/runtime-base.ts), right after the change in the context that made it, or at the next unlock
//     or open if that was cut short; the record is re-tagged under the new key there. A record that misses it (a copy
//     restored from elsewhere) does not verify, as above. A tagged write checks two things inside its lock, both read
//     straight from the vault's storage:
//       - the key it was given is still the vault's active one (GrantKeys.activeVkId): a write that raced a key change,
//         between the caller's grantKeys() and the write, is refused (StaleKeyError) and writes nothing, so it never
//         leaves a record under a retired key; the caller asks for the key again;
//       - a record that does not verify under that key while the change's cleanup is still due
//         (GrantKeys.cleanupPending) is one the cleanup has yet to re-tag, not a failed one: the write is refused
//         (CleanupPendingError) and writes nothing, rather than start a new record that loses the user's switch; the
//         caller waits a moment and tries again, a bounded number of times (withFreshKeys), then tells the user to.
//   - The grant store's own tests keep every plugin's entries (StoreDeps.entries "all"), as the store did before, so
//     that its rules for a record of many entries stay held. There a failed record is kept aside
//     (sk_plugins_unverified) before the new one is written, and listed for review.
import type { Vk } from "../crypto/vk";
import type { KV, Lock } from "../storage/kv";
import { autofillOn, autofillSwitched, isBuiltin } from "./builtin";
import {
  emptyBody,
  EPOCH_KEY,
  grantKey,
  GRANTS_KEY,
  looseEntries,
  overlayWith,
  OVERLAY_KEY,
  parseOverlay,
  parsePauses,
  parseRecord,
  PAUSES_KEY,
  seal,
  UNVERIFIED_KEY,
  verify,
  withOverlay,
  type GrantBody,
  type GrantEntry,
  type GrantRecord,
  type Pause,
} from "./grants";

/** The same developer mode and plugins (a write that would change nothing: GrantStore.write `onlyVerifiedChange`). */
const sameBody = (a: GrantBody, b: GrantBody): boolean =>
  a.developerMode === b.developerMode && JSON.stringify(a.plugins) === JSON.stringify(b.plugins);

export type StoreDeps = {
  /** chrome.storage.local: sk_plugins, sk_plugins_overlay, sk_plugins_unverified. */
  local: KV;
  /** chrome.storage.session: the epoch and the pauses. */
  session: KV;
  /** webLock("sixkey-vault"). */
  lock: Lock;
  now?: () => number;
  /**
   * Whose entries the store returns and keeps: the built-in autofill's alone (the default, what every build uses since
   * the plugin platform was removed: builtinOnly below), or every plugin's, as it did before (the grant store's own
   * tests, which hold its rules for a record of many entries).
   */
  entries?: "builtin" | "all";
};

/** A tagged write given a vault key that a key change has retired since (N2): nothing was written; ask for it again. */
export class StaleKeyError extends Error {
  constructor() {
    super("the vault key changed since it was read");
    this.name = "StaleKeyError";
  }
}

/**
 * A tagged write that met a record its key does not verify while a key change's cleanup has yet to re-tag it (W2A-01):
 * nothing was written; it can succeed once the cleanup is done.
 */
export class CleanupPendingError extends Error {
  constructor() {
    super("a key change is still being finished");
    this.name = "CleanupPendingError";
  }
}

/** The waits before each new try of a write that met a pending cleanup (CleanupPendingError): five, 3.1 s in all. */
export const CLEANUP_WAITS: readonly number[] = [100, 200, 400, 800, 1600];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `op` with the key `get` gives now (the context's grantKeys), tried again only where nothing was written: once more
 * with a fresh key if a key change retired it meanwhile (StaleKeyError, N2), and after each of CLEANUP_WAITS while that
 * change's cleanup has yet to re-tag the record (CleanupPendingError, W2A-01). Then, or on any other error, the error is
 * thrown: at most 1 + 1 + 5 tries, never more. null while locked: `op` is not run. `wait`: for tests.
 */
export async function withFreshKeys<T>(
  get: () => Promise<GrantKeys | null>,
  op: (k: GrantKeys) => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T | null> {
  let stale = 0;
  let pending = 0;
  for (;;) {
    const k = await get();
    if (!k) return null;
    try {
      return await op(k);
    } catch (e) {
      if (e instanceof StaleKeyError && stale++ < 1) continue;
      if (!(e instanceof CleanupPendingError) || pending >= CLEANUP_WAITS.length) throw e;
      await wait(CLEANUP_WAITS[pending++]!);
    }
  }
}

/**
 * After a tagged write that withFreshKeys gave up on with CleanupPendingError (W2A-01): the clean-up an open of Sixkey's
 * popup runs (`openView`'s housekeeping: the one cleanup entry point, under the vault lock, idempotent, as when two pages
 * open at once), run here once, so that the user's next try can land, also after a clean-up a closed page cut short (W2a
 * r3). Only while Sixkey is unlocked here (the session holds the key); the refused write is not tried again, the user
 * does that. Never rejects.
 */
export async function runPendingCleanup(rt: {
  service: { grantKeys(): Promise<GrantKeys | null>; openView(): Promise<unknown> };
}): Promise<void> {
  try {
    if (await rt.service.grantKeys()) await rt.service.openView();
  } catch {
    // the next open or unlock runs it
  }
}

/**
 * The vault key a context holds (service-core.ts grantKeys), and two readings straight from the vault's storage, with no
 * lock of their own (a tagged write calls them inside the vault lock it holds): the active key's ID (a write is refused
 * when the key it was given is not that one: N2), and whether a key change's cleanup is still due (a record that does
 * not verify is then not rewritten: W2A-01). Absent only in tests of the records themselves.
 */
export type GrantKeys = { vk: Vk; activeVkId?: () => Promise<string>; cleanupPending?: () => Promise<boolean> };

/** What the key-change cleanup's reencrypt found (service-core.ts VkRecordResult). */
export type ReencryptResult = "absent" | "current" | "rewritten" | "unopenable" | "superseded";

/** What a context that holds the vault key sees (§6.6 item 3). */
export type Verified =
  | {
      ok: true;
      /** The entries, the overlay applied. */
      plugins: GrantEntry[];
      developerMode: boolean;
      pauses: Pause[];
      /** A failed record's other plugins, kept for review (not honoured, not drawn), minus those approved since. */
      review: GrantEntry[];
    }
  | {
      ok: false;
      /** The record's plugins that parse one by one, and those of a record kept aside before: listed for review only. */
      review: GrantEntry[];
      pauses: Pause[];
    };

/** What any context may use without the key: hello, env.get (§6.6 item 3). Never drawn. */
export type Unverified = { plugins: GrantEntry[]; pauses: Pause[] };

const intOr0 = (x: unknown) => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : 0);

/**
 * The entries this version honours: the built-in autofill's alone. The plugin platform was removed on 2026-11-12: an
 * entry an earlier version stored for another plugin still reads (the record's tag covers it, so the record verifies as
 * before and autofill's switch is read from it as before), is returned by no read, so nothing honours or draws it, and
 * is left out of the next record written. The overlay's and the pauses' entries for it go the same way.
 */
export const builtinOnly = <T extends { pluginId: string }>(entries: readonly T[]): T[] =>
  entries.filter((e) => isBuiltin(e.pluginId));

export class GrantStore {
  private readonly now: () => number;
  /** Every plugin's entries kept, and a failed record kept aside for review (StoreDeps.entries "all": tests only). */
  private readonly all: boolean;
  /** The entries a read returns and a write keeps (StoreDeps.entries). */
  private readonly keep: <T extends { pluginId: string }>(entries: readonly T[]) => T[];
  constructor(private readonly d: StoreDeps) {
    this.now = d.now ?? Date.now;
    this.all = d.entries === "all";
    this.keep = this.all ? (entries) => [...entries] : builtinOnly;
  }

  /** The record without its tag checked, the overlay applied: for `hello` and `env.get` only (§6.6 item 3). */
  async unverified(): Promise<Unverified> {
    const [l, s] = await Promise.all([this.d.local.get([GRANTS_KEY, OVERLAY_KEY]), this.d.session.get([PAUSES_KEY])]);
    const rec = parseRecord(l[GRANTS_KEY]);
    const entries = rec && rec !== "damaged" ? rec.plugins : looseEntries(l[GRANTS_KEY]);
    return {
      plugins: this.keep(withOverlay(entries, parseOverlay(l[OVERLAY_KEY]))),
      pauses: this.keep(parsePauses(s[PAUSES_KEY])),
    };
  }

  /**
   * The record verified with the vault key (§6.6 item 3): its tag, under the current key, and an epoch no older than
   * this session's. A pending overlay is merged into it then (the next unlock's
   * merge, §6.6 item 4), and the session's epoch is raised to the record's.
   */
  async read(keys: GrantKeys): Promise<Verified> {
    const key = await grantKey(keys.vk.raw);
    const [l, s] = await Promise.all([
      this.d.local.get([GRANTS_KEY, OVERLAY_KEY, UNVERIFIED_KEY]),
      this.d.session.get([EPOCH_KEY, PAUSES_KEY]),
    ]);
    const pauses = this.keep(parsePauses(s[PAUSES_KEY]));
    const kept = this.keep(looseEntries(l[UNVERIFIED_KEY]));
    const rec = parseRecord(l[GRANTS_KEY]);
    if (rec === null) {
      // nothing to apply an overlay to
      if (l[OVERLAY_KEY] !== undefined) await this.d.lock(() => this.d.local.remove([OVERLAY_KEY]));
      return { ok: true, plugins: [], developerMode: false, pauses, review: kept };
    }
    const epoch = intOr0(s[EPOCH_KEY]);
    if (rec === "damaged" || rec.epoch < epoch || !(await verify(key, rec))) {
      const mine = this.keep(looseEntries(l[GRANTS_KEY]));
      return {
        ok: false,
        review: [...mine, ...kept.filter((k) => !mine.some((m) => m.pluginId === k.pluginId))],
        pauses,
      };
    }
    let body: GrantBody = rec;
    if (l[OVERLAY_KEY] !== undefined) {
      // merged under the lock, from what is stored then (the plain transition: no change but the overlay's)
      body = await this.write(keys, (b) => b);
    } else if (rec.epoch > epoch) await this.d.lock(() => this.raiseEpoch(rec.epoch));
    return {
      ok: true,
      plugins: this.keep(body.plugins),
      developerMode: body.developerMode,
      pauses,
      review: kept.filter((k) => !body.plugins.some((p) => p.pluginId === k.pluginId)),
    };
  }

  /**
   * The key-change cleanup's part (§6.6 item 6; the VkRecord contract, service-core.ts): the record moved to `current`
   * if it verifies under one of `held`, the old keys the cleanup holds. One critical section under the vault lock with
   * the check that the vault's active key is still `current` (`activeVkId`, read straight from the slots), and nothing
   * in it calls the vault store or the service. A damaged record, one older than this session's epoch (a rollback, §6.6
   * item 5) or one under no held key is "unopenable" and left as it is: it never holds the cleanup's marker up, and
   * Settings asks to review it. Only a storage call that fails throws (the cleanup then keeps its marker).
   */
  reencrypt(current: Vk, held: readonly Vk[], activeVkId: () => Promise<string>): Promise<ReencryptResult> {
    return this.d.lock(async () => {
      const rec = parseRecord((await this.d.local.get([GRANTS_KEY]))[GRANTS_KEY]);
      if (rec === null) return "absent";
      if ((await activeVkId()) !== current.id) return "superseded"; // a newer key change's own cleanup moves it
      if (rec === "damaged") return "unopenable";
      const key = await grantKey(current.raw);
      if (await verify(key, rec)) return "current";
      const epoch = intOr0((await this.d.session.get([EPOCH_KEY]))[EPOCH_KEY]);
      if (rec.epoch < epoch) return "unopenable";
      for (const old of held) {
        if (old.id === current.id || !(await verify(await grantKey(old.raw), rec))) continue;
        const next = await seal(key, {
          v: 1,
          epoch: rec.epoch + 1,
          developerMode: rec.developerMode,
          plugins: rec.plugins,
        });
        await this.d.local.set({ [GRANTS_KEY]: next });
        await this.raiseEpoch(next.epoch);
        return "rewritten";
      }
      return "unopenable";
    });
  }

  /**
   * A new vault (service.ts makeVault, after its commit: the first run, a backup restored, Start over; W2a r3, the r2
   * review's R2-01). Its key is new, so no record left beside it verifies under it, and no clean-up can re-tag one (no
   * key of the new vault opens it); left there, a full marker that a write over lost data leaves until the first open
   * would refuse every approval meanwhile. A record that does not verify under `keys` is set aside here the way a tagged
   * write sets aside a record that fails: kept in sk_plugins_unverified, its plugins listed for review and never honoured
   * (merged into what is kept there already, so that none of them is dropped; if this step is cut short the first
   * tagged write merges them in its turn, W2b R3-01), then a new record under the new key in
   * its place, holding only the built-in autofill's Off if the user had turned it off (N-01), the overlay merged into it
   * and removed. A record that verifies, and no record, are left as they are. Two steps, each crash-safe: a crash between
   * them leaves the merged list kept and the old record, which the next tagged write sets aside in turn. Only a storage
   * call that fails throws. That is where every plugin's entries are kept (the store's tests); by default nothing is
   * kept aside: the new record takes the old one's place, and what an earlier version kept aside is removed (write).
   */
  async newVault(keys: GrantKeys): Promise<"absent" | "current" | "set aside"> {
    const key = await grantKey(keys.vk.raw);
    const verdict = await this.d.lock(async () => {
      const l = await this.d.local.get([GRANTS_KEY, UNVERIFIED_KEY]);
      const rec = parseRecord(l[GRANTS_KEY]);
      if (rec === null) return "absent" as const;
      if (rec !== "damaged" && (await verify(key, rec))) return "current" as const;
      // 1. (every plugin's entries kept) its plugins kept for review beside any kept before (a tagged write merges them
      // the same way); by default nothing is kept, and the write below removes what an earlier version kept
      if (this.all && l[UNVERIFIED_KEY] !== undefined) {
        const kept = looseEntries(l[UNVERIFIED_KEY]);
        const now = looseEntries(l[GRANTS_KEY]);
        const plugins = [...now, ...kept.filter((k) => !now.some((e) => e.pluginId === k.pluginId))];
        await this.d.local.set({ [UNVERIFIED_KEY]: { v: 1, plugins } });
      }
      return "set aside" as const;
    });
    if (verdict !== "set aside") return verdict;
    // 2. the failed record kept (if nothing was), a new one under the new key; not asked about a pending clean-up
    await this.write({ vk: keys.vk, ...(keys.activeVkId ? { activeVkId: keys.activeVkId } : {}) }, (b) => b);
    return verdict;
  }

  /**
   * Before a new vault is committed under `next` (service.ts makeVault; docs/design/notes/CLOUD-PLUGIN-NOTES.md §3.5): a
   * record left beside it that `next` does not verify (always, in practice: a new vault has a new key) keeps every
   * approval it holds until newVault, after the commit, sets it aside; a newVault cut short (a page closed, a write that
   * failed) would leave them there, honoured by every reader of the record without its tag (unverified: hello and
   * env.get). So each of its plugins but the built-in ones is removed
   * now, through the overlay, which only tightens and needs no key: honoured at once in every lock state, and merged into
   * nothing by the new record newVault writes, which takes it out. The record itself is left as it is, and so is the
   * review list made from it (the overlay is not applied to what is kept for review: those plugins can be approved
   * again), and the built-in autofill's switch, which the new record keeps (N-01).
   *
   * Only while there is still no vault to make it over: `noVault`, the slots read straight under this lock (the vault
   * store's own, "sixkey-vault": no vault can be committed meanwhile), says there is none readable, as makeVault found
   * (empty, or lost). A vault there now (another page made one since makeVault looked, and may have approved a plugin
   * under it: the second review's N2-2 (b)) is "vault": nothing written, and makeVault's commit refuses in its turn.
   * Should the vault not be committed after all, the removals stay: they only tighten, over a vault that was unreadable
   * or absent, and they apply as well to a vault later restored under the same key, whose record then verifies (the
   * same review's N2-2 (a)): its plugins are removed at its first tagged write, and approved again as new ones (the
   * same approval screen as any other).
   * A record that verifies, and no record: nothing written, and the slots not read. Only a storage call that fails
   * throws, `noVault`'s included.
   */
  async beforeNewVault(
    next: Vk,
    noVault: () => Promise<boolean>,
  ): Promise<"absent" | "current" | "vault" | "withdrawn"> {
    const key = await grantKey(next.raw);
    return this.d.lock(async () => {
      const l = await this.d.local.get([GRANTS_KEY, OVERLAY_KEY]);
      const rec = parseRecord(l[GRANTS_KEY]);
      if (rec === null) return "absent" as const;
      if (rec !== "damaged" && (await verify(key, rec))) return "current" as const;
      if (!(await noVault())) return "vault" as const;
      let overlay = parseOverlay(l[OVERLAY_KEY]);
      const left = withOverlay(rec === "damaged" ? looseEntries(l[GRANTS_KEY]) : rec.plugins, overlay).filter(
        (e) => !isBuiltin(e.pluginId),
      );
      if (left.length === 0) return "withdrawn" as const;
      // newer than each entry's last loosening, or withOverlay would take the removal for a stale one
      const at = Math.max(this.now(), ...left.map((e) => e.approvedAt + 1));
      for (const e of left) overlay = overlayWith(overlay, { pluginId: e.pluginId, action: "remove", at });
      await this.d.local.set({ [OVERLAY_KEY]: { v: 1, entries: overlay } });
      return "withdrawn" as const;
    });
  }

  /** The session's epoch raised to `e` (never lowered). Under the lock. */
  private async raiseEpoch(e: number): Promise<void> {
    const cur = intOr0((await this.d.session.get([EPOCH_KEY]))[EPOCH_KEY]);
    if (e > cur) await this.d.session.set({ [EPOCH_KEY]: e });
  }

  /**
   * One tagged write: `change` applied to the verified record with the overlay merged (or, when the stored record does
   * not verify, to a new, empty one that keeps the built-in autofill's Off). The order of the steps is the crash safety
   * (above). Only the entries the store keeps (StoreDeps.entries) are written: by default another plugin's entry is
   * left out both of what `change` is given and of what it gives back, so no record this version writes holds one,
   * whatever `change` adds (plugins-retired.test.ts). A record an earlier version kept aside (sk_plugins_unverified) is
   * removed then, and none is kept; where every plugin's entries are kept (the store's tests), the failed record is
   * kept aside first, merged into any kept before.
   * `onlyVerifiedChange`: written only over a record that verifies, and only when `change` changes it; otherwise
   * nothing is written and nothing set aside (a record that does not verify stays as it is), and it resolves to null.
   * No write of this version asks for it: it was the plugin platform's book-keeping (trash marks), and the store's
   * tests hold it. A key change's cleanup still due refuses it as any other write (CleanupPendingError).
   */
  write(keys: GrantKeys, change: (b: GrantBody) => GrantBody): Promise<GrantRecord>;
  write(
    keys: GrantKeys,
    change: (b: GrantBody) => GrantBody,
    o: { onlyVerifiedChange: true },
  ): Promise<GrantRecord | null>;
  async write(
    keys: GrantKeys,
    change: (b: GrantBody) => GrantBody,
    o: { onlyVerifiedChange?: true } = {},
  ): Promise<GrantRecord | null> {
    const key = await grantKey(keys.vk.raw);
    return this.d.lock(async () => {
      // the key is still the vault's: a key change committed since the caller read it retired it (N2). Under the lock,
      // so no key change can commit between this check and the write below (it takes the same lock)
      if (keys.activeVkId && (await keys.activeVkId()) !== keys.vk.id) throw new StaleKeyError();
      const [l, s] = await Promise.all([
        this.d.local.get([GRANTS_KEY, OVERLAY_KEY, UNVERIFIED_KEY]),
        this.d.session.get([EPOCH_KEY]),
      ]);
      const epoch = intOr0(s[EPOCH_KEY]);
      const rec = parseRecord(l[GRANTS_KEY]);
      const ok = rec !== null && rec !== "damaged" && rec.epoch >= epoch && (await verify(key, rec)) ? rec : null;
      const good = ok !== null;
      // not verified, while the key change's cleanup has yet to re-tag the record: written now, from an empty record, it
      // would put every other plugin up for review (W2A-01). Nothing is written; the caller tries again in a moment
      if (rec !== null && !good && keys.cleanupPending && (await keys.cleanupPending()))
        throw new CleanupPendingError();
      if (o.onlyVerifiedChange && !good) return null;
      // a failed record's own epoch is not trusted
      let base: GrantBody = ok
        ? { v: 1, epoch: ok.epoch, developerMode: ok.developerMode, plugins: ok.plugins }
        : { ...emptyBody(), epoch };
      // another plugin's entry an earlier version stored is left out here, so the record written holds none
      // (builtinOnly)
      base = { ...base, plugins: this.keep(withOverlay(base.plugins, parseOverlay(l[OVERLAY_KEY]))) };
      // the built-in autofill's Off, read tighten-only from a record that failed (core/plugins/builtin.ts, OD-1), goes
      // into the new one: the record kept aside honours no plugin, but the user's Off must not turn into its default, On
      // (the W1b r2 review's N-01: approving another plugin again would otherwise turn autofill back on)
      if (rec !== null && !good) {
        const failed = withOverlay(
          rec === "damaged" ? looseEntries(l[GRANTS_KEY]) : rec.plugins,
          parseOverlay(l[OVERLAY_KEY]),
        );
        if (!autofillOn(failed)) base = autofillSwitched(base, false, this.now());
      }
      const changed = change(base);
      // what `change` gives back is held to the same: an entry it adds for another plugin is never written
      const next = { ...changed, plugins: this.keep(changed.plugins) };
      if (o.onlyVerifiedChange && sameBody(next, base)) return null;
      const sealed = await seal(key, {
        v: 1,
        epoch: Math.max(base.epoch, epoch) + 1,
        developerMode: next.developerMode,
        plugins: next.plugins,
      });
      // 1. (every plugin's entries kept) a record that did not verify is kept aside: as it is when nothing is kept yet;
      // else its plugins merged into what is kept (none of either dropped: a later failure never replaces an earlier
      // one, and its own plugins are not lost either, as when a new vault's set-aside was cut short at its first step)
      if (this.all && rec !== null && !good) {
        const mine = looseEntries(l[GRANTS_KEY]);
        const kept = looseEntries(l[UNVERIFIED_KEY]);
        await this.d.local.set({
          [UNVERIFIED_KEY]:
            l[UNVERIFIED_KEY] === undefined
              ? l[GRANTS_KEY]
              : { v: 1, plugins: [...mine, ...kept.filter((k) => !mine.some((e) => e.pluginId === k.pluginId))] },
        });
      }
      // 2. the record, 3. the epoch, 4. the overlay it has merged, 5. (by default) a record an earlier version kept
      // aside: only another plugin's entries and a switch this record holds already are in it, and nothing reads it now
      await this.d.local.set({ [GRANTS_KEY]: sealed });
      await this.raiseEpoch(sealed.epoch);
      if (l[OVERLAY_KEY] !== undefined) await this.d.local.remove([OVERLAY_KEY]);
      if (!this.all && l[UNVERIFIED_KEY] !== undefined) await this.d.local.remove([UNVERIFIED_KEY]);
      return sealed;
    });
  }

  /** The built-in autofill's switch (core/plugins/builtin.ts): its entry approved or disabled, nothing else changed. */
  async setAutofill(keys: GrantKeys, on: boolean): Promise<void> {
    const now = this.now();
    await this.write(keys, (b) => autofillSwitched(b, on, now));
  }
}
