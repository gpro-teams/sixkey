// The settings page's writes for the backup in Chrome's sync storage, and the messages that go with them. A page never
// writes chrome.storage.sync: it reads the copies there (read.ts), opens and merges them into the vault with the
// service, and tells the worker (platform/csb-worker.ts, the sk-csb-* messages, the settings page's alone) what to do.
//   - The two messages that lift or replace a hold, sk-csb-restored (a restore's adoption of the copy it came from) and
//     sk-csb-merged (the held copy merged), name the generation the page wrote: its save counter and its envelope's
//     checksum. They are sent from inside the store's lock that committed it (the service's `after`), so that a save in
//     another page or the popup has as little time as possible to come between; the worker takes that lock before it
//     checks them, and takes them only while the vault on disk is still exactly that generation.
//   - Answered "not_that_generation" (the vault changed since), the page writes the same merge again over the vault as it
//     is now, once, and names that generation; answered "slot_changed" (the copy changed since it was read, or is still
//     arriving), it reads the copy again and merges that, once. Neither again: the page says so ("merge again", or for
//     a restore a new copy of its own, which overwrites nothing), never a loop.
//   - Merging other copies (another vault's, or every other copy when the space has run out) needs what opens them,
//     typed. Removing them afterwards is a click of the person's, never done by itself: one sk-csb-drop for each vault's
//     merge, sent from inside the store's lock that committed that merge and named by its generation, as above, with
//     each copy's tag as it was read. The worker removes none unless the vault on disk is still that generation (else
//     the page merges that vault's copies again, once) and this computer's own copy then fits in the area (else
//     removing them would leave Chrome Sync with no copy of either), and then only those still whole under that tag.
import type { CloudBackup } from "../../core/cloud/format";
import type { CloudCandidate } from "../../core/cloud/restore";
import { slotCandidate, wrapsOf } from "../../core/cloud/slots";
import type { Generation } from "../../core/storage/format";
import type { Vault } from "../../core/vault/model";
import type { FirstRunChoice, PreparedKeys } from "../../core/service/service";
import { CSB_CFG_KEY, parseCsbConfig } from "../../platform/csb-config";
import type { Runtime } from "../../platform/runtime";
import { openBackups, type CsbOpened } from "./open";
import { listSlots, waitForSlots, type SlotList } from "../../platform/csb-read";

/** The worker's answer to a message: done, or why not (csb-worker.ts); a removal's also names what it removed. */
export type Answer = ({ ok: true } | { ok: false; why: string }) & { removed?: string[] };

/** A message to the worker's backup handlers (settings page only); its answer, or "no_answer" when none came. */
export async function ask(type: string, more: Record<string, unknown> = {}): Promise<Answer> {
  try {
    const r = (await chrome.runtime.sendMessage({ type, ...more })) as Answer | undefined;
    return r && typeof r === "object" && "ok" in r && (r.ok || typeof r.why === "string")
      ? r
      : { ok: false, why: "no_answer" };
  } catch {
    return { ok: false, why: "no_answer" };
  }
}

type Commit = (after: (gen: Generation) => void) => Promise<unknown>;

/**
 * `commit` writes the vault and calls back with the generation it committed, inside the store's lock: the message
 * naming it is sent there, and its answer awaited once the lock is let go (the worker takes that lock to check it).
 * A commit that wrote nothing new here (a restore an earlier attempt had written) names the generation on disk now.
 */
async function sendWithin(
  rt: Pick<Runtime, "service">,
  type: string,
  commit: Commit,
  more: (gen: Generation) => Record<string, unknown>,
): Promise<Answer> {
  let sent: Promise<Answer> | null = null;
  await commit((gen) => {
    sent = ask(type, { ...more(gen), seq: gen.seq, sum: gen.envelope.checksum });
  });
  if (sent) return sent;
  const gen = await rt.service.currentGeneration();
  return gen ? ask(type, { ...more(gen), seq: gen.seq, sum: gen.envelope.checksum }) : { ok: false, why: "no_vault" };
}

/** How long a page waits for a copy still arriving before it says so (a merge is the user's click: not for long). */
export const ARRIVING_MS = 15_000;

