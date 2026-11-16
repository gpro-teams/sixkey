// Checks the probe itself against Chrome's virtual authenticator (CDP WebAuthn domain), so that the owner's real-hardware
// run measures the hardware and not a bug in the probe. It cannot tell anything about Touch ID or Windows Hello.
//
// Run from the repository root (uses the Playwright that extension/ already has; nothing is installed):
//   nice -n 19 node tools/webauthn-probe/test/verify.mjs
//
// Headless, one browser, a throwaway profile under the OS temp directory, deleted at the end. No server, no port.

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, "..");
const require = createRequire(resolve(here, "../../../extension/package.json"));
const { chromium } = require("@playwright/test");

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(
      `FAIL ${name}\n     ${String(e?.stack ?? e)
        .split("\n")
        .slice(0, 4)
        .join("\n     ")}`,
    );
  }
}

// ---- static checks on the manifest: the promises of the README ----
await scenario("manifest: only the storage permission, no host access, connect-src 'none'", async () => {
  const m = JSON.parse(readFileSync(join(PROBE, "manifest.json"), "utf8"));
  assert.deepEqual(m.permissions, ["storage"]);
  for (const k of [
    "host_permissions",
    "optional_host_permissions",
    "optional_permissions",
    "content_scripts",
    "externally_connectable",
  ])
    assert.equal(m[k], undefined, k);
  assert.match(m.content_security_policy.extension_pages, /connect-src 'none'/);
});

const userDataDir = mkdtempSync(join(tmpdir(), "sixkey-webauthn-probe-"));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium", // bundled Chromium: branded Chrome ignores --load-extension
  args: [`--disable-extensions-except=${PROBE}`, `--load-extension=${PROBE}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const id = new URL(sw.url()).host;
const url = (q = "ctx=tab") => `chrome-extension://${id}/probe.html?${q}`;

const BASE = {
  protocol: "ctap2",
  ctap2Version: "ctap2_1",
  transport: "internal", // a platform authenticator, as Touch ID / Windows Hello
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  hasPrf: true,
  automaticPresenceSimulation: true,
};

/**
 * A fresh page with a virtual authenticator. Observed: an authenticator that is not removed explicitly still answers
 * for a later page of the same browser, so every scenario ends with done(), which removes it.
 */
async function open(options, q) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { ...BASE, ...options } });
  await page.goto(url(q));
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Ready"));
  const done = async () => {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.send("WebAuthn.disable");
    await page.close();
  };
  return { page, cdp, authenticatorId, done };
}
const report = async (page) => JSON.parse(await page.locator("#report").inputValue());
// Final status lines start with "create: " / "get A1: "; the waiting ones with "create(): " / "get() A1: ".
const clickAndWait = async (page, id, pattern) => {
  await page.click(`#${id}`);
  await page.waitForFunction(
    (re) => new RegExp(re).test(document.getElementById("status").textContent) && document.body.dataset.busy === "0",
    pattern.source,
    { timeout: 20_000 },
  );
};
const clearAll = async (page) => {
  await page.click("#clear");
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Probe data cleared"));
};

/** No secret-looking strings: only 16-hex prefixes, AAGUIDs, base64url run IDs (12 chars) and ordinary text. */
function assertNoSecrets(text) {
  const longHex = text.match(/\b[0-9a-f]{17,}\b/g) ?? [];
  assert.deepEqual(longHex, [], "a hex string longer than a 16-digit prefix");
  // A credential ID or PRF output in base64url would contain digits or - _; long identifiers of the report do not.
  const longB64 = (text.match(/[A-Za-z0-9_-]{40,}/g) ?? []).filter((s) => /[0-9_-]/.test(s));
  assert.deepEqual(longB64, [], "a long base64url string (a credential ID or PRF output?)");
}

await scenario(
  "PRF-capable platform authenticator: create, 3 gets, consistent PRF, verified signatures, BE=0",
  async () => {
    const { page, done } = await open({});
    await clickAndWait(page, "create", /^create: /);
    await clickAndWait(page, "gets", /^get A1: /);
    const r = await report(page);
    const [create, ...gets] = r.results;
    assert.equal(create.ok, true, JSON.stringify(create.error));
    assert.equal(create.authenticatorAttachment, "platform");
    assert.equal(create.authenticatorData.flags.UV, true);
    assert.equal(create.authenticatorData.flags.BE, false);
    assert.equal(create.clientData.originMatchesPage, true);
    assert.equal(create.clientData.challengeMatches, true);
    assert.equal(create.rpIdHash.extensionOrigin, true, "Chrome should hash chrome-extension://<id> as the RP ID");
    assert.equal(create.prf.present, true);
    assert.equal(gets.length, 3);
    for (const g of gets) {
      assert.equal(g.ok, true, JSON.stringify(g.error));
      assert.equal(g.matchesSavedCredential, true);
      assert.equal(g.signatureVerified, true);
      assert.equal(g.prf.resultsFirstPresent, true);
      assert.match(g.prf.firstSha256Prefix, /^[0-9a-f]{16}$/);
    }
    assert.equal(r.prfConsistency.sameSaltSameValue, true);
    assert.equal(r.prfConsistency.differentSaltDifferentValue, true);
    if (create.prf.resultsFirstPresent) assert.equal(r.prfConsistency.createValueEqualsGetValue, true);
    assertNoSecrets(JSON.stringify(r));
    // The discoverable path (what a user would use after a browser restart) finds the same credential and value.
    await clickAndWait(page, "discoverable", /^get D1: /);
    const r2 = await report(page);
    const d = r2.results.at(-1);
    assert.equal(d.ok, true, JSON.stringify(d.error));
    assert.equal(d.prf.firstSha256Prefix, gets[0].prf.firstSha256Prefix);
    assert.equal(r2.prfConsistency.sameSaltSameValue, true);
    await clearAll(page);
    await done();
  },
);

