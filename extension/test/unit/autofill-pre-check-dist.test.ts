// scripts/sw-order.mjs, the check on the BUILT service worker (TOTP-AUTOFILL §4.2): the first three calls of its top-level
// code are storage.local.setAccessLevel, storage.session.setAccessLevel and storage.sync.setAccessLevel (the backup in
// Chrome's sync storage: CSB-3, the maintainers' C7). Here it is tried on small stand-in bundles;
// test/unit/m5-check-dist.test.ts runs check-dist on real builds altered to break the order.
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script with no type declarations
import { swAccessLevelOrder } from "../../scripts/sw-order.mjs";

const order = swAccessLevelOrder as (src: string) => { ok: boolean; reason: string; first: string[] };
const L = "chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});";
const S = "chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});";
const Y = "chrome.storage.sync.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});";
const LISTEN = "chrome.runtime.onMessage.addListener(function(){});";
const READ = "chrome.storage.local.get('k');";

describe("swAccessLevelOrder", () => {
  it("passes when the three calls come first, in any order, whatever follows", () => {
    expect(order(`${L}${S}${Y}${LISTEN}${READ}`).ok).toBe(true);
    expect(order(`${S}${L}${Y}${READ}${LISTEN}`).ok).toBe(true);
    expect(order(`${Y}${S}${L}${READ}${LISTEN}`).ok).toBe(true);
    expect(order(`var a=(function(){${L}${S}})();${Y}${LISTEN}`).ok).toBe(true);
  });

  const bad: [string, string][] = [
    ["a listener before the calls", `${LISTEN}${L}${S}${Y}`],
    ["a storage read before the calls", `${READ}${L}${S}${Y}`],
    ["a listener between the calls", `${L}${LISTEN}${S}${Y}`],
    ["a listener before storage.sync's", `${L}${S}${LISTEN}${Y}`],
    ["a storage read before storage.sync's", `${L}${S}${READ}${Y}`],
    ["the calls after everything", `${LISTEN}${READ}${L}${S}${Y}`],
    ["the calls deferred (a timer never runs here)", `setTimeout(function(){${L}${S}${Y}},0);${LISTEN}`],
    ["storage.sync's deferred", `${L}${S}setTimeout(function(){${Y}},0);${LISTEN}`],
    ["only local", `${L}${LISTEN}`],
    ["only session", `${S}${LISTEN}`],
    ["local and session, no storage.sync (the start before CSB-3)", `${L}${S}${LISTEN}`],
    ["only storage.sync", `${Y}${LISTEN}`],
    ["local twice", `${L}${L}${S}${Y}`],
    ["storage.sync twice", `${L}${S}${Y}${Y}`],
    ["a fourth call", `${L}${S}${Y}${L}`],
    ["no calls at all", `${LISTEN}`],
    ["the top level throws", `throw new Error('x');`],
  ];
  for (const [what, src] of bad)
    it(`fails: ${what}`, () => {
      const r = order(src);
      expect(r.ok, what).toBe(false);
      expect(r.reason.length).toBeGreaterThan(10);
    });
});
