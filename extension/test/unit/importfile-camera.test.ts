// Camera scan (IMPORT-FILE-NOTES.md §4), with a fake getUserMedia: every track of the stream stops on every way out
// (a code found, Cancel, an error, the tab hidden, the page left; a lock: import-file.spec.ts), a stream that arrives after a
// stop is stopped at once, frames are read one at a time, and a refusal is told from a missing or busy camera.
import { describe, expect, it } from "vitest";
import {
  CameraScan,
  cameraError,
  CONSTRAINTS,
  stopWhenAway,
  type CameraDeps,
  type CameraError,
  type StreamLike,
} from "../../src/platform/camera";

function fakeStream(n = 2) {
  const tracks = Array.from({ length: n }, () => ({
    stopped: 0,
    stop() {
      this.stopped++;
    },
  }));
  return {
    stream: { getTracks: () => tracks } as StreamLike,
    tracks,
    allStopped: () => tracks.every((t) => t.stopped > 0),
  };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(
  o: {
    frames?: (string[] | null)[];
    gum?: () => Promise<StreamLike>;
    showFails?: boolean;
    stopOn?: (t: string[]) => boolean;
  } = {},
) {
  const s = fakeStream();
  const log: string[] = [];
  const errors: CameraError[] = [];
  const shown: (StreamLike | null)[] = [];
  let frame = 0;
  let grabbing = 0;
  let maxGrabbing = 0;
  const deps: CameraDeps = {
    getUserMedia: o.gum ?? (async (c) => (log.push(`gum:${JSON.stringify(c)}`), s.stream)),
    show: async (x) => {
      shown.push(x);
      if (x && o.showFails) throw new Error("play failed");
    },
    grab: async () => {
      grabbing++;
      maxGrabbing = Math.max(maxGrabbing, grabbing);
      await tick();
      grabbing--;
      return o.frames?.[frame++] ?? null;
    },
    wait: () => tick(),
  };
  const lives: boolean[] = [];
  const cam = new CameraScan(deps, {
    onCodes: (t) => (o.stopOn ?? (() => true))(t),
    onError: (e) => errors.push(e),
    onLive: (l) => lives.push(l),
  });
  return { cam, s, log, errors, shown, lives, frames: () => frame, maxGrabbing: () => maxGrabbing };
}

describe("CameraScan", () => {
  it("asks for video only, the back camera preferred", async () => {
    expect(CONSTRAINTS.audio).toBe(false);
    expect(JSON.stringify(CONSTRAINTS.video)).toContain('"facingMode":{"ideal":"environment"}');
  });

  it("a code found: every track stops, the preview is taken away, the scan ends", async () => {
    const r = rig({ frames: [null, [], ["otpauth://totp/A?secret=JBSWY3DPEHPK3PXP"]] });
    await r.cam.start();
    expect(r.s.allStopped()).toBe(true);
    expect(r.shown.at(-1)).toBeNull();
    expect(r.lives).toEqual([true, false]);
    expect(r.cam.open).toBe(false);
    expect(r.frames()).toBe(3);
  });

  it("frames are read one at a time, never two at once", async () => {
    const r = rig({ frames: Array.from({ length: 6 }, () => ["x"]), stopOn: () => false });
    const run = r.cam.start();
    for (let i = 0; i < 30; i++) await tick();
    r.cam.stop();
    await run;
    expect(r.maxGrabbing()).toBe(1);
  });

  it("Cancel while live: every track stops and no frame is read after", async () => {
    const r = rig({ stopOn: () => false });
    const run = r.cam.start();
    for (let i = 0; i < 6; i++) await tick();
    r.cam.stop();
    const read = r.frames();
    await run;
    for (let i = 0; i < 6; i++) await tick();
    expect(r.s.allStopped()).toBe(true);
    expect(r.frames()).toBe(read);
  });

  it("Cancel while Chrome is still asking: the stream that arrives later is stopped at once, never shown", async () => {
    const s = fakeStream();
    let resolve!: (x: StreamLike) => void;
    const r = rig({ gum: () => new Promise((res) => (resolve = res)) });
    const run = r.cam.start();
    r.cam.stop();
    resolve(s.stream);
    await run;
    expect(s.allStopped()).toBe(true);
    expect(r.shown).toEqual([]);
    expect(r.cam.open).toBe(false);
  });

  it("a second start stops the first stream", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const queue = [first.stream, second.stream];
    const r = rig({ gum: async () => queue.shift()!, stopOn: () => false });
    const a = r.cam.start();
    await tick();
    await tick();
    const b = r.cam.start();
    await tick();
    expect(first.allStopped()).toBe(true);
    r.cam.stop();
    await Promise.all([a, b]);
    expect(second.allStopped()).toBe(true);
  });

  it("the preview cannot play: the tracks stop and the camera is reported as failed", async () => {
    const r = rig({ showFails: true });
    await r.cam.start();
    expect(r.s.allStopped()).toBe(true);
    expect(r.errors).toEqual(["failed"]);
  });

  it("getUserMedia refused or failing: reported, nothing left open", async () => {
    for (const [name, want] of [
      ["NotAllowedError", "denied"],
      ["SecurityError", "denied"],
      ["NotFoundError", "failed"],
      ["NotReadableError", "failed"],
      ["OverconstrainedError", "failed"],
      ["AbortError", "failed"],
    ] as const) {
      const r = rig({ gum: async () => Promise.reject(Object.assign(new Error("m"), { name })) });
      await r.cam.start();
      expect(r.errors, name).toEqual([want]);
      expect(r.cam.open).toBe(false);
    }
    expect(cameraError(new TypeError("no mediaDevices"))).toBe("failed");
    expect(cameraError(null)).toBe("failed");
  });
});

describe("stopWhenAway", () => {
  class Target {
    visibilityState = "visible";
    private fs = new Map<string, Set<() => void>>();
    addEventListener(t: string, f: () => void) {
      (this.fs.get(t) ?? this.fs.set(t, new Set()).get(t)!).add(f);
    }
    removeEventListener(t: string, f: () => void) {
      this.fs.get(t)?.delete(f);
    }
    fire(t: string) {
      for (const f of this.fs.get(t) ?? []) f();
    }
    count = () => [...this.fs.values()].reduce((n, s) => n + s.size, 0);
  }
  async function live() {
    const r = rig({ stopOn: () => false });
    const doc = new Target();
    const win = new Target();
    const unwatch = stopWhenAway(() => r.cam.stop(), { doc, win });
    const run = r.cam.start();
    for (let i = 0; i < 4; i++) await tick();
    expect(r.cam.open).toBe(true);
    return { r, doc, win, unwatch, run };
  }

  it("the tab hidden: the camera stops", async () => {
    const x = await live();
    x.doc.visibilityState = "hidden";
    x.doc.fire("visibilitychange");
    await x.run;
    expect(x.r.s.allStopped()).toBe(true);
  });

  it("a visibility change that leaves the tab visible does not stop it", async () => {
    const x = await live();
    x.doc.fire("visibilitychange");
    expect(x.r.cam.open).toBe(true);
    x.r.cam.stop();
    await x.run;
  });

  it("the page left: the camera stops", async () => {
    const x = await live();
    x.win.fire("pagehide");
    await x.run;
    expect(x.r.s.allStopped()).toBe(true);
  });

  it("stops listening when asked", async () => {
    const x = await live();
    x.unwatch();
    expect(x.doc.count() + x.win.count()).toBe(0);
    x.r.cam.stop();
    await x.run;
  });
});