await scenario("no PRF support: reported as not returned, consistency stays null", async () => {
  const { page, done } = await open({ hasPrf: false });
  await clickAndWait(page, "create", /^create: /);
  await clickAndWait(page, "gets", /^get A1: /);
  const r = await report(page);
  assert.equal(r.results[0].ok, true);
  assert.notEqual(r.results[0].prf.enabled, true);
  for (const g of r.results.slice(1)) assert.notEqual(g.prf.resultsFirstPresent, true);
  assert.equal(r.prfConsistency.sameSaltSameValue, null);
  await clearAll(page);
  await done();
});

await scenario("synced passkey: BE and BS flags reported", async () => {
  const { page, done } = await open({ defaultBackupEligibility: true, defaultBackupState: true });
  await clickAndWait(page, "create", /^create: /);
  const r = await report(page);
  assert.equal(r.results[0].authenticatorData.flags.BE, true);
  assert.equal(r.results[0].authenticatorData.flags.BS, true);
  await clearAll(page);
  await done();
});

await scenario("user verification fails: the error is recorded verbatim (name and message)", async () => {
  const { page, done } = await open({ isUserVerified: false });
  await clickAndWait(page, "create", /^create: /);
  const r = await report(page);
  assert.equal(r.results[0].ok, false);
  assert.equal(typeof r.results[0].error.name, "string");
  assert.equal(typeof r.results[0].error.message, "string");
  await clearAll(page);
  await done();
});

await scenario("a page closed while get() waits is recorded as closed during the ceremony", async () => {
  const a = await open({});
  await clickAndWait(a.page, "create", /^create: ok/);
  await a.cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: a.authenticatorId, enabled: false });
  await a.page.click("#gets"); // never resolves now: presence is never given
  await a.page.waitForFunction(() => document.getElementById("status").textContent.startsWith("get() A1: waiting"));
  await a.page.waitForTimeout(300);
  await a.done();
  await new Promise((r) => setTimeout(r, 500)); // let the worker write the disconnect before the next page reads it
  const b = await open({}, "ctx=window");
  await b.page.waitForFunction(() => !document.getElementById("previous").hidden, null, { timeout: 5000 });
  const r = await report(b.page);
  const gone = r.lifecycle.find((l) => !l.current && l.closedDuringCeremony);
  assert.ok(gone, JSON.stringify(r.lifecycle));
  assert.equal(gone.closedDuringCeremony, "get:A1");
  assert.equal(r.environment.context, "window");
  await clearAll(b.page);
  await b.done();
});

await scenario(
  "blob extensions supported: largeBlob written and read back, credBlob read back, no blob printed",
  async () => {
    const { page, done } = await open({ hasLargeBlob: true, hasCredBlob: true });
    await page.selectOption("#blobs", "both");
    await clickAndWait(page, "create", /^create: /);
    await clickAndWait(page, "blobtests", /^blob tests: /);
    const r = await report(page);
    const create = r.results[0];
    assert.equal(create.ok, true, JSON.stringify(create.error));
    assert.equal(create.request.blobExtensions, "credBlob + largeBlob(preferred)");
    const [w, rd, cb] = r.results.slice(1);
    assert.equal(w.label, "LB-write");
    assert.equal(w.ok, true, JSON.stringify(w.error));
    assert.equal(w.largeBlob.written, true);
    assert.equal(rd.ok, true, JSON.stringify(rd.error));
    assert.equal(rd.largeBlob.equalsWritten, true);
    assert.equal(rd.largeBlob.length, 32);
    assert.equal(cb.ok, true, JSON.stringify(cb.error));
    if (create.credBlob?.stored === true) assert.equal(cb.credBlob.equalsCreateValue, true);
    assertNoSecrets(JSON.stringify(r));
    await clearAll(page);
    await done();
  },
);

await scenario("plain credential, no blob support: blob tests report it without failing", async () => {
  const { page, done } = await open({});
  await clickAndWait(page, "create", /^create: /);
  await clickAndWait(page, "blobtests", /^blob tests: /);
  const r = await report(page);
  const [w, rd, cb] = r.results.slice(1);
  assert.equal(r.results.length, 4);
  // Unsupported shows either as an error from Chrome (name and message kept) or as written false / absent.
  assert.ok(!w.ok || w.largeBlob === "absent" || w.largeBlob.written !== true, JSON.stringify(w));
  assert.ok(!rd.ok || rd.largeBlob === "absent" || rd.largeBlob.blobPresent !== true, JSON.stringify(rd));
  assert.ok(!cb.ok || cb.credBlob === "absent" || cb.credBlob.length === 0, JSON.stringify(cb));
  await clearAll(page);
  await done();
});

await scenario("signature determinism: two signatures over one challenge are compared", async () => {
  const { page, done } = await open({});
  await clickAndWait(page, "create", /^create: /);
  await clickAndWait(page, "sigdet", /^signature determinism: /);
  const r = await report(page);
  assert.equal(r.signatureDeterminism.compared, 2);
  assert.equal(r.signatureDeterminism.sameCredential, true);
  assert.equal(typeof r.signatureDeterminism.sameSignedData, "boolean");
  // Chrome's virtual authenticator signs ECDSA with a random nonce, so equal signed bytes still give two signatures.
  if (r.signatureDeterminism.sameSignedData) assert.equal(r.signatureDeterminism.sameSignature, false);
  await clearAll(page);
  await done();
});

await ctx.close();
rmSync(userDataDir, { recursive: true, force: true });
console.log(results.join("\n"));
if (results.some((l) => l.startsWith("FAIL"))) process.exit(1);
