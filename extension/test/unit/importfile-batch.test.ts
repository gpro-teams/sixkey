// Camera scan (IMPORT-FILE-NOTES.md §4): a Google Authenticator export is several QR codes. They are collected across
// reads in any order, a code read twice counts once, a code of another export is refused (the first code read decides
// which export), and the scan ends only when every code is in.
import { describe, expect, it } from "vitest";
import {
  EMPTY_SCAN,
  scanProgress,
  scannedParts,
  seedScan,
  takeScan,
  type ScanState,
} from "../../src/core/import/scan-batch";
import { K1, link, migration } from "../helpers/import-fixtures";

const code = (index: number, size = 3, id = 77) =>
  migration([{ seed: index + 1, name: `acct${index}`, issuer: `Issuer${index}` }], { size, index, id });

function run(texts: string[], from: ScanState = EMPTY_SCAN) {
  let s = from;
  const events = texts.map((t) => {
    const r = takeScan(s, t);
    s = r.state;
    return r.event;
  });
  return { s, events };
}

describe("takeScan", () => {
  it("one otpauth:// code is the whole scan", () => {
    const { events } = run([link("A", "a", K1)]);
    expect(events).toEqual([{ k: "link", text: link("A", "a", K1) }]);
  });

  it("a three-code export read out of order: part, part, done with every code in index order", () => {
    const { s, events } = run([code(2), code(0), code(1)]);
    expect(events[0]).toEqual({ k: "part", index: 2, size: 3, missing: [0, 1] });
    expect(events[1]).toEqual({ k: "part", index: 0, size: 3, missing: [1] });
    expect(events[2]).toEqual({ k: "done", texts: [code(0), code(1), code(2)] });
    expect(scanProgress(s)).toEqual({ received: 3, size: 3, missing: [] });
  });

  it("a code read again is a repeat and changes nothing", () => {
    const { s, events } = run([code(0), code(0), code(0)]);
    expect(events.slice(1)).toEqual([
      { k: "repeat", index: 0 },
      { k: "repeat", index: 0 },
    ]);
    expect(scanProgress(s)).toEqual({ received: 1, size: 3, missing: [2, 3] });
  });

  it("a code of another export (another batch id, or another size) is refused and not taken", () => {
    const { s, events } = run([code(0), code(1, 3, 99), code(1, 4, 77), code(1)]);
    expect(events.map((e) => e.k)).toEqual(["part", "other_batch", "other_batch", "part"]);
    expect(scannedParts(s)).toEqual([code(0), code(1)]);
    expect(s.batchId).toBe(77);
  });

  it("anything else is not a 2FA code; a broken export code neither", () => {
    const { events } = run(["https://example.com", "otpauth-migration://offline?data=%%%", "", code(5)]);
    expect(events.map((e) => e.k)).toEqual(["not_otp", "not_otp", "not_otp", "not_otp"]); // index 5 of 3 is broken too
  });

  it("an export that says it has 2^31 codes is not one (it would be looped over): refused at once", () => {
    expect(run([code(0, 1001)]).events).toEqual([{ k: "not_otp" }]); // first: a bound that is missing fails here, fast
    expect(run([code(0, 1000)]).events[0]!.k).toBe("part");
    const t0 = performance.now();
    expect(run([code(0, 2 ** 31 - 1)]).events).toEqual([{ k: "not_otp" }]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("an export of one code (size 1, or an old one without a size) is done at once", () => {
    expect(run([code(0, 1)]).events).toEqual([{ k: "done", texts: [code(0, 1)] }]);
    expect(run([code(0, 0)]).events[0]!.k).toBe("done");
  });

  it("a link read while an export is being collected is taken, and the export goes on", () => {
    const { s, events } = run([code(0), link("A", "a", K1)]);
    expect(events[1]!.k).toBe("link");
    expect(s.batchId).toBe(77);
  });

  it("never changes the state it was given", () => {
    const before = run([code(0)]).s;
    const copy = new Map(before.parts);
    takeScan(before, code(1));
    expect(before.parts).toEqual(copy);
  });
});

describe("seedScan: a scan restarted after a stop goes on from the codes in the box", () => {
  it("the codes of one unfinished export in the box are taken as read", () => {
    const s = seedScan(`${link("A", "a", K1)}\n${code(0)}\n\n${code(2)}\n`);
    expect(scanProgress(s)).toEqual({ received: 2, size: 3, missing: [2] });
    expect(run([code(1)], s).events[0]!.k).toBe("done");
  });
  it("none, a finished one, or codes of two exports: the scan starts empty", () => {
    expect(seedScan(link("A", "a", K1))).toBe(EMPTY_SCAN);
    expect(seedScan([code(0), code(1), code(2)].join("\n"))).toBe(EMPTY_SCAN);
    expect(seedScan([code(0), code(1, 3, 99)].join("\n"))).toBe(EMPTY_SCAN);
  });
});