/** The copy `slot` as read now, waited for while it is still arriving (at most ARRIVING_MS). */
async function readSlot(slot: string): Promise<SlotList["slots"][number] | undefined> {
  const { list } = await waitForSlots({
    ms: ARRIVING_MS,
    done: (l) => l.slots.find((s) => s.slot === slot)?.read.kind !== "partial",
  });
  return list.slots.find((s) => s.slot === slot);
}

// ---- first run: the restore's end -------------------------------------------------------------------------------

/** How a first run left the backup: continuing the copy restored from, on with a new copy, refused here, or off. */
export type BackupOutcome = "adopted" | "on" | "new_copy" | "unsafe" | "off";

/** sk-csb-on: the backup on (no unlock needed); "unsafe" where the worker could not close storage.sync to web pages' scripts. */
export async function turnOn(): Promise<BackupOutcome> {
  const a = await ask("sk-csb-on");
  return a.ok ? "on" : a.why === "unsafe_area" ? "unsafe" : "off";
}

/**
 * First run's restore from Chrome Sync, written (restoreBackup) and, with the box ticked (`backup`), continued: this
 * computer adopts the newest copy it opened (the worker's sk-csb-restored), named by the generation the restore wrote,
 * the recovery key's new master password included (set before that one write). Not taken because the vault changed
 * since: the restored vault merged again over the vault as it is now, and adopted under that generation; because the
 * copy changed since it was read: that copy read, opened with what was typed and merged, and adopted under its new tag.
 * Either once. Still not taken (or another vault's copy): the backup goes on as a new copy of its own, which overwrites
 * nothing (the copy restored from stays). A downloaded file has no copy to continue: the backup is turned on.
 */
/**
 * First run's box cleared where the backup was on already (a first run over data that could not be read, whose backup
 * had been turned on): turned off, as the box says (the worker keeps a copy that is not this vault's, sk-csb-off).
 */
export async function turnOffIfOn(rt: Pick<Runtime, "local">): Promise<void> {
  if (parseCsbConfig((await rt.local.get([CSB_CFG_KEY]))[CSB_CFG_KEY]).on) await ask("sk-csb-off");
}

/**
 * First run's box cleared at its end. Where it was ticked for the person (a profile only they use), clearing it is their
 * turning the backup off, recorded as the card's 关闭 records it (sk-csb-off: off, and `declined`, so that the popup's
 * 立即备份 opens the card without turning the backup on); a backup that was on goes off with it. Where it was never
 * ticked (a profile declared shared), nothing is recorded, but a backup that was on goes off (turnOffIfOn).
 */
export async function boxCleared(rt: Pick<Runtime, "local">, shared: boolean): Promise<void> {
  if (shared) await turnOffIfOn(rt);
  else await ask("sk-csb-off");
}

export async function finishRestore(
  rt: Pick<Runtime, "service" | "settings" | "local">,
  o: { opened: CsbOpened; keys: PreparedKeys; choice: FirstRunChoice; backup: boolean },
): Promise<BackupOutcome> {
  const { opened, keys, choice } = o;
  const restore = opened.restore;
  if (!o.backup || !opened.slots) {
    await rt.service.restoreBackup(restore.vault, keys, choice);
    if (o.backup) return turnOn();
    await boxCleared(rt, choice.preset === "shared");
    return "off";
  }
  // the copy continued, the tag it was read under, what it holds (its wraps: a restore that changed the keys writes at
  // the first run), and whether more than one copy went into the vault (written at the first run too)
  const message = (base: CloudCandidate, dirty: boolean) => () => ({
    slot: base.id,
    gen: base.head,
    opens: base.backup.opens,
    wraps: wrapsOf(base.backup.generation.keyring.wraps),
    dirty,
  });
  let base = restore.base;
  const dirty = restore.merged.length > 1;
  let a = await sendWithin(
    rt,
    "sk-csb-restored",
    (after) => rt.service.restoreBackup(restore.vault, keys, choice, after),
    message(base, dirty),
  );
  try {
    if (!a.ok && a.why === "not_that_generation")
      a = await sendWithin(
        rt,
        "sk-csb-restored",
        (after) => rt.service.importBackup(restore.vault, after),
        message(base, dirty),
      );
    else if (!a.ok && a.why === "slot_changed") {
      const again = await readSlot(base.id);
      const opened2 =
        again?.read.kind === "ok"
          ? await openBackups([slotCandidate(again.slot, again.read)], opened.typed, {
              now: Date.now(),
              device: await rt.settings.deviceId(),
            })
          : null;
      if (opened2 && opened2 !== "typo" && opened2.vault.vaultId === restore.vault.vaultId) {
        base = opened2.base;
        a = await sendWithin(
          rt,
          "sk-csb-restored",
          (after) => rt.service.importBackup(opened2.vault, after),
          message(base, true),
        );
      }
    }
  } catch {
    // the vault is written: whatever the second try met, the backup goes on as a new copy below
  }
  if (a.ok) return "adopted";
  if (a.why === "unsafe_area") return "unsafe";
  const on = await turnOn();
  return on === "on" ? "new_copy" : on;
}

