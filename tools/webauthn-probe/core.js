// Pure helpers for the WebAuthn probe (Stage 0 of docs/design/proposals/QUICK-UNLOCK.md).
//
// Nothing here touches the DOM, chrome.* or the network: byte encodings, the WebAuthn authenticator-data layout, a
// signature check, and the comparison of PRF results. Everything that leaves this module for the report is either
// public (flags, lengths, algorithm numbers, the AAGUID, which identifies the authenticator model, not the person) or a
// short SHA-256 prefix. Raw PRF outputs and raw credential IDs are never returned in a form that could be printed.

/** Bytes as base64url without padding (the WebAuthn convention for credential IDs). */
export function b64u(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * The first 8 bytes of SHA-256(bytes), as 16 hex digits. This is what the report prints instead of a secret: two equal
 * prefixes mean (with overwhelming probability) equal values, and a prefix reveals nothing usable about the value.
 */
export async function sha256Prefix(bytes) {
  return hex((await sha256(bytes)).slice(0, 8));
}

/** The two fixed PRF inputs. Public by design, so that reports from different runs and machines can be compared. */
export async function fixedSalt(label) {
  return sha256(new TextEncoder().encode(`sixkey-probe/prf-salt-${label}/v1`));
}

const FLAG_BITS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

function aaguidText(b) {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * WebAuthn authenticator data: rpIdHash (32) | flags (1) | signCount (4, big-endian) | [attested credential data:
 * AAGUID (16) | credential ID length (2) | credential ID | public key (CBOR)] | [extensions (CBOR)].
 * BE = backup eligible (the credential can be synced), BS = backup state (it is synced now).
 */
export function parseAuthData(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 37) return { error: `authenticator data too short (${u8.length} bytes)` };
  const flagsByte = u8[32];
  const flags = {};
  for (const [k, bit] of Object.entries(FLAG_BITS)) flags[k] = (flagsByte & bit) !== 0;
  const out = {
    length: u8.length,
    rpIdHash: u8.slice(0, 32),
    flagsByte: `0x${flagsByte.toString(16).padStart(2, "0")}`,
    flags,
    signCount: new DataView(u8.buffer, u8.byteOffset + 33, 4).getUint32(0, false),
  };
  if (flags.AT && u8.length >= 55) {
    const aaguid = u8.slice(37, 53);
    out.aaguid = aaguidText(aaguid);
    out.aaguidAllZero = aaguid.every((b) => b === 0);
    out.credentialIdLength = (u8[53] << 8) | u8[54];
  }
  return out;
}

/** Which string the authenticator hashed as the RP ID. Chrome is expected to pass "chrome-extension://<id>" (YR-30). */
export async function rpIdHashMatches(rpIdHash, extensionId) {
  const candidates = { extensionOrigin: `chrome-extension://${extensionId}`, extensionIdOnly: extensionId };
  const out = {};
  for (const [name, text] of Object.entries(candidates)) {
    const h = await sha256(new TextEncoder().encode(text));
    out[name] = h.length === rpIdHash.length && h.every((b, i) => b === rpIdHash[i]);
  }
  return out;
}

/** clientDataJSON checked the way Sixkey's gate would check it (QUICK-UNLOCK §5.4), reported as booleans. */
export function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let c;
  try {
    c = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch (e) {
    return { error: `clientDataJSON is not JSON: ${String(e)}` };
  }
  return {
    type: c.type,
    typeMatches: c.type === type,
    origin: c.origin,
    originMatchesPage: c.origin === origin,
    crossOrigin: c.crossOrigin ?? null,
    challengeMatches: c.challenge === b64u(challenge),
    topOriginPresent: c.topOrigin !== undefined,
  };
}

/** A DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }) as the raw r||s that WebCrypto verifies. */
export function derToRaw(der, size = 32) {
  const u8 = der instanceof Uint8Array ? der : new Uint8Array(der);
  let i = 0;
  const need = (cond) => {
    if (!cond) throw new Error("malformed DER signature");
  };
  need(u8[i++] === 0x30);
  let len = u8[i++];
  if (len & 0x80) i += len & 0x7f; // long form length: skip it, the parts below carry their own lengths
  const part = () => {
    need(u8[i++] === 0x02);
    const n = u8[i++];
    let v = u8.slice(i, i + n);
    i += n;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    need(v.length <= size);
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

/**
 * Verify an assertion signature over authenticatorData || SHA-256(clientDataJSON) with the SPKI public key returned at
 * creation. Returns true, false, or "unsupported:<alg>". -7 = ES256 (P-256), -257 = RS256.
 */
export async function verifyAssertion({ alg, spki, authData, clientDataJSON, signature }) {
  const hash = await sha256(clientDataJSON);
  const ad = new Uint8Array(authData);
  const data = new Uint8Array(ad.length + hash.length);
  data.set(ad, 0);
  data.set(hash, ad.length);
  if (alg === -7) {
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(new Uint8Array(signature)), data);
  }
  if (alg === -257) {
    const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, new Uint8Array(signature), data);
  }
  return `unsupported:${alg}`;
}

/** An error as the report shows it: name and message verbatim, nothing else (no stack: it would name local paths). */
export function errorInfo(e) {
  if (e && typeof e === "object") return { name: String(e.name ?? "Error"), message: String(e.message ?? "") };
  return { name: "Error", message: String(e) };
}

/**
 * Compare PRF results across every recorded step (any page, this browser session), per credential:
 *   sameSaltSameValue: every result for salt A of one credential has the same prefix (expected true);
 *   differentSaltDifferentValue: salt B's prefix differs from salt A's (expected true);
 *   createValueEqualsGetValue: the PRF value returned at creation (salt A) equals get()'s for salt A.
 * null means "not enough results to say".
 */
/**
 * The SIG1/SIG2 assertions of the signature-determinism test, per credential: were the signed bytes the same (Chrome
 * may vary clientDataJSON), and if so, was the signature the same? A deterministic signature over a fixed message would
 * be a secret only the authenticator can produce; ECDSA with a random nonce gives a different one each time.
 */
export function signatureDeterminism(results) {
  const sig = results.filter((r) => r.ok && /^SIG\d$/.test(r.label ?? "") && r.signatureSha256Prefix);
  if (sig.length < 2) return { compared: 0, sameSignedData: null, sameSignature: null };
  const [a, b] = sig.slice(-2);
  const same = a.credentialId?.sha256Prefix === b.credentialId?.sha256Prefix;
  const sameSignedData = same && a.signedDataSha256Prefix === b.signedDataSha256Prefix;
  return {
    compared: 2,
    sameCredential: same,
    sameSignedData,
    sameSignature: sameSignedData ? a.signatureSha256Prefix === b.signatureSha256Prefix : null,
    signCounts: [a.authenticatorData?.signCount ?? null, b.authenticatorData?.signCount ?? null],
  };
}

export function prfConsistency(results) {
  const byCred = new Map();
  for (const r of results) {
    const p = r.ok && r.prf && r.prf.firstSha256Prefix;
    const cred = r.credentialId && r.credentialId.sha256Prefix;
    if (!p || !cred) continue;
    if (!byCred.has(cred)) byCred.set(cred, { createA: [], getA: [], getB: [] });
    const g = byCred.get(cred);
    if (r.step === "create") g.createA.push(p);
    else if (r.salt === "A") g.getA.push(p);
    else if (r.salt === "B") g.getB.push(p);
  }
  let same = null;
  let diff = null;
  let createEq = null;
  const and = (cur, v) => (cur === null ? v : cur && v);
  for (const g of byCred.values()) {
    if (g.getA.length >= 2)
      same = and(
        same,
        g.getA.every((p) => p === g.getA[0]),
      );
    if (g.getA.length >= 1 && g.getB.length >= 1)
      diff = and(
        diff,
        g.getB.every((p) => !g.getA.includes(p)),
      );
    if (g.createA.length >= 1 && g.getA.length >= 1)
      createEq = and(
        createEq,
        g.createA.every((p) => g.getA.includes(p)),
      );
  }
  return {
    sameSaltSameValue: same,
    differentSaltDifferentValue: diff,
    createValueEqualsGetValue: createEq,
    credentialsCompared: byCred.size,
  };
}
