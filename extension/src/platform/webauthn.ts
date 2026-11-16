// The one file that calls navigator.credentials (QUICK-UNLOCK §5.10; test/unit/prf-source-rules.test.ts holds it here):
// the device unlock's WebAuthn port (src/core/service/webauthn-port.ts) over the browser's API. Loaded lazily, with the
// ceremony. It turns bytes into the API's options and the API's answers back into bytes, and maps every failure to one
// of four codes; it decides nothing, keeps nothing and logs nothing (an error is passed on by its code only).
//
// The requests, as §5.3 and §5.4 have them: no rp.id (Chrome then uses the extension's origin string,
// chrome-extension://<id>, as the RP ID: §1.6), a platform authenticator, user verification required, a resident
// credential (webauthn.dll may enable hmac-secret only for discoverable ones: YR-28), ES256 or RS256, no attestation,
// hints ["client-device"], and the PRF salt at creation too (Windows Hello reports PRF support only then).
import {
  WebAuthnError,
  type Asserted,
  type Created,
  type CreateRequest,
  type GetRequest,
  type WebAuthnPort,
} from "../core/service/webauthn-port";

const TIMEOUT_MS = 120_000;

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);
const bytes = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();

/** Every failure as one of the port's codes: a page cannot tell a cancel from a removed passkey, and must not try. */
function failure(e: unknown): WebAuthnError {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return new WebAuthnError("cancelled");
  if (name === "InvalidStateError") return new WebAuthnError("exists");
  if (name === "NotSupportedError" || name === "SecurityError") return new WebAuthnError("unsupported");
  return new WebAuthnError("failed");
}

type PrfOutputs = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };

export const webauthn: WebAuthnPort = {
  origin: globalThis.location?.origin ?? "",

  async available() {
    try {
      return (
        typeof PublicKeyCredential !== "undefined" &&
        (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
      );
    } catch {
      return false;
    }
  },

  async create(r: CreateRequest): Promise<Created> {
    let cred: PublicKeyCredential;
    try {
      cred = (await navigator.credentials.create({
        publicKey: {
          rp: { name: "Sixkey" },
          user: { id: buf(r.userId), name: "Sixkey", displayName: r.displayName },
          challenge: buf(r.challenge),
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required",
          },
          hints: ["client-device"],
          attestation: "none",
          excludeCredentials: r.exclude.map((id) => ({ type: "public-key" as const, id: fromB64u(id) })),
          timeout: TIMEOUT_MS,
          extensions: { prf: { eval: { first: buf(r.prfSalt) } } } as AuthenticationExtensionsClientInputs,
        } as PublicKeyCredentialCreationOptions,
      })) as PublicKeyCredential;
    } catch (e) {
      throw failure(e);
    }
    if (!cred) throw new WebAuthnError("failed");
    const res = cred.response as AuthenticatorAttestationResponse;
    const spki = typeof res.getPublicKey === "function" ? res.getPublicKey() : null;
    return {
      id: b64u(bytes(cred.rawId)),
      attachment: cred.authenticatorAttachment ?? null,
      authData: bytes(res.getAuthenticatorData()),
      clientDataJSON: bytes(res.clientDataJSON),
      publicKey: spki ? bytes(spki) : null,
      alg: typeof res.getPublicKeyAlgorithm === "function" ? res.getPublicKeyAlgorithm() : null,
    };
  },

  async get(r: GetRequest): Promise<Asserted> {
    let cred: PublicKeyCredential;
    try {
      cred = (await navigator.credentials.get({
        publicKey: {
          challenge: buf(r.challenge),
          allowCredentials: r.allow.map((id) => ({ type: "public-key" as const, id: fromB64u(id) })),
          userVerification: "required",
          timeout: TIMEOUT_MS,
          ...(r.prf
            ? {
                extensions: {
                  prf: {
                    evalByCredential: Object.fromEntries(
                      Object.entries(r.prf).map(([id, s]) => [id, { first: buf(s) }]),
                    ),
                  },
                } as AuthenticationExtensionsClientInputs,
              }
            : {}),
        },
      })) as PublicKeyCredential;
    } catch (e) {
      throw failure(e);
    }
    if (!cred) throw new WebAuthnError("failed");
    const res = cred.response as AuthenticatorAssertionResponse;
    const first = (cred.getClientExtensionResults() as PrfOutputs).prf?.results?.first;
    return {
      id: b64u(bytes(cred.rawId)),
      authData: bytes(res.authenticatorData),
      clientDataJSON: bytes(res.clientDataJSON),
      signature: bytes(res.signature),
      prf: first ? bytes(first) : null,
    };
  },
};
