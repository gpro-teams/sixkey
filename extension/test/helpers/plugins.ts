// Fixtures for the grant store's and the kept plugin modules' tests: plugin IDs, a descriptor (a password
// generator's), a PNG header, a vault key, a grant store with the plugin platform's writes (TestGrantStore), and one
// over memory.
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import { readDescriptor, type CapabilityName, type Descriptor } from "../../src/core/plugins/descriptor";
import {
  approved,
  disabled,
  enabled,
  looseEntries,
  markTrashed,
  overlayWith,
  OVERLAY_KEY,
  parseOverlay,
  parsePauses,
  PAUSES_KEY,
  removed,
  unmarkTrashed,
  UNVERIFIED_KEY,
  versioned,
  type GrantReason,
  type GrantRecord,
  type OverlayAction,
} from "../../src/core/plugins/grants";
import { GrantStore, type GrantKeys, type StoreDeps } from "../../src/core/plugins/store";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";

export const PID = "abcdefghijklmnopabcdefghijklmnop";
export const LISTED = "bcdefghijklmnopabcdefghijklmnopa";
export const OFFICIAL = "cdefghijklmnopabcdefghijklmnopab";
export const BLOCKED = "defghijklmnopabcdefghijklmnopabc";

export function descriptor(id = PID, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "Password Generator",
    version: "1.0.0",
    publisher: { name: "Example Developer", url: "https://example.org" },
    sdkVersion: 1,
    capabilities: [
      { name: "ui.slots", reason: "Adds Generate password to Sixkey's menu." },
      { name: "env.read", reason: "Uses Sixkey's theme and language." },
    ],
    contributions: [{ id: "generate", slot: "popup.menu", title: "Generate password", icon: { builtin: "dice" } }],
    defaultLocale: "en",
    locales: { zh_CN: { name: "密码生成器", titles: { generate: "生成密码" } } },
    ...over,
  };
}

