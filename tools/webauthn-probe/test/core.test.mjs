// Unit checks of core.js for what the virtual authenticator does not exercise: RS256 (Windows Hello commonly signs with
// it), DER signatures with leading zeros, flag parsing, and the PRF comparison. Plain Node, no dependencies:
//   nice -n 19 node --test tools/webauthn-probe/test/core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, derToRaw, fromB64u, parseAuthData, prfConsistency, sha256, verifyAssertion } from "../core.js";

const enc = (s) => new TextEncoder().encode(s);

/** raw r||s (what WebCrypto's ECDSA sign returns) as DER, as authenticators send it. */
function rawToDer(raw) {
  const int = (b) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && v[1] < 0x80) v = v.slice(1);
    if (v[0] >= 0x80) v = Uint8Array.of(0, ...v);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.of(0x30, body.length, ...body);
}

function authData(flags) {
  const ad = new Uint8Array(37);
  ad[32] = flags;
  ad.set([0, 0, 0, 7], 33);
  return ad;
}

async function signed(alg) {
  const params =
    alg === -7
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" };
  const keys = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const ad = authData(0x05);
  const cd = enc(JSON.stringify({ type: "webauthn.get", challenge: "x", origin: "chrome-extension://a" }));
  const data = new Uint8Array([...ad, ...(await sha256(cd))]);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      data,
    ),
  );
  return { spki, ad, cd, signature: alg === -7 ? rawToDer(sig) : sig };
}

for (const alg of [-7, -257]) {
  test(`verifyAssertion accepts a good ${alg} signature and refuses a tampered one`, async () => {
    const s = await signed(alg);
    assert.equal(
      await verifyAssertion({ alg, spki: s.spki, authData: s.ad, clientDataJSON: s.cd, signature: s.signature }),
      true,
    );
    const bad = s.ad.slice();
    bad[32] ^= 0x04; // clear UV after signing
    assert.equal(
      await verifyAssertion({ alg, spki: s.spki, authData: bad, clientDataJSON: s.cd, signature: s.signature }),
      false,
    );
  });
}

test("verifyAssertion reports an algorithm it does not handle", async () => {
  const s = await signed(-7);
  assert.equal(
    await verifyAssertion({ alg: -8, spki: s.spki, authData: s.ad, clientDataJSON: s.cd, signature: s.signature }),
    "unsupported:-8",
  );
});

test("derToRaw pads short integers and strips a sign byte", () => {
  const r = new Uint8Array(32).fill(0x81); // high bit set: DER adds a 0x00
  const sShort = Uint8Array.of(...new Array(31).fill(0x11)); // 31 bytes: raw must left-pad
  const der = Uint8Array.of(0x30, 2 + 33 + 2 + 31, 0x02, 33, 0, ...r, 0x02, 31, ...sShort);
  const raw = derToRaw(der);
  assert.deepEqual(raw.slice(0, 32), r);
  assert.equal(raw[32], 0);
  assert.deepEqual(raw.slice(33), sShort);
  assert.throws(() => derToRaw(Uint8Array.of(0x31, 0)), /malformed/);
});

test("parseAuthData reads UP, UV, BE, BS and the sign count", () => {
  const ad = parseAuthData(authData(0x01 | 0x04 | 0x08 | 0x10));
  assert.deepEqual(ad.flags, { UP: true, UV: true, BE: true, BS: true, AT: false, ED: false });
  assert.equal(ad.signCount, 7);
  assert.ok(parseAuthData(new Uint8Array(10)).error);
});

test("base64url round trip", () => {
  const b = Uint8Array.of(0xfb, 0xff, 0x00, 0x3e);
  assert.equal(b64u(b), "-_8APg");
  assert.deepEqual(fromB64u(b64u(b)), b);
});

test("prfConsistency: same salt equal, other salt different, nulls when unknown", () => {
  const c = { sha256Prefix: "c1" };
  const r = (step, salt, p) => ({ ok: true, step, salt, credentialId: c, prf: { firstSha256Prefix: p } });
  assert.deepEqual(
    prfConsistency([r("create", "A", "aa"), r("get", "A", "aa"), r("get", "A", "aa"), r("get", "B", "bb")]),
    {
      sameSaltSameValue: true,
      differentSaltDifferentValue: true,
      createValueEqualsGetValue: true,
      credentialsCompared: 1,
    },
  );
  assert.equal(prfConsistency([r("get", "A", "aa"), r("get", "A", "ab")]).sameSaltSameValue, false);
  assert.equal(prfConsistency([r("get", "A", "aa"), r("get", "B", "aa")]).differentSaltDifferentValue, false);
  assert.equal(prfConsistency([]).sameSaltSameValue, null);
});
