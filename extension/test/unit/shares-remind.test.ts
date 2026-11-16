// The shares reminder (docs/design/notes/SHAMIR-NOTES.md §4; the review's F1): after a switch to shares, the popup says
// after every unlock, from the next browser start on, to check the shares before destroying the old recovery code,
// until a check passes. It lives in the
// security record (src/core/service/security-log.ts `remind`), which the popup already reads once after an unlock, so
// the popup's reads do not change; the service worker makes it due at a start (VaultService.browserStarted).
import { describe, expect, it } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";
import { parseSecurityLog, SECURITY_LOG_KEY, SecurityLog } from "../../src/core/service/security-log";
import { readNotice } from "../../src/popup/notice";

const log = (kv = new MemoryKV(), at = { now: 1000 }) => ({ kv, at, s: new SecurityLog({ kv, now: () => at.now }) });
/** A switch's reminder: its own random id, and the set's id. */
const SW = { id: "0123456789abcdef", set: "7F2A" };
const SW2 = { id: "fedcba9876543210", set: "1C3B" };
const stored = async (kv: MemoryKV) => (await kv.get([SECURITY_LOG_KEY]))[SECURITY_LOG_KEY] as Record<string, unknown>;

describe("the security record's reminder", () => {
  it("set: stored with its time, not due, not in the view; started(): due, in the view as 'shares'", async () => {
    const { kv, s } = log();
    await s.remind(SW);
    expect((await stored(kv)).remind).toEqual({ kind: "shares", at: 1000, due: false, ...SW });
    expect((await s.read()).remind).toBeUndefined();
    await s.started();
    expect((await stored(kv)).remind).toEqual({ kind: "shares", at: 1000, due: true, ...SW });
    expect((await s.read()).remind).toBe("shares");
  });
  it("kept by every entry added and by an ack; dropped by remind(null) and by clearing the record", async () => {
    const { kv, s } = log();
    await s.append("unlock_failed");
    await s.remind(SW);
    await s.started();
    await s.append("recovery_used");
    await s.ack(1);
    expect((await s.read()).remind).toBe("shares");
    expect((await s.read()).entries.map((e) => e.kind)).toEqual(["recovery_used", "unlock_failed"]);
    await s.remind(null);
    expect((await stored(kv)).remind).toBeUndefined();
    await s.remind(SW);
    await s.clear();
    expect((await s.read()).remind).toBeUndefined();
  });
  it("started() without a reminder writes nothing; remind(null) without one writes nothing", async () => {
    const { kv, s } = log();
    await s.started();
    await s.remind(null);
    expect(await kv.get([SECURITY_LOG_KEY])).toEqual({});
  });
  it("a damaged reminder is dropped, never guessed at; a newer version's record is left alone", async () => {
    for (const bad of [
      { kind: "other", at: 1, due: true },
      { kind: "shares", at: -1, due: true },
      "shares",
      { kind: "shares", at: 1 },
    ])
      expect(parseSecurityLog({ v: 2, entries: [], remind: bad })).not.toHaveProperty("remind");
    const { kv, s } = log();
    await kv.set({ [SECURITY_LOG_KEY]: { v: 3, entries: [] } });
    await s.remind(SW);
    await s.started();
    expect(await stored(kv)).toEqual({ v: 3, entries: [] });
  });
  it("a read that throws writes nothing and does not reject", async () => {
    const kv = new MemoryKV();
    const s = new SecurityLog({ kv: { ...kv, get: async () => Promise.reject(new Error("io")) } as never });
    await expect(s.remind(SW)).resolves.toBeUndefined();
    await expect(s.started()).resolves.toBeUndefined();
  });
});

