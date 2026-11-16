// The request log (src/core/plugins/session.ts record and log) as it is now: autofill's gate writes a line for each ask
// (platform/plugins/autofill-gate.ts), and Settings › Security › Autofill shows autofill's last lines under the switch
// (options/AutofillSwitch.tsx). What it holds stays Sixkey's own words: a type that is not a request type of this version
// and an outcome that is not one of Sixkey's words are written as "other", so no code and no text a page or a plugin
// supplied reaches storage.session or the screen; each plugin keeps its last 20 lines and the log 100; and a flood (more
// than 30 lines a minute from one plugin) is not written at all. The rate is the module's (one per context), so each
// test below keeps to a time of its own.
import { describe, expect, it } from "vitest";
import { AUTOFILL_ID } from "../../src/core/plugins/builtin";
import { LOG_KEY, PluginSession, type LogEntry } from "../../src/core/plugins/session";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { BLOCKED, LISTED, OFFICIAL, OTHER, PID } from "../helpers/plugins";

const ask = "codes.forPage";
function world() {
  const kv = new MemoryKV();
  return { kv, s: new PluginSession(kv, createMutex()) };
}
const stored = (kv: MemoryKV) => JSON.stringify([...kv.data.values()]);
const line = (at: number, pluginId = AUTOFILL_ID, outcome = "ok", type = ask): LogEntry => ({
  at,
  pluginId,
  type,
  outcome,
});

describe("the request log's words", () => {
  it("the gate's lines as they are; any other type or outcome written as other, never as it came", async () => {
    const T = 1_000_000_000;
    const { kv, s } = world();
    await s.record(line(T, AUTOFILL_ID, "ok"));
    await s.record(line(T + 1, AUTOFILL_ID, "locked"));
    await s.record(line(T + 2, AUTOFILL_ID, "disabled"));
    // a code, a page's text, a word in capitals or too long: not Sixkey's words
    await s.record(line(T + 3, AUTOFILL_ID, "123456"));
    await s.record(line(T + 4, AUTOFILL_ID, "Code 654321 for alice"));
    await s.record(line(T + 5, AUTOFILL_ID, "OK"));
    await s.record(line(T + 6, AUTOFILL_ID, "a".repeat(33)));
    // a type that is no request of this version, a look-alike of Sixkey's own words included
    await s.record(line(T + 7, AUTOFILL_ID, "ok", "hello\u202e<b>"));
    await s.record(line(T + 8, AUTOFILL_ID, "ok", "unlock.required"));
    await s.record(line(T + 9, AUTOFILL_ID, "ok", "https://example.com/?code=123456"));
    expect((await s.log()).map((l) => [l.at - T, l.type, l.outcome])).toEqual([
      [0, ask, "ok"],
      [1, ask, "locked"],
      [2, ask, "disabled"],
      [3, ask, "other"],
      [4, ask, "other"],
      [5, ask, "other"],
      [6, ask, "other"],
      [7, "other", "ok"],
      [8, "other", "ok"],
      [9, "other", "ok"],
    ]);
    for (const w of ["123456", "654321", "alice", "OK", "\u202e", "<b>", "unlock.required", "example.com"])
      expect(stored(kv)).not.toContain(w);
  });

  it("what an earlier build stored is read with the same rule: an unknown type as other, a line of other words not at all", async () => {
    const { kv, s } = world();
    await kv.set({
      [LOG_KEY]: {
        v: 1,
        log: [
          { at: 1, pluginId: AUTOFILL_ID, type: "pin.expired", outcome: "invalid" },
          { at: 2, pluginId: AUTOFILL_ID, type: ask, outcome: "123456" },
          { at: 3, pluginId: "not-an-extension-id", type: ask, outcome: "ok" },
          { at: 4.5, pluginId: AUTOFILL_ID, type: ask, outcome: "ok" },
          { at: 5, pluginId: AUTOFILL_ID, type: ask, outcome: "ok" },
        ],
      },
    });
    expect((await s.log()).map((l) => [l.at, l.type, l.outcome])).toEqual([
      [1, "other", "invalid"],
      [5, ask, "ok"],
    ]);
    // nor is anything else there read as a log
    await kv.set({ [LOG_KEY]: { v: 2, log: [line(6)] } });
    expect(await s.log()).toEqual([]);
  });
});

describe("the request log's size", () => {
  it("each plugin keeps its last 20 lines, and one plugin's lines never crowd out another's", async () => {
    const T = 2_000_000_000;
    const { s } = world();
    await s.record(line(T, OTHER));
    for (let i = 1; i <= 25; i++) await s.record(line(T + i * 3_000)); // 20 a minute: under the rate
    const log = await s.log();
    const mine = log.filter((l) => l.pluginId === AUTOFILL_ID);
    expect(mine.map((l) => (l.at - T) / 3_000)).toEqual(Array.from({ length: 20 }, (_, i) => i + 6)); // its last 20
    expect(log.filter((l) => l.pluginId === OTHER).map((l) => l.at)).toEqual([T]); // still there
  });

  it("the log keeps its last 100 lines in all", async () => {
    const T = 3_000_000_000;
    const { s } = world();
    const ids = [AUTOFILL_ID, PID, LISTED, OFFICIAL, BLOCKED, OTHER];
    for (let i = 0; i < 20; i++) for (const [n, id] of ids.entries()) await s.record(line(T + i * 3_000 + n, id)); // 120 lines, 20 each
    const log = await s.log();
    expect(log).toHaveLength(100);
    // the 20 oldest went, whoever wrote them; the newest is the last one written
    const all = Array.from({ length: 20 }, (_, i) => ids.map((_, n) => T + i * 3_000 + n)).flat();
    expect(log.map((l) => l.at)).toEqual(all.slice(-100));
  });
});

describe("the request log's rate", () => {
  it("a flood is not written: 30 lines a minute per plugin, checked before the write; a minute later, written again", async () => {
    const T = 4_000_000_000;
    const { kv, s } = world();
    for (let i = 0; i < 40; i++) await s.record(line(T + i, AUTOFILL_ID, "locked"));
    // the first 30 written (the plugin keeps its last 20 of them); the 31st to the 40th never were
    expect((await s.log()).map((l) => l.at - T)).toEqual(Array.from({ length: 20 }, (_, i) => i + 10));
    // the others are not held back by it
    await s.record(line(T + 50, PID));
    expect((await s.log()).some((l) => l.pluginId === PID)).toBe(true);
    // within the same minute: still not written
    await s.record(line(T + 59_000));
    expect((await s.log()).some((l) => l.at === T + 59_000)).toBe(false);
    // a minute after the first lines: written
    await s.record(line(T + 60_030));
    expect((await s.log()).at(-1)).toMatchObject({ at: T + 60_030, pluginId: AUTOFILL_ID, outcome: "ok" });
    expect(stored(kv)).toContain(String(T + 60_030));
  });
});
