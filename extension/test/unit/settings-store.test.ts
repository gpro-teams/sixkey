// PHASE0X-PLAN C4/C5: the settings page's shared settings record (src/options/settings-store.ts). Panels change parts of
// one record; every change must start from the stored record and save all of it, one at a time, so none is lost.
import { describe, expect, it } from "vitest";
import { changeSettings } from "../../src/options/settings-store";
import { DEFAULT_SETTINGS, displayOf, parseSettings, type Settings } from "../../src/core/service/types";
import type { Runtime } from "../../src/platform/runtime";

/** A settings store with slow reads and writes, as chrome.storage can be; `failNext` makes the next write fail. */
function fakeRuntime() {
  let stored: Settings = parseSettings(DEFAULT_SETTINGS);
  const writes: Settings[] = [];
  const state = { failNext: false };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const service = {
    async getSettings() {
      await tick();
      return structuredClone(stored);
    },
    async updateSettings(next: Settings) {
      await tick();
      if (state.failNext) {
        state.failNext = false;
        throw new Error("write failed");
      }
      stored = parseSettings(next);
      writes.push(structuredClone(stored));
    },
  };
  return { rt: { service } as unknown as Runtime, writes, state, stored: () => stored };
}

describe("changeSettings", () => {
  it("changes made at the same time from different panels all land: each starts from the record as stored", async () => {
    const f = fakeRuntime();
    await Promise.all([
      changeSettings(f.rt, (s) => ({ ...s, display: { ...displayOf(s), density: "compact" } })), // Appearance
      changeSettings(f.rt, (s) => ({ ...s, autoLock: { mode: "idle", minutes: 30 } })), // Security mode
      changeSettings(f.rt, (s) => ({ ...s, display: { ...displayOf(s), sort: "name" } })),
      changeSettings(f.rt, (s) => ({ ...s, lockOnScreenLock: false })),
    ]);
    expect(f.stored()).toEqual({
      autoLock: { mode: "idle", minutes: 30 },
      lockOnScreenLock: false,
      display: { density: "compact", hideCodes: false, sort: "name" },
      profile: "solo",
    });
    expect(f.writes).toHaveLength(4);
  });

  it("saves the whole record, and resolves with it as the store keeps it", async () => {
    const f = fakeRuntime();
    const saved = await changeSettings(f.rt, (s) => ({ ...s, autoLock: { mode: "idle", minutes: 99_999 } }));
    expect(saved).toEqual({ ...parseSettings(DEFAULT_SETTINGS), autoLock: { mode: "idle", minutes: 1440 } }); // clamped, as stored
    expect(f.writes[0]).toEqual(saved);
    expect(Object.keys(f.writes[0]!).sort()).toEqual(["autoLock", "display", "lockOnScreenLock", "profile"]);
  });

  it("a failed save rejects, and the next change still runs", async () => {
    const f = fakeRuntime();
    f.state.failNext = true;
    const failed = changeSettings(f.rt, (s) => ({ ...s, lockOnScreenLock: false }));
    const next = changeSettings(f.rt, (s) => ({ ...s, display: { ...displayOf(s), hideCodes: true } }));
    await expect(failed).rejects.toThrow("write failed");
    await expect(next).resolves.toMatchObject({ lockOnScreenLock: true, display: { hideCodes: true } });
  });
});