// ---- Settings › Backup: the merges ------------------------------------------------------------------------------

/** What a merge ended with: done (with what it did), what to type first, or why not. */
export type MergeResult =
  | {
      kind: "done";
      added: number;
      removed: number;
      kept: number;
      /** None removed: this computer's copy would not fit even without them. */
      notFit?: boolean;
      /** Another vault's copies merged and kept, which the person may then remove (removeMerged). */
      merged?: Merged[];
    }
  | { kind: "secret" } // the copy does not open with a key held here: what opens it, typed
  | { kind: "wrong" | "typo" | "nothing" | "again" | "unsafe" };

/** One vault's copies opened and merged: what they hold, and each copy with the tag it was read under. */
export type Merged = { vault: Vault; slots: { slot: string; gen: string }[] };

/**
 * The held copy (this computer's own slot, which may be newer than the data here: slots.ts rules 3 and 7), merged into
 * the vault, and the hold lifted (sk-csb-merged, named by the generation the merge wrote). Opened with a key held here
 * (openOwnGenerations), or after a key change with `typed`. A copy that is not there any more is nothing to merge: the
 * hold is lifted on the vault as it is. Needs the vault open.
 */
export async function mergeHeld(
  rt: Pick<Runtime, "service" | "settings" | "local">,
  typed?: string,
): Promise<MergeResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const link = parseCsbConfig((await rt.local.get([CSB_CFG_KEY]))[CSB_CFG_KEY]).link;
    if (!link?.held) return { kind: "done", added: 0, removed: 0, kept: 0 }; // not held (any more): nothing to do
    const s = await readSlot(link.slot);
    let a: Answer;
    let added = 0;
    if (s?.read.kind === "ok") {
      const read = s.read;
      const vault = await openHeld(rt, read.backup, link.slot, typed);
      if (typeof vault === "string") return { kind: vault };
      a = await sendWithin(
        rt,
        "sk-csb-merged",
        async (after) => (added = (await rt.service.importBackup(vault, after)).added),
        () => ({ slot: link.slot, gen: read.manifest.g }),
      );
    } else {
      // gone, or not a copy this Sixkey reads: nothing of it to merge; the worker lifts the hold only if its tag is
      // the one this names (none) and decides by the vault as it is now
      const gen = await rt.service.currentGeneration();
      if (!gen) return { kind: "again" };
      a = await ask("sk-csb-merged", { slot: link.slot, gen: null, seq: gen.seq, sum: gen.envelope.checksum });
    }
    // (not held any more: another page merged it meanwhile, which is this merge's end too)
    if (a.ok || a.why === "not_held") return { kind: "done", added: Math.max(0, added), removed: 0, kept: 0 };
    if (a.why !== "not_that_generation" && a.why !== "slot_changed") return { kind: "again" };
  }
  return { kind: "again" };
}

/** The held copy's vault: with a key held here, else with what was typed; or what to say. */
async function openHeld(
  rt: Pick<Runtime, "service" | "settings">,
  backup: CloudBackup,
  slot: string,
  typed: string | undefined,
): Promise<Vault | "secret" | "wrong" | "typo"> {
  const [own] = await rt.service.openOwnGenerations([backup.generation]);
  if (own) return own;
  if (typed === undefined) return "secret";
  const r = await openBackups([{ id: slot, head: "", modified: Date.now(), backup }], typed, {
    now: Date.now(),
    device: await rt.settings.deviceId(),
  });
  return r === null ? "wrong" : r === "typo" ? "typo" : r.vault;
}

