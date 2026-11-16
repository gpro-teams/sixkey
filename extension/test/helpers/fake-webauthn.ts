// A software authenticator behind the device unlock's WebAuthn port (src/core/service/webauthn-port.ts), for the Node
// tests (QUICK-UNLOCK §7.1: "platform/webauthn.ts replaced by a fake that returns bytes"). It does what the browser and
// a platform authenticator do, byte for byte where the code under test looks: authenticator data (the RP ID hash of the
// origin, the flags UP UV BE BS AT, a counter, the AAGUID), clientDataJSON as Chrome writes it, an ES256 signature in DER
// or an RS256 one, getPublicKey()'s SPKI, and the PRF extension (HMAC-SHA256 of the credential's secret over
// "WebAuthn PRF" ‖ 0x00 ‖ salt, with another secret when the user was not verified, as hmac-secret has).
// `tamper` changes one thing in the next answers, so each clause of Sixkey's own check can be tested on its own.
import { createHmac, createHash, randomBytes as nodeRandom } from "node:crypto";
import {
  WebAuthnError,
  type Asserted,
  type Created,
  type CreateRequest,
  type GetRequest,
  type WebAuthnFailure,
  type WebAuthnPort,
} from "../../src/core/service/webauthn-port";

export const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const AAGUID = {
  google: "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4",
  icloud: "fbfc3007-154e-4ecc-8c0b-6e020557d7bd",
  chrome: "adce0002-35bc-c60a-648b-0b25f1f05503",
  windows: "08987058-cadc-4b81-b6e1-30de50dcbe96",
  none: "00000000-0000-0000-0000-000000000000",
};

/** What the authenticator is (QUICK-UNLOCK §7.2's virtual-authenticator options, in this fake's words). */
export type FakeOptions = {
  prf: boolean;
  /** isUserVerified: the user passes user verification. */
  uv: boolean;
  /** defaultBackupEligibility / defaultBackupState: a passkey that syncs. */
  be: boolean;
  bs: boolean;
  attachment: "platform" | "cross-platform" | null;
  alg: -7 | -257;
  aaguid: string;
};

/** One thing wrong in the answers, for the check's clauses (and a ceremony that is cancelled or fails). */
export type Tamper =
  | "uv"
  | "up"
  | "challenge"
  | "origin"
  | "type"
  | "crossOrigin"
  | "rpIdHash"
  | "signature"
  | "otherKey"
  | "noPrf"
  | "otherPrf"
  | "otherCredential"
  | "wrongId"
  | "cancel"
  | "fail";

type Cred = {
  id: Uint8Array;
  keys: CryptoKeyPair;
  alg: -7 | -257;
  prfUv: Uint8Array;
  prfNoUv: Uint8Array;
  count: number;
};

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

