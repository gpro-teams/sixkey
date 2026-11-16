// The toolbar badge in words (src/platform/sync-worker.ts, M5-NOTES §12 item 4): the badge alone says nothing to a screen
// reader, so while it shows the waiting approvals the button's title says so, and it is "Sixkey" again when it clears.
import { describe, expect, it } from "vitest";
import { badgeTitle, SyncWorker, WorkerScheduler, type WorkerChrome } from "../../src/platform/sync-worker";
import type { SyncEngine } from "../../src/core/sync/engine/engine";

function fake() {
  const titles: string[] = [];
  const badges: string[] = [];
  const c: WorkerChrome = {
    alarms: { create: () => undefined, clear: async () => true, get: async () => ({ name: "x" }) },
    setBadgeText: async (t) => {
      badges.push(t);
    },
    setBadgeTitle: async (t) => {
      titles.push(t);
    },
    ping: async () => undefined,
    permissions: {
      contains: async () => true,
      request: async () => true,
      remove: async () => true,
      getAll: async () => ({ origins: ["https://api.sixkey.app/*"] }),
    },
  };
  return { c, titles, badges };
}

describe("the badge's title", () => {
  it("the badge in the browser's words while it shows, the extension's name otherwise", () => {
    const words = (n: string) => `Sixkey · devices waiting for approval: ${n}`;
    expect(badgeTitle("2", words)).toBe("Sixkey · devices waiting for approval: 2");
    expect(badgeTitle("99+", words)).toBe("Sixkey · devices waiting for approval: 99+");
    expect(badgeTitle("", words)).toBe("Sixkey");
  });

  it("follows the badge: set with it, reset when it clears, written only when the badge changes", async () => {
    const f = fake();
    let pending = 2;
    const engine = {
      view: async () => ({ syncOn: true, state: { status: "ok", pendingEnrollments: pending } }),
      start: async () => undefined,
    } as unknown as SyncEngine;
    const w = new SyncWorker({
      engine,
      scheduler: new WorkerScheduler(f.c),
      chrome: f.c,
      transport: {
        send: async () => {
          throw new Error("no");
        },
      },
      keyHere: async () => false,
      words: (n) => `waiting: ${n}`,
    });
    await w.changed();
    await w.changed();
    pending = 0;
    await w.changed();
    expect(f.badges).toEqual(["2", ""]);
    expect(f.titles).toEqual(["waiting: 2", "Sixkey"]);
  });

  it("without words (a caller that passes none), the title is left alone", async () => {
    const f = fake();
    const engine = {
      view: async () => ({ syncOn: true, state: { status: "ok", pendingEnrollments: 1 } }),
      start: async () => undefined,
    } as unknown as SyncEngine;
    const w = new SyncWorker({
      engine,
      scheduler: new WorkerScheduler(f.c),
      chrome: f.c,
      transport: {
        send: async () => {
          throw new Error("no");
        },
      },
      keyHere: async () => false,
    });
    await w.changed();
    expect(f.badges).toEqual(["1"]);
    expect(f.titles).toEqual([]);
  });
});
