// F-1 (docs/design/notes/PLUGINS-W1C-NOTES.md; the W1c review's W1C-08): a lone UTF-16 surrogate, which Chrome carries
// through a message as it is (the review's E8), is refused where a plugin's strings are first taken. In r1 it passed
// isPlainText and reached JCS, which threw: an approved plugin's hello answered `internal`, an approval failed at the
// grant record's tag, and in W2 a stored issuer or label would have broken an account's export and QR code (its
// encodeURIComponent throws). Now: plain text refuses it, a descriptor that holds one anywhere (a URL too) is invalid, and
// any request that holds one anywhere (a key too) is answered `invalid` at the schema check, before its body is read.
import { describe, expect, it } from "vitest";
import { contributionsHash, readDescriptor, type Descriptor } from "../../src/core/plugins/descriptor";
import type { GrantEntry } from "../../src/core/plugins/grants";
import { createRate, dispatch, type Channel } from "../../src/core/plugins/protocol";
import { displayText, isPlainText, wellFormed } from "../../src/core/plugins/text";
import { descriptor, PID } from "../helpers/plugins";

const LONE = [0xd800, 0xdbff, 0xdc00, 0xdfff].map((c) => String.fromCharCode(c));
const HANDLE = "abcdefghijklmnop";

describe("plain text and well-formedness", () => {
  it("a lone half of a pair is not plain text, wherever it is; a pair is a character", () => {
    for (const l of LONE)
      for (const s of [l, `a${l}`, `${l}b`, `a${l}b`, `${l}${l}`])
        expect(isPlainText(s, 0, 40), JSON.stringify(s)).toBe(false);
    expect(isPlainText("\udc00\ud800", 0, 40)).toBe(false); // the halves the wrong way round
    expect(isPlainText("Generator 😀", 1, 40)).toBe(true);
    expect(isPlainText("😀", 1, 1)).toBe(true);
    expect(displayText("a\ud800b 😀", 40)).toBe("ab 😀"); // drawn without it
  });
  it("wellFormed walks every string and key, nested, without the call stack", () => {
    expect(wellFormed({ a: ["x", { b: "y 😀" }], c: 1, d: null })).toBe(true);
    expect(wellFormed({ a: ["x", { b: "y\ud800" }] })).toBe(false);
    expect(wellFormed({ a: { ["k\udfff"]: 1 } })).toBe(false);
    expect(wellFormed("\udc00")).toBe(false);
    let deep: unknown = "\ud800";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(wellFormed(deep)).toBe(false);
  });
});

describe("a descriptor that holds one is invalid", () => {
  it("in its name, its description, a title, a locale's text, the publisher's URL, an unknown field", () => {
    for (const over of [
      { name: "Generator \ud800" },
      { description: "\udc00" },
      { contributions: [{ id: "generate", slot: "popup.menu", title: "Gen\udbff", icon: { builtin: "dice" } }] },
      { locales: { zh_CN: { name: "密\ud800" } } },
      { publisher: { name: "P", url: "https://example.org/\ud800" } },
      { future: { ["k\udfff"]: 1 } },
    ])
      expect(readDescriptor(descriptor(PID, over)), JSON.stringify(over)).toEqual({ ok: false, error: "invalid" });
  });
});

/** Sixkey's answer to `msg` from the plugin, approved or not, by message (its worker) or on a port. */
async function answer(msg: unknown, approved: boolean, ch: Channel) {
  const r = readDescriptor(descriptor(PID));
  if (!r.ok) throw new Error("fixture");
  const d: Descriptor = r.descriptor;
  const entry: GrantEntry | undefined = approved
    ? { pluginId: PID, state: "approved", descriptor: d, granted: ["ui.slots", "env.read"], approvedAt: 0, trashed: [] }
    : undefined;
  const seen: unknown[] = [];
  const changed: unknown[] = [];
  const res = await dispatch(msg, PID, ch, {
    catalog: { v: 1, plugins: [] },
    install: null,
    now: 1_000,
    rate: createRate(),
    sixkeyVersion: "0.1.0",
    entry,
    pauses: [],
    seen: async (h) => (seen.push(h), true),
    changed: async (why) => void changed.push(why),
    env: async () => ({ theme: "light", locale: "en", sixkeyVersion: "0.1.0" }),
  });
  return { res, seen, changed };
}
const req = (type: string, body: unknown, extra: Record<string, unknown> = {}) => ({
  sdk: 1,
  id: "req-00000001",
  type,
  body,
  ...extra,
});
const WORKER: Channel = { kind: "message", sender: { id: PID, url: `chrome-extension://${PID}/sw.js` } };

describe("a request that holds one anywhere is answered `invalid` at the schema check, before its body is read", () => {
  it("an approved plugin's hello (r1: JCS threw, `internal`), by message and on a port; nothing kept, nothing paused", async () => {
    for (const ch of [WORKER, { kind: "port" } as Channel]) {
      const a = await answer(
        req("hello", { descriptor: descriptor(PID, { name: `Password Generator ${LONE[0]}` }) }),
        true,
        ch,
      );
      expect(a.res).toEqual({ sdk: 1, re: "req-00000001", ok: false, error: { code: "invalid" } });
      expect(a.seen).toEqual([]);
      expect(a.changed).toEqual([]);
    }
  });
  it("in a body's text (W2's issuers and labels), a key's shortcut, an envelope's key", async () => {
    for (const msg of [
      req("accounts.update", { changes: [{ handle: HANDLE, issuer: `A${LONE[1]}` }] }),
      req("accounts.add", { accounts: [{ uri: `otpauth://totp/x${LONE[2]}` }], source: "Import" }),
      req("hello", { descriptor: descriptor(PID), keys: { "capture-page": `Alt+Shift+S${LONE[3]}` } }),
      req("env.get", {}, { [`x${LONE[0]}`]: 1 }),
    ]) {
      const a = await answer(msg, true, WORKER);
      expect(a.res, JSON.stringify(msg)).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
  });
  it("and the same requests without it are answered as before", async () => {
    expect((await answer(req("hello", { descriptor: descriptor(PID) }), true, WORKER)).res).toMatchObject({
      ok: true,
      body: { state: "approved" },
    });
    expect((await answer(req("env.get", {}), true, WORKER)).res).toMatchObject({ ok: true, body: { theme: "light" } });
    // the pin of a stored descriptor can always be worked out (JCS meets no lone half)
    const r = readDescriptor(descriptor(PID));
    expect(r.ok && (await contributionsHash(r.descriptor))).toMatch(/^[0-9a-f]{64}$/);
  });
});