/** raw r ‖ s (WebCrypto's ECDSA output) as the DER SEQUENCE a WebAuthn ES256 signature is. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let x = v.slice(i);
    if (x[0]! & 0x80) x = Uint8Array.from([0, ...x]);
    return [0x02, x.length, ...x];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export class FakeAuthenticator implements WebAuthnPort {
  readonly origin: string;
  o: FakeOptions;
  /** The credentials it holds; delete one to stand for a passkey removed in the OS. */
  readonly creds = new Map<string, Cred>();
  tamper: Tamper | null = null;
  /** As `tamper`, for get() only (create() answers truly): the verification get of an enrolment, an unlock. */
  tamperGet: Tamper | null = null;
  /** As `tamper`, for create() only (every get() answers truly): the creation's own check, clause by clause. */
  tamperCreate: Tamper | null = null;
  /** The tamper in force now (set by create and get). */
  private t: Tamper | null = null;
  /** Called during each get(), before it answers: a lock during the OS dialog, for one. */
  during: (() => Promise<void>) | null = null;
  /** Every request it was given (the tests check what was asked for). */
  readonly requests: { create: CreateRequest[]; get: GetRequest[] } = { create: [], get: [] };
  platform = true;

  constructor(o: Partial<FakeOptions> = {}, origin = ORIGIN) {
    this.o = {
      prf: true,
      uv: true,
      be: false,
      bs: false,
      attachment: "platform",
      alg: -7,
      aaguid: AAGUID.chrome,
      ...o,
    };
    this.origin = origin;
  }

  async available() {
    return this.platform;
  }

  private authData(c: Cred, attested: Uint8Array | null): Uint8Array {
    const t = this.t;
    let flags = 0x01 | (this.o.uv ? 0x04 : 0) | (this.o.be ? 0x08 : 0) | (this.o.bs ? 0x10 : 0) | (attested ? 0x40 : 0);
    if (t === "uv") flags &= ~0x04;
    if (t === "up") flags &= ~0x01;
    const rp = sha(t === "rpIdHash" ? "chrome-extension://another" : this.origin);
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, ++c.count);
    return Uint8Array.from([...rp, flags, ...count, ...(attested ?? [])]);
  }

  private clientData(type: string, challenge: Uint8Array): Uint8Array {
    const t = this.t;
    const c = {
      type: t === "type" ? (type === "webauthn.get" ? "webauthn.create" : "webauthn.get") : type,
      challenge: b64u(t === "challenge" ? Uint8Array.from(challenge, (x) => x ^ 1) : challenge),
      origin: t === "origin" ? "https://evil.example" : this.origin,
      crossOrigin: t === "crossOrigin",
    };
    return new TextEncoder().encode(JSON.stringify(c));
  }

  private async sign(c: Cred, authData: Uint8Array, clientDataJSON: Uint8Array): Promise<Uint8Array> {
    const data = Uint8Array.from([...authData, ...sha(clientDataJSON)]);
    const key = this.t === "otherKey" ? (await this.newKeys(c.alg)).privateKey : c.keys.privateKey;
    let sig: Uint8Array;
    if (c.alg === -7)
      sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)));
    else sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data));
    if (this.t === "signature") sig[sig.length - 1]! ^= 1;
    return sig;
  }

  private newKeys(alg: -7 | -257): Promise<CryptoKeyPair> {
    return alg === -7
      ? crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      : crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["sign", "verify"],
        );
  }

  private prfOf(c: Cred, salt: Uint8Array): Uint8Array | null {
    if (!this.o.prf || this.t === "noPrf") return null;
    const secret = this.o.uv && this.t !== "otherPrf" ? c.prfUv : c.prfNoUv;
    const input = sha(Uint8Array.from([...new TextEncoder().encode("WebAuthn PRF"), 0, ...salt]));
    return new Uint8Array(createHmac("sha256", secret).update(input).digest());
  }

  private refuse(): void {
    if (this.t === "cancel") throw new WebAuthnError("cancelled");
    if (this.t === "fail") throw new WebAuthnError("failed");
  }

  async create(r: CreateRequest): Promise<Created> {
    this.requests.create.push(r);
    this.t = this.tamperCreate ?? this.tamper;
    this.refuse();
    if (!this.platform) throw new WebAuthnError("unsupported");
    if (r.exclude.some((id) => this.creds.has(id))) throw new WebAuthnError("exists");
    if (!this.o.uv) throw new WebAuthnError("cancelled"); // user verification required and not given: NotAllowedError
    const id = new Uint8Array(nodeRandom(32));
    const keys = await this.newKeys(this.o.alg);
    const c: Cred = {
      id,
      keys,
      alg: this.o.alg,
      prfUv: new Uint8Array(nodeRandom(32)),
      prfNoUv: new Uint8Array(nodeRandom(32)),
      count: 0,
    };
    this.creds.set(b64u(id), c);
    const aaguid = Buffer.from(this.o.aaguid.replace(/-/g, ""), "hex");
    const attested = Uint8Array.from([...aaguid, id.length >> 8, id.length & 0xff, ...id, 0xa0]); // (a stand-in COSE key)
    const authData = this.authData(c, attested);
    return {
      id: b64u(id),
      attachment: this.o.attachment,
      authData,
      clientDataJSON: this.clientData("webauthn.create", r.challenge),
      publicKey: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      alg: this.o.alg,
    };
  }

  async get(r: GetRequest): Promise<Asserted> {
    this.requests.get.push(r);
    await this.during?.();
    this.t = this.tamperGet ?? this.tamper;
    this.refuse();
    let id = r.allow.find((x) => this.creds.has(x));
    if (this.t === "otherCredential") id = [...this.creds.keys()].find((x) => !r.allow.includes(x)) ?? id;
    const c = id ? this.creds.get(id) : undefined;
    if (!c || !id) throw new WebAuthnError("cancelled"); // a removed passkey looks like a cancel
    if (!this.o.uv && this.t !== "uv") throw new WebAuthnError("cancelled");
    const authData = this.authData(c, null);
    const clientDataJSON = this.clientData("webauthn.get", r.challenge);
    const salt = r.prf?.[id];
    return {
      id: this.t === "wrongId" ? b64u(new Uint8Array(nodeRandom(32))) : id, // made by `id`, said to be another's
      authData,
      clientDataJSON,
      signature: await this.sign(c, authData, clientDataJSON),
      prf: salt ? this.prfOf(c, salt) : null,
    };
  }

  /** The PRF output this authenticator gives credential `id` for `salt` with the user verified (to look for it). */
  prfFor(id: string, salt: Uint8Array): Uint8Array {
    const c = this.creds.get(id)!;
    const input = sha(Uint8Array.from([...new TextEncoder().encode("WebAuthn PRF"), 0, ...salt]));
    return new Uint8Array(createHmac("sha256", c.prfUv).update(input).digest());
  }

  /** The port's failure codes, for tests that name them. */
  static readonly failures: readonly WebAuthnFailure[] = ["cancelled", "exists", "unsupported", "failed"];
}
