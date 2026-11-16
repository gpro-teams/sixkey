// The grant store (src/core/plugins/grants.ts, store.ts), over every plugin's entries (`entries: "all"`): one record, tagged with
// K_g = HKDF(vault key, "sixkey/v1/plugin-grants"), binding every plugin ID, its descriptor and state, developerMode and
// the epoch; strictly read; never wiped by a failed tag; an overlay that can only tighten; pauses in the session; the
// rollback check; a key change re-tagged through the previous keys; approving again after a failed tag that launders
// nothing. Crash safety is test/fault/plugin-grants-crash.test.ts.
import { describe, expect, it } from "vitest";
import { hkdfBits } from "../../src/core/crypto/kdf";

import {
  approved,
  disabled,
  emptyBody,
  enabled,
  EPOCH_KEY,
  GRANT_LABEL,
  grantKey,
  GRANTS_KEY,
  OVERLAY_KEY,
  overlayWith,
  parseEntry,
  parseOverlay,
  parseRecord,
  PAUSES_KEY,
  removed,
  seal,
  strength,
  tightened,
  UNVERIFIED_KEY,
  verify,
  withOverlay,
  type GrantEntry,
} from "../../src/core/plugins/grants";
import {
  OFFERED_CAPABILITIES,
  OFFERED_SLOTS,
  readDescriptor,
  RETIRED_CAPABILITIES,
} from "../../src/core/plugins/descriptor";
import { heldNow, parseCatalog } from "../../src/core/plugins/policy";
import { desc, descriptor, keysOf, LISTED, newVk, OTHER, PID, world } from "../helpers/plugins";

const entry = (id = PID, over: Partial<GrantEntry> = {}): GrantEntry => ({
  pluginId: id,
  state: "approved",
  descriptor: desc(id),
  granted: ["ui.slots", "env.read"],
  approvedAt: 100,
  trashed: [],
  ...over,
});

describe("K_g and the tag (§6.6 item 2)", () => {
  it("K_g is HKDF-SHA256 of the vault key with an empty salt and the label, as an HMAC-SHA256 key", async () => {
    const vk = await newVk(7);
    const body = approved(emptyBody(), { descriptor: desc(), granted: ["ui.slots"], now: 5 });
    const rec = await seal(await grantKey(vk.raw), body);
    // the same tag from the bits themselves, so the label and the derivation are pinned
    const bits = await hkdfBits(vk.raw, new Uint8Array(0), GRANT_LABEL, 256);
    const k = await crypto.subtle.importKey("raw", bits as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const { jcs } = await import("../../src/core/plugins/jcs");
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        k,
        new TextEncoder().encode(jcs({ v: 1, epoch: 0, developerMode: false, plugins: body.plugins })),
      ),
    );
    expect(rec.tag).toBe(
      btoa(String.fromCharCode(...mac))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    );
    expect(rec.tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(GRANT_LABEL).toBe("sixkey/v1/plugin-grants");
  });
  it("binds every field: the plugin ID, the descriptor, the state, the grants, developerMode and the epoch", async () => {
    const key = await grantKey((await newVk()).raw);
    const rec = await seal(key, { ...emptyBody(), epoch: 3, plugins: [entry(PID), entry(OTHER)] });
    expect(await verify(key, rec)).toBe(true);
    const moved = {
      ...rec,
      plugins: [
        { ...rec.plugins[0]!, pluginId: OTHER, descriptor: { ...rec.plugins[0]!.descriptor, id: OTHER } },
        rec.plugins[1]!,
      ],
    };
    expect(await verify(key, moved)).toBe(false); // an entry cannot be moved under another ID
    const relabelled = { ...rec, plugins: [{ ...rec.plugins[0]!, pluginId: OTHER }, rec.plugins[1]!] };
    expect(await verify(key, relabelled)).toBe(false); // nor its ID changed alone
    expect(await verify(key, { ...rec, epoch: 4 })).toBe(false);
    expect(await verify(key, { ...rec, developerMode: true })).toBe(false);
    expect(
      await verify(key, { ...rec, plugins: [{ ...rec.plugins[0]!, granted: ["ui.slots"] }, rec.plugins[1]!] }),
    ).toBe(false);
    expect(
      await verify(key, {
        ...rec,
        plugins: [{ ...rec.plugins[0]!, state: "disabled", reason: "user" }, rec.plugins[1]!],
      }),
    ).toBe(false);
    expect(await verify(key, { ...rec, plugins: [rec.plugins[1]!, rec.plugins[0]!] })).toBe(false); // the order is the record's
    const renamed = { ...rec.plugins[0]!, descriptor: { ...rec.plugins[0]!.descriptor, name: "Sixkey Official" } };
    expect(await verify(key, { ...rec, plugins: [renamed, rec.plugins[1]!] })).toBe(false);
    expect(await verify(key, { ...rec, plugins: [rec.plugins[0]!] })).toBe(false);
    expect(await verify(await grantKey((await newVk()).raw), rec)).toBe(false); // another vault key
    expect(
      await verify(key, { ...rec, tag: rec.tag.slice(0, 10) + (rec.tag[10] === "A" ? "B" : "A") + rec.tag.slice(11) }),
    ).toBe(false);
    // the tag's own spelling is canonical: the last character's unused bits must be zero
    const last = "AEIMQUYcgkosw048".indexOf(rec.tag[42]!);
    const loose =
      rec.tag.slice(0, 42) + "AEIMQUYcgkosw048"[last]!.replace(/./, (c) => String.fromCharCode(c.charCodeAt(0) + 1));
    expect(await verify(key, { ...rec, tag: loose })).toBe(false);
  });
});