/** A PNG's signature and IHDR (and padding): enough for the IHDR check, which is all Sixkey reads before <img>. */
export function png(
  w: number,
  h: number,
  o: { depth?: number; interlace?: number; pad?: number; chunk?: string } = {},
) {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const bytes = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    ...[...(o.chunk ?? "IHDR")].map((c) => c.charCodeAt(0)),
    ...u32(w),
    ...u32(h),
    o.depth ?? 8,
    6,
    0,
    0,
    o.interlace ?? 0,
    0,
    0,
    0,
    0,
    ...new Array(o.pad ?? 0).fill(0),
  ];
  return `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
}

export const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
export const desc = (id = PID, over: Record<string, unknown> = {}): Descriptor => {
  const r = readDescriptor(descriptor(id, over));
  if (!r.ok) throw new Error("bad fixture");
  return r.descriptor;
};
export async function newVk(fill?: number): Promise<Vk> {
  const raw = fill === undefined ? crypto.getRandomValues(new Uint8Array(32)) : new Uint8Array(32).fill(fill);
  return vkFromRaw(raw);
}
export const keysOf = (vk: Vk): GrantKeys => ({ vk });
/**
 * The grant store with the writes the plugin platform's screens and worker made through it: approving a plugin, its
 * switch, its removal, its trash marks, the versions Chrome reported, the overlay's tightenings and the pauses. No build
 * makes them since the platform was removed, so they live here, for the store's tests, which hold its rules for a
 * record of many entries with them. Each is what the store's own method was: a tagged write (GrantStore.write) of a
 * grants.ts transition, or a step of its own under the same lock.
 */
export class TestGrantStore extends GrantStore {
  private readonly deps: StoreDeps;
  private readonly clock: () => number;
  constructor(deps: StoreDeps) {
    super(deps);
    this.deps = deps;
    this.clock = deps.now ?? Date.now;
  }

  /** Approve `descriptor` with `granted` (the approval screen's Allow), and take it off the review list. */
  async approve(keys: GrantKeys, descriptor: Descriptor, granted: CapabilityName[]): Promise<GrantRecord> {
    const now = this.clock();
    const rec = await this.write(keys, (b) => approved(b, { descriptor, granted, now }));
    await this.forgetKept(descriptor.id);
    return rec;
  }

  /** The user's switch: off, or on again (only from off: a suspended plugin needs the approval screen). */
  setOn(keys: GrantKeys, id: string, on: boolean): Promise<GrantRecord> {
    const now = this.clock();
    return this.write(keys, (b) => (on ? enabled(b, id, now) : disabled(b, id)));
  }

  /** The accounts a plugin moved to the trash, marked in its entry: book-keeping, over a record that verifies only. */
  async markTrashed(keys: GrantKeys, id: string, ids: readonly string[]): Promise<void> {
    if (ids.length) await this.write(keys, (b) => markTrashed(b, id, ids), { onlyVerifiedChange: true });
  }

  /** The marks of accounts brought back from the trash, dropped from every entry: book-keeping too. */
  async unmarkTrashed(keys: GrantKeys, ids: readonly string[]): Promise<void> {
    if (ids.length) await this.write(keys, (b) => unmarkTrashed(b, ids), { onlyVerifiedChange: true });
  }

  /** The versions Chrome reports, recorded as the approved ones. Nothing else changes. */
  async recordVersions(keys: GrantKeys, versions: ReadonlyMap<string, string>): Promise<void> {
    if (versions.size) await this.write(keys, (b) => versioned(b, versions));
  }

  /** Remove: its grants go, and it leaves the list kept for review. */
  async remove(keys: GrantKeys, id: string): Promise<void> {
    await this.write(keys, (b) => removed(b, id));
    await this.forgetKept(id);
  }

  /** A plugin of a failed record, not approved again, taken off the review list (it was never honoured). */
  forgetKept(id: string): Promise<void> {
    return this.deps.lock(async () => {
      const raw = (await this.deps.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY];
      if (raw === undefined) return;
      const rest = looseEntries(raw).filter((e) => e.pluginId !== id);
      if (rest.length) await this.deps.local.set({ [UNVERIFIED_KEY]: { v: 1, plugins: rest } });
      else await this.deps.local.remove([UNVERIFIED_KEY]);
    });
  }

  /** An overlay entry: honoured at once in every lock state, merged and re-tagged at the next tagged read. */
  tighten(id: string, action: OverlayAction, reason?: GrantReason): Promise<void> {
    const at = this.clock();
    return this.deps.lock(async () => {
      const cur = parseOverlay((await this.deps.local.get([OVERLAY_KEY]))[OVERLAY_KEY]);
      const entry = { pluginId: id, action, ...(reason ? { reason } : {}), at };
      await this.deps.local.set({ [OVERLAY_KEY]: { v: 1, entries: overlayWith(cur, entry) } });
    });
  }

  /** A pause after three denials: storage.session, no tag, until resumed or the browser session ends. */
  pause(id: string): Promise<void> {
    const since = this.clock();
    return this.deps.lock(async () => {
      const cur = parsePauses((await this.deps.session.get([PAUSES_KEY]))[PAUSES_KEY]).filter((p) => p.pluginId !== id);
      await this.deps.session.set({ [PAUSES_KEY]: { v: 1, pauses: [...cur, { pluginId: id, since }].slice(-256) } });
    });
  }

  /** A paused plugin turned on again. */
  resume(id: string): Promise<void> {
    return this.deps.lock(async () => {
      const cur = parsePauses((await this.deps.session.get([PAUSES_KEY]))[PAUSES_KEY]);
      await this.deps.session.set({ [PAUSES_KEY]: { v: 1, pauses: cur.filter((p) => p.pluginId !== id) } });
    });
  }
}

/**
 * A grant store over memory, with the plugin platform's writes (TestGrantStore). It keeps every plugin's entries
 * (`entries: "all"`), as the store's own tests need; the extension's keeps the built-in autofill's alone (the default,
 * plugins-retired.test.ts).
 */
export function world(now = () => 1_000, entries: "builtin" | "all" = "all") {
  const local = new MemoryKV();
  const session = new MemoryKV();
  return { local, session, store: new TestGrantStore({ local, session, lock: createMutex(), now, entries }) };
}
