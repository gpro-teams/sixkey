// The cloud backup's status line (CLOUDBK patch 1; src/core/cloud/status.ts; CLOUD-BACKUP.md §6.2): the card always
// says how things are; the popup speaks only when the backup has stopped or changes have waited 3 days. The backup in
// Chrome sync (CSB-1) has the same lines, with errors and a stopping set of its own (csbStatus); the Google Drive
// backup's own (cloudStatus, its errors and stopping set) went with that path's code.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  csbStatus,
  csbStops,
  STALE_AFTER_MS,
  type CloudError,
  type CloudRecord,
  type CloudStatus,
  type CsbStoppingError,
} from "../../src/core/cloud/status";

const NOW = 1_900_000_000_000;
const MIN = 60_000;
const rec = (p: Partial<CloudRecord> = {}): CloudRecord => ({
  lastOk: NOW - 3 * MIN,
  err: null,
  errSince: null,
  pendingSince: null,
  ...p,
});

describe("csbStatus (the backup in Chrome sync)", () => {
  it.each<[string, boolean, CloudRecord, CloudStatus<CsbStoppingError>]>([
    ["off", false, rec({ err: "no_room" }), { kind: "off" }],
    ["handed to Chrome sync 3 minutes ago", true, rec(), { kind: "ok", at: NOW - 3 * MIN }],
    ["on, nothing written yet", true, rec({ lastOk: null }), { kind: "waiting", at: null }],
    ["a change waiting", true, rec({ pendingSince: NOW - MIN }), { kind: "waiting", at: NOW - 3 * MIN }],
    [
      "a write-operation quota: shown on the card only, retried",
      true,
      rec({ err: "busy", errSince: NOW - MIN, pendingSince: NOW - MIN }),
      { kind: "failed", err: "busy", at: NOW - 3 * MIN },
    ],
    [
      "any other refusal: shown on the card only, retried",
      true,
      rec({ err: "other", errSince: NOW - MIN, pendingSince: NOW - MIN }),
      { kind: "failed", err: "other", at: NOW - 3 * MIN },
    ],
    [
      "refusals for 3 days with changes waiting: stale",
      true,
      rec({ err: "busy", errSince: NOW - STALE_AFTER_MS, pendingSince: NOW - STALE_AFTER_MS }),
      { kind: "stale", err: "busy", since: NOW - STALE_AFTER_MS },
    ],
    [
      "changes waiting 3 days with no error recorded (the worker never ran)",
      true,
      rec({ pendingSince: NOW - STALE_AFTER_MS - 1 }),
      { kind: "stale", err: null, since: NOW - STALE_AFTER_MS - 1 },
    ],
    ["the vault alone over the room", true, rec({ err: "too_large" }), { kind: "stopped", err: "too_large" }],
    ["no room beside the other copies", true, rec({ err: "no_room" }), { kind: "stopped", err: "no_room" }],
    ["held until a page merges", true, rec({ err: "held" }), { kind: "stopped", err: "held" }],
    ["a device-key vault", true, rec({ err: "no_password" }), { kind: "stopped", err: "no_password" }],
    ["the vault cannot be read", true, rec({ err: "unreadable" }), { kind: "stopped", err: "unreadable" }],
    [
      "stopped beats stale: no room for 3 days says no room",
      true,
      rec({ err: "no_room", pendingSince: NOW - 10 * STALE_AFTER_MS }),
      { kind: "stopped", err: "no_room" },
    ],
  ])("%s", (_what, on, r, want) => {
    expect(csbStatus(on, r, NOW)).toEqual(want);
  });

  it("an old success with nothing waiting is not stale: the copy has everything", () => {
    expect(csbStatus(true, rec({ lastOk: NOW - 30 * STALE_AFTER_MS }), NOW)).toEqual({
      kind: "ok",
      at: NOW - 30 * STALE_AFTER_MS,
    });
  });

  it("turns stale exactly at 3 days", () => {
    expect(csbStatus(true, rec({ pendingSince: NOW - STALE_AFTER_MS + 1 }), NOW).kind).toBe("waiting");
    expect(csbStatus(true, rec({ pendingSince: NOW - STALE_AFTER_MS }), NOW).kind).toBe("stale");
  });

  it("stops on exactly its five errors", () => {
    const all: CloudError[] = ["too_large", "no_room", "held", "busy", "other", "no_password", "unreadable"];
    expect(all.filter(csbStops)).toEqual(["too_large", "no_room", "held", "no_password", "unreadable"]);
    expect(csbStops(null)).toBe(false);
  });

  it("for any record whose error does not stop it, the lines are the times' (as the Drive path's were)", () => {
    // the Google Drive backup's cloudStatus for an error it did not stop on, as its status.ts wrote it
    const lines = (on: boolean, r: CloudRecord): CloudStatus<CsbStoppingError> =>
      !on
        ? { kind: "off" }
        : r.pendingSince !== null && NOW - r.pendingSince >= STALE_AFTER_MS
          ? { kind: "stale", err: r.err, since: r.pendingSince }
          : r.err !== null
            ? { kind: "failed", err: r.err, at: r.lastOk }
            : r.pendingSince !== null || r.lastOk === null
              ? { kind: "waiting", at: r.lastOk }
              : { kind: "ok", at: r.lastOk };
    const err = fc.constantFrom<CloudError | null>(null, "busy", "other");
    const time = fc.option(fc.integer({ min: NOW - 30 * STALE_AFTER_MS, max: NOW }), { nil: null });
    fc.assert(
      fc.property(fc.boolean(), err, time, time, time, (on, e, lastOk, errSince, pendingSince) => {
        const r: CloudRecord = { lastOk, err: e, errSince, pendingSince };
        expect(csbStatus(on, r, NOW)).toEqual(lines(on, r));
      }),
      { numRuns: 300 },
    );
  });
});
