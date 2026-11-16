// What the device unlock needs of WebAuthn (QUICK-UNLOCK §5.10 `platform/webauthn.ts`): bytes in, bytes out. The core
// takes this port, so the Node tests drive every flow with a fake (test/helpers/fake-webauthn.ts), and the one file that
// calls navigator.credentials is src/platform/webauthn.ts (a source rule holds it there).
//
// Nothing that passes through here is logged or stored beyond what sk_prf keeps: the credential id, the public key of a
// gate, the salt and the wrap. A PRF output, an assertion or a challenge lives in the caller's memory for the one
// ceremony; the caller zeroes the PRF output once it has used it.

/** Why a ceremony gave nothing: cancelled (or timed out, or refused by the OS: the page cannot tell these apart, by
 * design), the credential is already registered (excludeCredentials), WebAuthn unavailable here, anything else. */
export type WebAuthnFailure = "cancelled" | "exists" | "unsupported" | "failed";

export class WebAuthnError extends Error {
  constructor(readonly code: WebAuthnFailure) {
    super(code);
    this.name = "WebAuthnError";
  }
}

export type CreateRequest = {
  challenge: Uint8Array;
  /** 16 random bytes: nothing personal (QUICK-UNLOCK §5.3 step 2). */
  userId: Uint8Array;
  /** "Sixkey unlock · <date>": tells several computers apart in a synced provider. */
  displayName: string;
  /** Credential ids (base64url) this profile has already: not registered twice. */
  exclude: string[];
  /** The PRF salt, evaluated at creation too: Windows Hello is said to report PRF only then (ux-study U4; unverified). */
  prfSalt: Uint8Array;
};

export type Created = {
  /** base64url, as WebAuthn's `id`. */
  id: string;
  /** "platform", "cross-platform", or null when the browser did not say. */
  attachment: string | null;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  /** SPKI (getPublicKey()) and its COSE algorithm; null when the browser gives none. */
  publicKey: Uint8Array | null;
  alg: number | null;
};

export type GetRequest = {
  challenge: Uint8Array;
  /** The credentials asked for, by id (base64url). */
  allow: string[];
  /** The PRF salt per credential id (evalByCredential); absent: no PRF (the gate). */
  prf?: Record<string, Uint8Array>;
};

export type Asserted = {
  id: string;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  /** results.first, 32 bytes, when the authenticator returned it; null otherwise. Secret: zero it after use. */
  prf: Uint8Array | null;
};

export type WebAuthnPort = {
  /** The RP ID and the origin: an extension page that sets no rp.id gets `chrome-extension://<id>` (§1.6). */
  readonly origin: string;
  /** isUserVerifyingPlatformAuthenticatorAvailable(): false where there is none (then only the PIN is offered). */
  available(): Promise<boolean>;
  /** A platform credential, user verification required, resident (§5.3 step 2). Rejects with WebAuthnError. */
  create(r: CreateRequest): Promise<Created>;
  /** An assertion, user verification required. Rejects with WebAuthnError. */
  get(r: GetRequest): Promise<Asserted>;
};
