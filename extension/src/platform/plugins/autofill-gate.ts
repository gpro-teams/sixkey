// The built-in autofill's one way to a code (docs/design/proposals/MOD-PLATFORM.md §7.2 Option I item 1;
// docs/design/notes/PLUGINS-W1B-NOTES.md): the platform's capability gate, as any plugin's request would meet it. The
// code of the account being filled is worked out here and nowhere else in autofill (platform/autofill.ts fillCand takes it
// as `code`, and has no default; test/unit/plugins-w1b-source-rules.test.ts holds the autofill modules to it), only if:
//   - the vault key is here (the verified read needs it: §6.6 item 3);
//   - autofill's switch is on (core/plugins/builtin.ts: no entry, or approved). A record whose tag fails is read for the
//     built-in unverified and tighten-only (OD-1 of the W1b review): Off if it says so, else On, exactly as the worker
//     reads it (switchedOff, both in autofill-switch.ts), so the page and the worker never disagree about the switch. Nothing in a
//     record can grant the built-in more than its ceiling, so an unverified one can only take away;
//   - `codes.forPage` is within what its entry holds and its level allows (official, the built-in catalog's ceiling).
// Every ask is logged in the request log, under autofill's reserved ID, with its outcome: Settings › Security › Autofill
// shows its last lines under the switch. The switch is the user's intent; what keeps autofill out of pages when it is off
// is Chrome's: turning it off gives back `scripting` (platform/plugins/autofill-switch.ts).
import { AUTOFILL_CAPS, AUTOFILL_ID, autofillEntry, autofillOn } from "../../core/plugins/builtin";
import { ceilingOf, heldNow, trustOf } from "../../core/plugins/policy";
import { withFreshKeys, type GrantKeys } from "../../core/plugins/store";
import type { Entry } from "../../core/vault/model";
import { codeAt } from "../../ui/otp";
import type { Gated } from "../autofill";
import { switchRecord } from "./autofill-switch";
import { catalog, grantStore, pluginSession } from "./chrome";

/** Whether autofill may have a code now: "ok", "off" (switched off), "locked". */
export type Allowed = "ok" | "off" | "locked";

/** The gate's answer, read now (a verified read of the grant store). */
export async function autofillAllowed(keys: () => Promise<GrantKeys | null>): Promise<Allowed> {
  // the verified read may merge a pending overlay (a tagged write): with a fresh key after a key change (N2)
  const r = await withFreshKeys(keys, switchRecord);
  if (!r) return "locked";
  const { plugins } = r;
  if (!autofillOn(plugins)) return "off";
  const { trust, entry } = trustOf(catalog(), AUTOFILL_ID, null);
  // what it holds: its entry's grant within its level's ceiling, as any plugin's (no entry: built in, its own capabilities)
  const own = autofillEntry(plugins);
  const held = own ? heldNow(own, trust, entry) : AUTOFILL_CAPS.filter((c) => ceilingOf(trust, entry).has(c));
  return trust === "official" && held.includes("codes.forPage") ? "ok" : "off";
}

/**
 * The `code` that platform/autofill.ts fillCand needs: the account's code at `timeMs` if the gate allows it, else why not
 * (nothing is filled). `keys`: the vault key of the context filling (the popup's or the side panel's service, or the
 * worker's for the shortcut).
 */
export function gatedCode(keys: () => Promise<GrantKeys | null>): (e: Entry, timeMs: number) => Promise<Gated> {
  return async (e, timeMs) => {
    const allowed = await autofillAllowed(keys).catch((): Allowed => "off");
    void pluginSession()
      .record({
        at: Date.now(),
        pluginId: AUTOFILL_ID,
        type: "codes.forPage",
        outcome: allowed === "ok" ? "ok" : allowed === "locked" ? "locked" : "disabled",
      })
      .catch(() => undefined);
    return allowed === "ok" ? { code: await codeAt(e, timeMs) } : { no: allowed };
  };
}

/**
 * The record written again, unchanged (a tagged write, under the vault's lock): for every Fill click that meets this
 * gate's "off" (its page hint was missing), whether or not the click got `scripting` from Chrome (W1b r3 S-1). The write
 * is what the worker follows (autofill-switch.ts watchSwitch, autofill-reconcile.ts followSwitch), with the switch as it
 * is when the write lands, so `scripting` is given back if autofill is still off and kept if an On was written
 * meanwhile: no clock (the W1b r2 review's N-02). Locked: nothing. A record whose tag fails is written as any tagged
 * write writes one (the W1c review's P-U7): a new record, the failed one kept aside in sk_plugins_unverified, its
 * approved plugins listed for review, autofill still off; nothing the user can see is lost.
 */
export async function touchSwitch(keys: () => Promise<GrantKeys | null>): Promise<void> {
  await withFreshKeys(keys, (k) => grantStore().write(k, (b) => b));
}
