// Hybrid logical clock. A timestamp is a fixed-width string, so plain string comparison orders them:
//   <13 digit wall ms>.<4 hex counter>.<device id>
// The device id makes timestamps from different devices distinct, so there are no ties between devices.
import { randomBytes, type Random } from "../crypto/bytes";

export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000; // remote clocks further ahead than this are clamped
const HLC_RE = /^(\d{13})\.([0-9a-f]{4})\.([a-z0-9]{4,16})$/;
const DEVICE_RE = /^[a-z0-9]{4,16}$/;
const MAX_COUNTER = 0xffff;

export type Hlc = string;
export type Parsed = { wall: number; counter: number; device: string };

export function parseHlc(h: string): Parsed | null {
  const m = HLC_RE.exec(h);
  return m ? { wall: Number(m[1]), counter: parseInt(m[2]!, 16), device: m[3]! } : null;
}

export function isHlc(h: unknown): h is Hlc {
  return typeof h === "string" && HLC_RE.test(h);
}

export function formatHlc(wall: number, counter: number, device: string): Hlc {
  if (!DEVICE_RE.test(device)) throw new RangeError("bad device id");
  if (!Number.isSafeInteger(wall) || wall < 0 || wall > 9_999_999_999_999) throw new RangeError("bad wall time");
  return `${String(wall).padStart(13, "0")}.${counter.toString(16).padStart(4, "0")}.${device}`;
}

/** The smallest timestamp after `h` for this device. */
export function succHlc(h: Hlc, device: string): Hlc {
  const p = parseHlc(h);
  if (!p) throw new RangeError("bad hlc");
  return p.counter >= MAX_COUNTER ? formatHlc(p.wall + 1, 0, device) : formatHlc(p.wall, p.counter + 1, device);
}

export function newDeviceId(rng: Random = randomBytes): string {
  return Array.from(rng(8), (b) => (b % 36).toString(36)).join("");
}

/** Pull an untrusted timestamp back to at most now + 24h so one wrong clock cannot win every future edit. */
export function clampHlc(h: Hlc, now: number): Hlc {
  const p = parseHlc(h);
  if (!p) throw new RangeError("bad hlc");
  const limit = now + MAX_FUTURE_DRIFT_MS;
  return p.wall > limit ? formatHlc(limit, p.counter, p.device) : h;
}

export type Clock = {
  readonly device: string;
  /** A timestamp strictly greater than any this clock has produced or observed. */
  next(): Hlc;
  /** Fold in a timestamp seen from elsewhere, so later local edits sort after it. */
  observe(remote: Hlc): void;
};

export function createClock(device: string, opts: { now?: () => number; last?: Hlc } = {}): Clock {
  const now = opts.now ?? Date.now;
  let wall = 0;
  let counter = 0;
  const seed = opts.last ? parseHlc(opts.last) : null;
  if (seed) {
    wall = seed.wall;
    counter = seed.counter;
  }
  return {
    device,
    next() {
      const pt = now();
      if (pt > wall) {
        wall = pt;
        counter = 0;
      } else if (counter >= MAX_COUNTER) {
        wall += 1;
        counter = 0;
      } else {
        counter += 1;
      }
      return formatHlc(wall, counter, device);
    },
    observe(remote) {
      const p = parseHlc(remote);
      if (!p) return;
      const limit = now() + MAX_FUTURE_DRIFT_MS;
      const rw = Math.min(p.wall, limit);
      const rc = p.wall > limit ? 0 : p.counter;
      if (rw > wall) {
        wall = rw;
        counter = rc;
      } else if (rw === wall && rc > counter) counter = rc;
    },
  };
}
