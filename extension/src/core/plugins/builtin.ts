// The built-in official plugins (docs/design/proposals/MOD-PLATFORM.md §7.2 Option I; OWNER-DECISIONS/16 Q-A (a);
// docs/design/notes/PLUGINS-W1B-NOTES.md): parts of Sixkey's own code that reach the vault as a plugin would, through the
// platform's capability gate, its request log and its switch. Wave 1b has one, autofill.
//   - It is no extension of its own, so its ID is reserved: an extension's ID is the first 128 bits of the SHA-256 of its
//     public key written in the letters a–p, and 128 zero bits (all "a") is a hash nobody can find a key for. No message,
//     port or add-by-ID can claim it (the worker answers only an extension that sent a message; Settings refuses the ID).
//   - Its trust is official and its ceiling is `codes.forPage` (the current code into the page the user is on): what the
//     gate allows it (platform/plugins/autofill-gate.ts), never more.
//   - Its switch is the grant store's, as any plugin's: no entry is On (built in, and on by default); turning it off in
//     Settings writes an entry `disabled`, turning it on again `approved` (tagged writes, the vault key needed). Any
//     state but `approved` is Off (`suspended` too). The overlay can only tighten it: an overlay `remove` of the
//     built-in's entry disables it instead (grants.ts withOverlay). What no rule of the record can hold: a record taken
//     away whole (deleted, or a rollback across a restart to one written before the Off) leaves the built-in's default,
//     On, as on a fresh install; only a writer of Sixkey's storage can do that, and it gains nothing beyond what the
//     user's own Fill click does (the ceiling is the build's).
//   - A record whose tag fails (OD-1 of the W1b review, decided UX-first): the built-in's switch is read from it
//     unverified, tighten-only: Off if its entry says so, else On (platform/plugins/autofill-gate.ts, and the worker's
//     autofill-switch.ts switchedOff, which reads the same). It can only ever turn autofill off, and nothing in a record
//     can give it more than its ceiling.
// Pure: no text, no browser calls.
import { readDescriptor, type CapabilityName, type Descriptor } from "./descriptor";
import type { GrantBody, GrantEntry } from "./grants";
import type { CatalogEntry } from "./policy";

/** Autofill's reserved plugin ID (see above). */
export const AUTOFILL_ID = "a".repeat(32);
/** Whether `id` is a built-in plugin's. */
export const isBuiltin = (id: string): boolean => id === AUTOFILL_ID;

/** What the built-in autofill may do: the code of the account it fills, into the page the user is on. */
export const AUTOFILL_CAPS: readonly CapabilityName[] = ["codes.forPage"];

/** The built-ins as the catalog lists them (the runtime catalog adds them: platform/plugins/chrome.ts catalog()). */
export const BUILTIN_CATALOG: readonly CatalogEntry[] = [
  { id: AUTOFILL_ID, trust: "official", name: "Autofill", publisher: "Sixkey", ceiling: [...AUTOFILL_CAPS] },
];

/**
 * Its descriptor in the grant store: nothing to ask for (it is built in, and its ceiling is the catalog's) and nothing to
 * draw (its buttons are Sixkey's own, not plugin entries). Made when first needed (the worker's modules import this one:
 * nothing here may throw at load).
 */
let descriptorMade: Descriptor | undefined;
export function autofillDescriptor(): Descriptor {
  if (descriptorMade) return descriptorMade;
  const r = readDescriptor({
    id: AUTOFILL_ID,
    name: "Autofill",
    version: "1.0.0",
    publisher: { name: "Sixkey" },
    sdkVersion: 1,
    capabilities: [],
    contributions: [],
    defaultLocale: "en",
  });
  if (!r.ok) throw new Error("the built-in autofill's descriptor does not read");
  return (descriptorMade = r.descriptor);
}

/** Autofill's entry as the record holds it now, or undefined (On by default). */
export const autofillEntry = (plugins: readonly GrantEntry[]): GrantEntry | undefined =>
  plugins.find((e) => e.pluginId === AUTOFILL_ID);

/** Whether the switch is on: no entry, or one that is approved (disabled and suspended are Off). */
export const autofillOn = (plugins: readonly GrantEntry[]): boolean => {
  const e = autofillEntry(plugins);
  return e === undefined || e.state === "approved";
};

/** The record with autofill turned on or off: its entry written (made if there is none), nothing else changed. */
export function autofillSwitched(body: GrantBody, on: boolean, now: number): GrantBody {
  const cur = autofillEntry(body.plugins);
  const next: GrantEntry = cur
    ? on
      ? {
          pluginId: cur.pluginId,
          state: "approved",
          descriptor: cur.descriptor,
          granted: [...AUTOFILL_CAPS],
          approvedAt: now,
          trashed: cur.trashed,
        }
      : { ...cur, state: "disabled", reason: "user" }
    : {
        pluginId: AUTOFILL_ID,
        state: on ? "approved" : "disabled",
        ...(on ? {} : { reason: "user" as const }),
        descriptor: autofillDescriptor(),
        granted: [...AUTOFILL_CAPS],
        approvedAt: now,
        trashed: [],
      };
  return {
    ...body,
    plugins: cur ? body.plugins.map((e) => (e.pluginId === AUTOFILL_ID ? next : e)) : [...body.plugins, next],
  };
}