/**
 * Other copies merged into the vault, opened with `typed`: another vault's ("Chrome 同步里还有 … · 合并到这台电脑"), or
 * every copy but this computer's own when the space has run out ("合并到这台电脑并删除它们", `remove`), which then asks
 * the worker to remove exactly the copies that opened and were merged, each under the tag it was read with
 * (mergeAndDrop). One open and one merge per vault: a vault's copies merge with each other (deletions win by their
 * clocks, restore.ts), another vault's accounts are added. Without `remove`, what was merged comes back (`merged`) for
 * the person to remove afterwards with removeMerged. Needs the vault open (`vaultId`: its id).
 */
export async function mergeOthers(
  rt: Pick<Runtime, "service" | "settings" | "local">,
  typed: string,
  o: { vaultId: string; remove: boolean },
): Promise<MergeResult> {
  const own = parseCsbConfig((await rt.local.get([CSB_CFG_KEY]))[CSB_CFG_KEY]).link?.slot ?? null;
  const list = await listSlots();
  const others = list.intact.filter(
    (c) => c.id !== own && (o.remove || c.backup.generation.envelope.vaultId !== o.vaultId),
  );
  if (others.length === 0) return { kind: "nothing" };
  const byVault = new Map<string, CloudCandidate[]>();
  for (const c of others) {
    const id = c.backup.generation.envelope.vaultId;
    byVault.set(id, [...(byVault.get(id) ?? []), c]);
  }
  const device = await rt.settings.deviceId();
  const groups: Merged[] = [];
  let typo = false;
  for (const group of byVault.values()) {
    const r = await openBackups(group, typed, { now: Date.now(), device });
    if (r === "typo") typo = true;
    else if (r) {
      const merged = new Set(r.merged);
      const slots = group.filter((c) => merged.has(c.id)).map((c) => ({ slot: c.id, gen: c.head }));
      groups.push({ vault: r.vault, slots });
    }
  }
  if (groups.length === 0) return { kind: typo ? "typo" : "wrong" };
  if (!o.remove) {
    let added = 0;
    for (const g of groups) added += Math.max(0, (await rt.service.importBackup(g.vault)).added);
    return { kind: "done", added, removed: 0, kept: 0, merged: groups };
  }
  const r = await mergeAndDrop(rt, groups);
  return { ...r, kept: others.length - r.removed };
}

/**
 * Another vault's copies, merged before (mergeOthers), removed now at the person's click: each vault's merged again
 * (it adds nothing that is already there) so that the removal names a generation that holds them.
 */
export async function removeMerged(rt: Pick<Runtime, "service">, groups: readonly Merged[]): Promise<MergeResult> {
  const r = await mergeAndDrop(rt, groups);
  return { ...r, kept: groups.reduce((n, g) => n + g.slots.length, 0) - r.removed };
}

/**
 * Each vault's copies merged, and their removal sent from inside the store's lock of that merge, named by its
 * generation; refused because the vault changed since, merged and sent once more. Not one call for every vault after
 * all the merges: a fallback between two of them would leave the last generation without the first vault's accounts.
 */
async function mergeAndDrop(
  rt: Pick<Runtime, "service">,
  groups: readonly Merged[],
): Promise<{ kind: "done"; added: number; removed: number; notFit: boolean }> {
  let added = 0;
  let removed = 0;
  let notFit = false;
  for (const g of groups) {
    const commit = async (after: (gen: Generation) => void) =>
      (added += Math.max(0, (await rt.service.importBackup(g.vault, after)).added));
    let a = await sendWithin(rt, "sk-csb-drop", commit, () => ({ slots: g.slots }));
    if (!a.ok && a.why === "not_that_generation")
      a = await sendWithin(rt, "sk-csb-drop", commit, () => ({ slots: g.slots }));
    if (a.ok) removed += a.removed?.length ?? 0;
    else if (a.why === "would_not_fit") notFit = true;
  }
  return { kind: "done", added, removed, notFit };
}