describe("the records, read strictly", () => {
  it("a grant record is exactly the schema's; anything else is damaged", async () => {
    const key = await grantKey((await newVk()).raw);
    const rec = await seal(key, { ...emptyBody(), plugins: [entry()] });
    expect(parseRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(parseRecord(undefined)).toBe(null);
    for (const bad of [
      { ...rec, extra: 1 },
      { ...rec, v: 2 },
      { ...rec, epoch: -1 },
      { ...rec, tag: "short" },
      { ...rec, plugins: [entry(), entry()] }, // twice
      { ...rec, plugins: [{ ...entry(), trust: "official" }] }, // the trust level is never stored
      { ...rec, plugins: [{ ...entry(), state: "approved", reason: "user" }] },
      { ...rec, plugins: [{ ...entry(), state: "suspended" }] }, // a reason is needed
      { ...rec, plugins: [{ ...entry(), granted: ["ui.slots", "ui.slots"] }] },
      { ...rec, plugins: [{ ...entry(), granted: ["everything"] }] },
      { ...rec, plugins: [{ ...entry(), descriptor: desc(OTHER) }] }, // the descriptor is the entry's plugin's
      { ...rec, plugins: [{ ...entry(), descriptor: { ...desc(), extra: 1 } }] }, // not a normalised descriptor
      { ...rec, plugins: [{ ...entry(), trashed: ["x"] }] },
      { ...rec, plugins: new Array(257).fill(0).map((_, i) => entry(String.fromCharCode(97 + (i % 16)).repeat(32))) },
      "x",
    ])
      expect(parseRecord(bad), JSON.stringify(bad).slice(0, 80)).toBe("damaged");
    expect(parseEntry(entry())).toEqual(entry());
  });
  it("the overlay: only suspend, disable or remove, a malformed entry skipped (never honoured)", () => {
    const ok = { pluginId: PID, action: "suspend", reason: "changed", at: 5 };
    expect(parseOverlay({ v: 1, entries: [ok] })).toEqual([ok]);
    expect(
      parseOverlay({
        v: 1,
        entries: [
          { pluginId: PID, action: "approve", at: 5 },
          { pluginId: PID, action: "enable", at: 5 },
          { pluginId: PID, action: "grant", at: 5 },
          { pluginId: PID, action: "suspend", at: 5 }, // a suspension needs its reason
          { pluginId: "x", action: "disable", at: 5 },
          { pluginId: PID, action: "disable", at: -1 },
          { pluginId: PID, action: "disable", at: 5, granted: ["codes.read"] },
          ok,
        ],
      }),
    ).toEqual([ok]);
    expect(parseOverlay({ v: 2, entries: [ok] })).toEqual([]);
  });
});

describe("an approval an earlier version stored, of a capability retired since (backups.transport)", () => {
  // the official cloud plugin's, as a build before the Google Drive backup's removal approved it: its descriptor read with
  // that version's offer, the capability in it and in what was granted, beside an ordinary plugin's approval
  const CLOUD = "fnlpmmonofibbnonfphejaacgljfeino";
  const asked = (name: string) => [
    { name: "ui.slots", reason: "Shows its entry." },
    { name, reason: "Asked for by an earlier version." },
  ];
  async function stored(name: string) {
    const then = { capabilities: [...OFFERED_CAPABILITIES, name], slots: OFFERED_SLOTS };
    const d = readDescriptor(descriptor(CLOUD, { name: "Cloud Backup", capabilities: asked(name) }), then);
    if (!d.ok) throw new Error("fixture");
    expect(d.descriptor.capabilities.map((c) => c.name)).toEqual(["ui.slots", name]);
    const vk = await newVk(7);
    const body = {
      ...emptyBody(),
      epoch: 1,
      plugins: [entry(PID), { ...entry(CLOUD), descriptor: d.descriptor, granted: ["ui.slots", name] as never }],
    };
    return { vk, rec: await seal(await grantKey(vk.raw), body) };
  }
  it("is the one name retired, and offered to no descriptor", () => {
    expect(RETIRED_CAPABILITIES).toEqual(["backups.transport"]);
    expect(OFFERED_CAPABILITIES).not.toContain("backups.transport");
  });
  it("the record still reads and verifies, and the other plugins' approvals keep working", async () => {
    const { vk, rec } = await stored("backups.transport");
    expect(parseRecord(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    const w = world();
    await w.local.set({ [GRANTS_KEY]: rec });
    const r = await w.store.read(keysOf(vk));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.review).toEqual([]);
    expect(r.plugins.map((e) => e.pluginId).sort()).toEqual([CLOUD, PID].sort());
    expect(
      heldNow(
        r.plugins.find((e) => e.pluginId === PID)!,
        "unlisted",
      ),
    ).toEqual(["ui.slots", "env.read"]);
    expect((await w.store.unverified()).plugins.map((e) => e.pluginId).sort()).toEqual([CLOUD, PID].sort());
  });
  it("and the capability is held at no level, even under a catalog ceiling that names it", async () => {
    const { vk, rec } = await stored("backups.transport");
    const w = world();
    await w.local.set({ [GRANTS_KEY]: rec });
    const r = await w.store.read(keysOf(vk));
    if (!r.ok) throw new Error("not read");
    const cloud = r.plugins.find((e) => e.pluginId === CLOUD)!;
    expect(cloud.granted).toEqual(["ui.slots", "backups.transport"]); // as stored: the tag covers it
    const cat = parseCatalog({
      v: 1,
      plugins: [
        {
          id: CLOUD,
          trust: "official",
          name: "Cloud Backup",
          publisher: "Sixkey",
          ceiling: ["ui.slots", "backups.transport"],
        },
      ],
    }).plugins[0];
    expect(heldNow(cloud, "official", cat)).toEqual(["ui.slots"]);
    expect(heldNow(cloud, "listed", cat)).toEqual(["ui.slots"]);
    expect(heldNow(cloud, "unlisted")).toEqual(["ui.slots"]);
  });
  it("only the retired name: any other one this version does not offer still makes the record damaged", async () => {
    for (const name of ["sites.propose", "codes.read", "ui.badge"]) {
      const { rec } = await stored(name);
      expect(parseRecord(JSON.parse(JSON.stringify(rec))), name).toBe("damaged");
    }
  });
});

describe("tighten only (§6.6 item 4)", () => {
  it("strength never goes down: approved < disabled < suspended < changed since review", () => {
    expect(strength("approved")).toBeLessThan(strength("disabled", "user"));
    expect(strength("disabled", "user")).toBeLessThan(strength("suspended", "changed"));
    expect(strength("suspended", "changed")).toBeLessThan(strength("suspended", "changed-since-review"));
    const s = entry(PID, { state: "suspended", reason: "changed-since-review" });
    expect(tightened(s, "suspended", "changed")).toBe(s); // a reason a user could lift never replaces one only a release can
    expect(tightened(s, "disabled", "user")).toBe(s);
    expect(tightened(entry(PID, { state: "suspended", reason: "changed" }), "disabled", "user").state).toBe(
      "suspended",
    );
  });
  it("the overlay can suspend, disable or remove, and never approve, grant or re-enable", () => {
    const e = [entry(PID), entry(OTHER, { state: "disabled", reason: "user" })];
    const after = withOverlay(e, [
      { pluginId: PID, action: "suspend", reason: "changed", at: 200 },
      { pluginId: OTHER, action: "suspend", reason: "changed", at: 200 },
    ]);
    expect(after.map((x) => [x.state, x.reason])).toEqual([
      ["suspended", "changed"],
      ["suspended", "changed"],
    ]);
    expect(withOverlay(e, [{ pluginId: PID, action: "remove", at: 200 }]).map((x) => x.pluginId)).toEqual([OTHER]);
    expect(withOverlay(e, [{ pluginId: PID, action: "disable", at: 200 }])[0]!.state).toBe("disabled");
    // grants and descriptors come from the record only
    expect(withOverlay(e, [{ pluginId: PID, action: "disable", at: 200 }])[0]!.granted).toEqual([
      "ui.slots",
      "env.read",
    ]);
  });
  it("an overlay entry older than the plugin's last loosening is stale: a later approval saw it", () => {
    const e = [entry(PID, { approvedAt: 300 })];
    expect(withOverlay(e, [{ pluginId: PID, action: "suspend", reason: "changed", at: 299 }])[0]!.state).toBe(
      "approved",
    );
    expect(withOverlay(e, [{ pluginId: PID, action: "suspend", reason: "changed", at: 300 }])[0]!.state).toBe(
      "approved",
    );
    expect(withOverlay(e, [{ pluginId: PID, action: "suspend", reason: "changed", at: 301 }])[0]!.state).toBe(
      "suspended",
    );
  });
  it("one overlay entry per plugin and action, the newest; at most 256", () => {
    let o = overlayWith([], { pluginId: PID, action: "suspend", reason: "changed", at: 1 });
    o = overlayWith(o, { pluginId: PID, action: "suspend", reason: "changed", at: 2 });
    o = overlayWith(o, { pluginId: PID, action: "disable", at: 3 });
    expect(o).toEqual([
      { pluginId: PID, action: "suspend", reason: "changed", at: 2 },
      { pluginId: PID, action: "disable", at: 3 },
    ]);
  });
  it("the user's transitions: on only from the user's off; a suspended plugin needs the approval screen", () => {
    let b = approved(emptyBody(), { descriptor: desc(), granted: ["ui.slots"], now: 1 });
    b = disabled(b, PID);
    expect(b.plugins[0]).toMatchObject({ state: "disabled", reason: "user", approvedAt: 1 });
    b = enabled(b, PID, 9);
    expect(b.plugins[0]).toMatchObject({ state: "approved", approvedAt: 9 });
    expect(b.plugins[0]).not.toHaveProperty("reason");
    b = { ...b, plugins: b.plugins.map((e) => tightened(e, "suspended", "changed")) }; // as an overlay merge leaves it
    expect(enabled(b, PID, 10).plugins[0]!.state).toBe("suspended");
    expect(disabled(b, PID).plugins[0]!.state).toBe("suspended");
    expect(removed(b, PID).plugins).toEqual([]);
    // approving again keeps the trash marks
    const t = { ...b, plugins: [{ ...b.plugins[0]!, trashed: ["entry-0001"] }] };
    expect(approved(t, { descriptor: desc(), granted: ["ui.slots"], now: 11 }).plugins[0]).toMatchObject({
      state: "approved",
      trashed: ["entry-0001"],
      approvedAt: 11,
    });
  });
});

describe("the store: verified reads, the epoch, the overlay merged, a failed tag", () => {
  it("approve, read back verified; hello's unverified read is the same", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(), ["ui.slots", "env.read"]);
    const r = await w.store.read(keys);
    expect(r.ok).toBe(true);
    expect(r.ok && r.plugins.map((p) => p.pluginId)).toEqual([PID]);
    expect((await w.store.unverified()).plugins.map((p) => p.pluginId)).toEqual([PID]);
    expect((await w.session.get([EPOCH_KEY]))[EPOCH_KEY]).toBe(1);
  });
  it("a record whose tag fails is kept, not honoured, and listed for review; nothing is wiped", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(), ["ui.slots"]);
    const stored = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY] as Record<string, unknown>;
    await w.local.set({ [GRANTS_KEY]: { ...stored, tag: "A".repeat(43) } });
    const r = await w.store.read(keys);
    expect(r.ok).toBe(false);
    expect(r.review.map((e) => e.pluginId)).toEqual([PID]);
    expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toMatchObject({ tag: "A".repeat(43) }); // kept as it was
    // another vault's key reads it as failed too
    expect((await w.store.read(keysOf(await newVk()))).ok).toBe(false);
  });
  it("approving one plugin again after a failed tag makes none of the others authentic (no laundering)", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    await w.store.approve(keys, desc(OTHER), ["ui.slots"]);
    // a writer to storage changes the record (it adds a third plugin under the old tag)
    const stored = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY] as { plugins: unknown[] };
    const forged = { ...stored, plugins: [...stored.plugins, entry(LISTED)] };
    await w.local.set({ [GRANTS_KEY]: forged });
    expect((await w.store.read(keys)).ok).toBe(false);
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    const r = await w.store.read(keys);
    expect(r.ok).toBe(true);
    expect(r.ok && r.plugins.map((p) => p.pluginId)).toEqual([PID]); // only what was approved again
    expect(r.review.map((e) => e.pluginId).sort()).toEqual([OTHER, LISTED].sort()); // the rest: for review, not honoured
    // kept aside, once, minus what was approved again
    expect((await w.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY]).toEqual({
      v: 1,
      plugins: (forged.plugins as GrantEntry[]).filter((e) => e.pluginId !== PID),
    });
    await w.store.forgetKept(LISTED);
    expect((await w.store.read(keys)).review.map((e) => e.pluginId)).toEqual([OTHER]);
    await w.store.approve(keys, desc(OTHER), ["ui.slots"]);
    expect((await w.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY]).toBeUndefined();
  });
  it("wave 2b's trash marks: book-keeping, never an approval: over a record that fails its tag, or one rolled back, nothing is written", async () => {
    // markTrashed writes right after an Apply the record verified for; should it have stopped verifying in between, the
    // record stays exactly as it is (only the user's approval starts a new one), nothing is kept aside, and the marks are
    // not kept: they could not be either way, a new record having no entry for the plugin (BUDGET3-NOTES.md §11)
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    const stored = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY] as Record<string, unknown>;
    const forged = { ...stored, tag: "A".repeat(43) };
    await w.local.set({ [GRANTS_KEY]: forged });
    const epoch = (await w.session.get([EPOCH_KEY]))[EPOCH_KEY];
    await expect(w.store.markTrashed(keys, PID, ["entry-gh-00001"])).resolves.toBeUndefined();
    expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toEqual(forged); // as it was
    expect((await w.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY]).toBeUndefined(); // nothing kept aside
    expect((await w.session.get([EPOCH_KEY]))[EPOCH_KEY]).toBe(epoch); // and no new record's epoch
    const r = await w.store.read(keys);
    expect(r.ok).toBe(false); // still the failed record, listed for review
    expect(r.review.map((e) => e.pluginId)).toEqual([PID]);
    // over the record verified again, the marks are kept as before
    await w.local.set({ [GRANTS_KEY]: stored });
    await w.store.markTrashed(keys, PID, ["entry-gh-00001"]);
    const v = await w.store.read(keys);
    expect(v.ok && v.plugins.find((e) => e.pluginId === PID)!.trashed).toEqual(["entry-gh-00001"]);
    // nor over one rolled back within the browser session: tagged with the vault's key, but older than the session's
    // epoch (§6.6 item 5). Neither the marks an Apply adds nor the drop of those of an account brought back writes it,
    // keeps it aside or starts a new record; a record kept aside before stays as it is too
    const older = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY];
    await w.store.setOn(keys, PID, false);
    await w.local.set({ [GRANTS_KEY]: older, [UNVERIFIED_KEY]: forged });
    const raised = (await w.session.get([EPOCH_KEY]))[EPOCH_KEY];
    expect(raised).toBeGreaterThan((older as { epoch: number }).epoch);
    const marks = () => w.store.markTrashed(keys, PID, ["entry-gh-00002"]);
    const unmarks = () => w.store.unmarkTrashed(keys, ["entry-gh-00001"]); // one marked in `older`: a change
    for (const book of [marks, unmarks]) {
      await expect(book()).resolves.toBeUndefined();
      expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toEqual(older);
      expect((await w.local.get([UNVERIFIED_KEY]))[UNVERIFIED_KEY]).toEqual(forged);
      expect((await w.session.get([EPOCH_KEY]))[EPOCH_KEY]).toBe(raised);
    }
    expect((await w.store.read(keys)).ok).toBe(false); // still refused
  });
  it("a record rolled back within the browser session is refused (its epoch is older than this session's)", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    const older = (await w.local.get([GRANTS_KEY]))[GRANTS_KEY];
    await w.store.setOn(keys, PID, false);
    await w.local.set({ [GRANTS_KEY]: older }); // the wider, earlier record put back
    const r = await w.store.read(keys);
    expect(r.ok).toBe(false);
    // and after a browser restart (the session's epoch gone) it reads: the stated residual (§6.6 item 5)
    await w.session.remove([EPOCH_KEY]);
    expect((await w.store.read(keys)).ok).toBe(true);
  });
  it("a verified read raises the session's epoch to the record's, never lowers it", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    await w.store.setOn(keys, PID, false);
    await w.session.set({ [EPOCH_KEY]: 0 });
    await w.store.read(keys);
    expect((await w.session.get([EPOCH_KEY]))[EPOCH_KEY]).toBe(2);
    await w.session.set({ [EPOCH_KEY]: 50 });
    expect((await w.store.read(keys)).ok).toBe(false); // 2 < 50: refused
    expect((await w.session.get([EPOCH_KEY]))[EPOCH_KEY]).toBe(50);
  });
  it("the overlay is honoured at once without the key, merged and re-tagged at the next verified read", async () => {
    let t = 1_000;
    const w = world(() => t);
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    t = 2_000;
    await w.store.tighten(PID, "suspend", "changed"); // the worker, locked
    expect((await w.store.unverified()).plugins[0]).toMatchObject({ state: "suspended", reason: "changed" });
    const r = await w.store.read(keys);
    expect(r.ok && r.plugins[0]).toMatchObject({ state: "suspended", reason: "changed" });
    expect((await w.local.get([OVERLAY_KEY]))[OVERLAY_KEY]).toBeUndefined(); // merged
    const rec = parseRecord((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]);
    expect(rec !== null && rec !== "damaged" && rec.plugins[0]!.state).toBe("suspended"); // in the tagged record now
    // approving again lifts it (the approval screen), and the merged entry cannot come back
    t = 3_000;
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    expect((await w.store.read(keys)).ok && (await w.store.unverified()).plugins[0]!.state).toBe("approved");
  });
  it("a storage writer can only narrow: an overlay entry that tries anything else is ignored", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    await w.store.setOn(keys, PID, false);
    await w.local.set({
      [OVERLAY_KEY]: {
        v: 1,
        entries: [
          { pluginId: PID, action: "enable", at: 9e12 },
          { pluginId: OTHER, action: "approve", at: 9e12 },
        ],
      },
    });
    const r = await w.store.read(keys);
    expect(r.ok && r.plugins.map((p) => [p.pluginId, p.state])).toEqual([[PID, "disabled"]]);
  });
  it("pauses live in the session: a pause after the last loosening holds until resumed", async () => {
    let t = 1_000;
    const w = world(() => t);
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    t = 2_000;
    await w.store.pause(PID);
    expect((await w.session.get([PAUSES_KEY]))[PAUSES_KEY]).toEqual({
      v: 1,
      pauses: [{ pluginId: PID, since: 2_000 }],
    });
    expect((await w.store.read(keys)).pauses).toEqual([{ pluginId: PID, since: 2_000 }]);
    await w.store.resume(PID);
    expect((await w.store.read(keys)).pauses).toEqual([]);
  });
  it("a key change: a read verifies under the current key only (the cleanup re-tags: plugins-rekey.test.ts)", async () => {
    const w = world();
    const old = await newVk(1);
    await w.store.approve(keysOf(old), desc(PID), ["ui.slots"]);
    const now = await newVk(2);
    const r = await w.store.read(keysOf(now));
    expect(r.ok).toBe(false);
    expect(r.review.map((p) => p.pluginId)).toEqual([PID]); // kept for review, never honoured
    expect((await w.store.read(keysOf(old))).ok).toBe(true); // nothing was rewritten
  });
  it("the versions Chrome reports are recorded as the approved ones, and nothing else changes (OD-2)", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    await w.store.approve(keys, desc(OTHER), ["ui.slots"]);
    const before = await w.store.read(keys);
    await w.store.recordVersions(keys, new Map([[PID, "1.4.2"]]));
    const after = await w.store.read(keys);
    if (!before.ok || !after.ok) throw new Error("fixture");
    expect(after.plugins.map((e) => [e.pluginId, e.descriptor.version])).toEqual([
      [PID, "1.4.2"],
      [OTHER, before.plugins[1]!.descriptor.version],
    ]);
    expect(after.plugins.map((e) => ({ ...e, descriptor: { ...e.descriptor, version: "" } }))).toEqual(
      before.plugins.map((e) => ({ ...e, descriptor: { ...e.descriptor, version: "" } })),
    );
  });
  it("removing a plugin deletes its grant (and its review entry); no record is written without the key", async () => {
    const w = world();
    const keys = keysOf(await newVk());
    await w.store.approve(keys, desc(PID), ["ui.slots"]);
    await w.store.remove(keys, PID);
    const r = await w.store.read(keys);
    expect(r.ok && r.plugins).toEqual([]);
    await w.store.tighten(PID, "suspend", "changed"); // locked: the overlay only
    expect((await w.local.get([GRANTS_KEY]))[GRANTS_KEY]).toMatchObject({ plugins: [] });
  });
});
