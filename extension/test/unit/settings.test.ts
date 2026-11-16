import { describe, expect, it } from "vitest";
import { MemoryKV } from "../../src/core/storage/kv";
import { applyPreset, detectPreset, PRESETS } from "../../src/core/service/presets";
import {
  DEFAULT_SETTINGS,
  displayOf,
  KvSettingsStore,
  parseSettings,
  type Settings,
} from "../../src/core/service/types";

const STANDARD_DISPLAY = { density: "standard", hideCodes: false, sort: "manual" };

describe("settings: the display fields", () => {
  it("a record saved before display existed gets the defaults, which are what the popup showed until now", () => {
    const old = { autoLock: { mode: "always" }, lockOnScreenLock: false };
    expect(parseSettings(old)).toEqual({
      autoLock: { mode: "always" },
      lockOnScreenLock: false,
      display: STANDARD_DISPLAY,
      profile: "solo", // QUICK-UNLOCK §5.12 item 5: not the shared preset's settings, so solo
    });
    expect(parseSettings(undefined)).toEqual({
      autoLock: { mode: "idle", minutes: 15 },
      lockOnScreenLock: true,
      display: STANDARD_DISPLAY,
      profile: "solo",
    });
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("an old record read through the store comes back complete, and reading does not write", async () => {
    const kv = new MemoryKV();
    await kv.set({ sk_settings: { autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: true } });
    const store = new KvSettingsStore(kv);
    expect(await store.get()).toEqual({
      autoLock: { mode: "idle", minutes: 5 },
      lockOnScreenLock: true,
      display: STANDARD_DISPLAY,
      profile: "solo",
    });
    expect(kv.data.get("sk_settings")).toEqual({ autoLock: { mode: "idle", minutes: 5 }, lockOnScreenLock: true });
  });

  it("round-trips every field through the store", async () => {
    const store = new KvSettingsStore(new MemoryKV());
    const all: Settings[] = [
      {
        autoLock: { mode: "session" },
        lockOnScreenLock: false,
        display: { density: "compact", hideCodes: true, sort: "name" },
        profile: "solo",
      },
      {
        autoLock: { mode: "idle", minutes: 90 },
        lockOnScreenLock: true,
        display: { density: "standard", hideCodes: true, sort: "manual" },
        profile: "shared",
      },
      {
        autoLock: { mode: "always" },
        lockOnScreenLock: true,
        display: { density: "compact", hideCodes: false, sort: "name" },
        profile: "solo",
      },
      {
        autoLock: { mode: "always" },
        lockOnScreenLock: true,
        display: { density: "standard", hideCodes: true, sort: "manual" },
        profile: "solo", // the shared preset's settings, declared solo: kept as declared
      },
    ];
    for (const s of all) {
      await store.set(s);
      expect(await store.get()).toEqual(s);
      expect(parseSettings(JSON.parse(JSON.stringify(parseSettings(s))))).toEqual(s);
    }
  });

  it("an invalid value falls back to its default without resetting the fields next to it", () => {
    const base = { autoLock: { mode: "always" }, lockOnScreenLock: false };
    expect(parseSettings({ ...base, display: { density: "huge", hideCodes: true, sort: "name" } }).display).toEqual({
      density: "standard",
      hideCodes: true,
      sort: "name",
    });
    expect(parseSettings({ ...base, display: { density: "compact", hideCodes: "yes", sort: "name" } }).display).toEqual(
      { density: "compact", hideCodes: false, sort: "name" },
    );
    expect(
      parseSettings({ ...base, display: { density: "compact", hideCodes: true, sort: "recent" } }).display,
    ).toEqual({ density: "compact", hideCodes: true, sort: "manual" });
    for (const display of [null, "compact", 3, [], { density: 1, hideCodes: 0, sort: null }]) {
      const s = parseSettings({ ...base, display });
      expect(s.display, JSON.stringify(display)).toEqual(STANDARD_DISPLAY);
      expect(s.autoLock).toEqual({ mode: "always" });
      expect(s.lockOnScreenLock).toBe(false);
    }
  });

  it("drops fields it does not know, inside display too", () => {
    const s = parseSettings({
      autoLock: { mode: "session" },
      lockOnScreenLock: true,
      theme: "dark",
      display: { density: "compact", hideCodes: false, sort: "manual", pinned: ["a"] },
    });
    expect(s).toEqual({
      autoLock: { mode: "session" },
      lockOnScreenLock: true,
      display: { density: "compact", hideCodes: false, sort: "manual" },
      profile: "solo",
    });
  });

  it("displayOf fills in a Settings built without display", () => {
    expect(displayOf({ autoLock: { mode: "always" }, lockOnScreenLock: true })).toEqual(STANDARD_DISPLAY);
    expect(
      displayOf({
        autoLock: { mode: "always" },
        lockOnScreenLock: true,
        display: { density: "compact", hideCodes: true, sort: "name" },
      }),
    ).toEqual({ density: "compact", hideCodes: true, sort: "name" });
  });
});

describe("security presets", () => {
  it("the presets are the ones the plan defines", () => {
    expect(PRESETS.standard).toEqual({
      autoLock: { mode: "idle", minutes: 15 },
      lockOnScreenLock: true,
      hideCodes: false,
      profile: "solo",
    });
    expect(PRESETS.shared).toEqual({
      autoLock: { mode: "always" },
      lockOnScreenLock: true,
      hideCodes: true,
      profile: "shared",
    });
  });

  it("detectPreset: the defaults are standard, the shared preset is shared, anything else is custom", () => {
    expect(detectPreset(DEFAULT_SETTINGS)).toBe("standard");
    expect(detectPreset({ autoLock: { mode: "idle", minutes: 15 }, lockOnScreenLock: true })).toBe("standard"); // no display field: defaults
    expect(detectPreset(applyPreset(DEFAULT_SETTINGS, "shared"))).toBe("shared");
    expect(detectPreset(applyPreset(applyPreset(DEFAULT_SETTINGS, "shared"), "standard"))).toBe("standard");
    const custom: Settings[] = [
      { ...DEFAULT_SETTINGS, autoLock: { mode: "idle", minutes: 10 } },
      { ...DEFAULT_SETTINGS, autoLock: { mode: "session" } },
      { ...DEFAULT_SETTINGS, lockOnScreenLock: false },
      { ...DEFAULT_SETTINGS, display: { density: "standard", hideCodes: true, sort: "manual" } },
      {
        ...applyPreset(DEFAULT_SETTINGS, "shared"),
        display: { density: "standard", hideCodes: false, sort: "manual" },
      },
      { ...applyPreset(DEFAULT_SETTINGS, "shared"), lockOnScreenLock: false },
      // the profile marker is part of a preset (QUICK-UNLOCK §5.12 item 5): either card's settings with the other profile
      { ...applyPreset(DEFAULT_SETTINGS, "shared"), profile: "solo" },
      { ...DEFAULT_SETTINGS, profile: "shared" },
      {
        ...applyPreset(DEFAULT_SETTINGS, "shared"),
        autoLock: { mode: "idle", minutes: 15 },
        display: { density: "standard", hideCodes: true, sort: "manual" },
      },
    ];
    for (const s of custom) expect(detectPreset(s), JSON.stringify(s)).toBe("custom");
  });

  it("density and sort do not affect which preset is detected", () => {
    const compactByName = {
      ...DEFAULT_SETTINGS,
      display: { density: "compact", hideCodes: false, sort: "name" },
    } satisfies Settings;
    expect(detectPreset(compactByName)).toBe("standard");
    expect(detectPreset(applyPreset(compactByName, "shared"))).toBe("shared");
  });

  it("applyPreset sets only the preset's fields, keeps density and sort, and does not change its input", () => {
    const before: Settings = {
      autoLock: { mode: "session" },
      lockOnScreenLock: false,
      display: { density: "compact", hideCodes: false, sort: "name" },
    };
    const copy = structuredClone(before);
    const shared = applyPreset(before, "shared");
    expect(shared).toEqual({
      autoLock: { mode: "always" },
      lockOnScreenLock: true,
      display: { density: "compact", hideCodes: true, sort: "name" },
      profile: "shared",
    });
    expect(applyPreset(shared, "standard")).toEqual({
      autoLock: { mode: "idle", minutes: 15 },
      lockOnScreenLock: true,
      display: { density: "compact", hideCodes: false, sort: "name" },
      profile: "solo",
    });
    expect(before).toEqual(copy);
    // the result shares nothing mutable with the preset table
    (shared.autoLock as { mode: string }).mode = "session";
    expect(PRESETS.shared.autoLock).toEqual({ mode: "always" });
  });

  it("a preset survives the store round trip and is still detected", async () => {
    const store = new KvSettingsStore(new MemoryKV());
    await store.set(applyPreset(await store.get(), "shared"));
    expect(detectPreset(await store.get())).toBe("shared");
  });
});