describe("put back, and checked (the review's N1, N7, FU-1, FU-2)", () => {
  it("remind() resolves to what was there before; putBack() restores it while the reminder is still that id's", async () => {
    const { kv, at, s } = log();
    expect(await s.remind(SW)).toBeNull(); // none before
    await s.started();
    const earlier = (await stored(kv)).remind as never;
    at.now = 2000;
    expect(await s.remind(SW2)).toEqual(earlier); // a later switch's, over it
    expect((await stored(kv)).remind).toEqual({ kind: "shares", at: 2000, due: false, ...SW2 });
    await s.putBack(SW.id, null); // not SW's any more: left alone
    expect((await stored(kv)).remind).toMatchObject(SW2);
    await s.putBack(SW2.id, earlier); // SW2's: the earlier one again, exactly
    expect((await stored(kv)).remind).toEqual(earlier);
    await s.putBack(SW.id, null); // the earlier one is SW's: none
    expect((await stored(kv)).remind).toBeUndefined();
    await s.putBack(SW.id, earlier); // none there: nothing (no reminder is ever made up)
    expect((await stored(kv)).remind).toBeUndefined();
    expect(await s.remind(null)).toBeNull();
  });
  it("two switches in the same millisecond: each knows its own by its id, not by the time", async () => {
    const { kv, s } = log();
    await s.remind(SW);
    await s.remind(SW2); // the same `at`
    await s.putBack(SW.id, null); // the first switch, refused: the second one's stays
    expect((await stored(kv)).remind).toMatchObject(SW2);
  });
  it("an id or a set that is not one is left out when read: such a reminder is never any switch's own", async () => {
    for (const [id, set] of [
      ["short", "7F2A"],
      ["0123456789ABCDEF", "7f2a"],
      [7, "12345"],
    ])
      expect(
        parseSecurityLog({ v: 2, entries: [], remind: { kind: "shares", at: 1, due: true, id, set } }),
      ).toMatchObject({
        remind: { kind: "shares", at: 1, due: true },
      });
    const { kv, s } = log();
    await kv.set({ [SECURITY_LOG_KEY]: { v: 2, entries: [], remind: { kind: "shares", at: 1, due: true } } }); // an older one
    await s.putBack(SW.id, null);
    expect((await stored(kv)).remind).toEqual({ kind: "shares", at: 1, due: true });
  });
  it("remind() resolves undefined when nothing was read or written: a newer version's record, a read that throws", async () => {
    const { kv, s } = log();
    await kv.set({ [SECURITY_LOG_KEY]: { v: 3, entries: [] } });
    expect(await s.remind(SW)).toBeUndefined();
    const broken = new SecurityLog({ kv: { ...kv, get: async () => Promise.reject(new Error("io")) } as never });
    expect(await broken.remind(SW)).toBeUndefined();
  });
  it("checked(): a pass drops a due reminder, keeps one not yet due; a fail keeps either; the set's id; none: no write", async () => {
    const { kv, s } = log();
    expect(await s.checked(true)).toEqual({ state: "none" });
    expect(await kv.get([SECURITY_LOG_KEY])).toEqual({});
    await s.remind(SW);
    expect(await s.checked(true)).toEqual({ state: "set", set: SW.set });
    expect(await s.checked(false)).toEqual({ state: "set", set: SW.set });
    expect((await stored(kv)).remind).toMatchObject({ due: false });
    await s.started();
    expect(await s.checked(false)).toEqual({ state: "due", set: SW.set });
    expect((await stored(kv)).remind).toMatchObject({ due: true });
    expect(await s.checked(true)).toEqual({ state: "due", set: SW.set });
    expect((await stored(kv)).remind).toBeUndefined();
    expect(await s.checked(true)).toEqual({ state: "none" });
    const broken = new SecurityLog({ kv: { ...kv, get: async () => Promise.reject(new Error("io")) } as never });
    expect(await broken.checked(true)).toEqual({ state: "none" });
  });
});

describe("the popup's notice after an unlock", () => {
  it("the reminder, when due, beside the count or alone; nothing before it is due", async () => {
    const { s } = log();
    const rt = { security: s };
    await s.remind(SW);
    expect(await readNotice(rt)).toBeNull();
    await s.started();
    expect(await readNotice(rt)).toEqual({ remind: true });
    await s.append("unlock_failed");
    expect(await readNotice(rt)).toEqual({ failed: 1, remind: true });
    await s.remind(null);
    expect(await readNotice(rt)).toEqual({ failed: 1 });
  });
});
