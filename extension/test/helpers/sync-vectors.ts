// Fixtures for the M1 tests: the shared vectors, their fixed keys imported into WebCrypto the way production code holds
// them (non-extractable), and deterministic random sources so production functions reproduce vector bytes.
import { fromB64 } from "../../src/core/crypto/bytes";
import { vkFromRaw, type Vk } from "../../src/core/crypto/vk";
import type { Ephemeral } from "../../src/core/sync/crypto/device-key";
import { preSendCheck, type VerifiedServerBundle } from "../../src/core/sync/crypto/presend";
import { b64u, fromHex, loadContract, type J } from "./contract";

export const C = loadContract();
export const V = C.vectors;
export const G = V.groups;
export const F = V.fixed_inputs;

export const VK1_RAW = fromHex(F.vk1_hex);
export const VK2_RAW = fromHex(F.vk2_hex);
export const VK0_RAW = fromHex(F.vk0_hex);
export const vk = (raw: Uint8Array): Promise<Vk> => vkFromRaw(new Uint8Array(raw));

export const keyByName = (name: string): J => G.public_keys.keys.find((k: J) => k.name === name);
const jwkOf = (k: J) => ({
  kty: "EC",
  crv: "P-256",
  d: b64u(fromHex(k.d_hex)),
  x: b64u(fromHex(k.x_hex)),
  y: b64u(fromHex(k.y_hex)),
});
export const privateJwk = (name: string) => jwkOf(keyByName(name));

/** A fixed ECDH key from the vectors, held like production holds a fresh one. */
export async function ephemeralOf(name: string): Promise<Ephemeral> {
  const k = keyByName(name);
  const privateKey = await crypto.subtle.importKey("jwk", jwkOf(k), { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  return { privateKey, raw: fromB64(k.point_b64) };
}

export const spkiOf = (name: string): Uint8Array => fromB64(keyByName(name).spki_b64);

export const fill = (byte: number, n: number): Uint8Array => new Uint8Array(n).fill(byte);

/** Hands out the given chunks in order and fails loudly if code asks for something else. */
export function queueRng(...chunks: Uint8Array[]): (n: number) => Uint8Array {
  const q = [...chunks];
  return (n: number) => {
    const next = q.shift();
    if (!next || next.length !== n) throw new Error(`queueRng: asked for ${n} bytes, had ${next?.length ?? "nothing"}`);
    return new Uint8Array(next);
  };
}

export const wireExample = (operation: string, kind: string, status?: string): J =>
  G.wire_examples.examples.find(
    (e: J) =>
      e.operation === operation &&
      e.kind === kind &&
      (status === undefined || e.status === status) &&
      (e.expect_valid ?? true),
  );

/**
 * A VerifiedServerBundle for the keybundle vector (VK1, kver 3), obtained the only way production allows: through
 * preSendCheck. The recovery-code version costs HKDF only, so enrollment tests can afford one per op.
 */
const verifiedCache = new Map<string, Promise<VerifiedServerBundle>>();
export function verifiedFor(op: "respond" | "approve"): Promise<VerifiedServerBundle> {
  let p = verifiedCache.get(op);
  if (!p) {
    p = (async () => {
      const r = await preSendCheck({
        op,
        serverRaw: G.keybundle.raw,
        secret: { recoveryCode: G.recovery_auth.code },
        local: G.keybundle.bundle.keyring,
        vk: await vk(VK1_RAW),
        maxSeenKver: G.keybundle.bundle.kver,
        expectedVaultId: F.vault_id,
        adoptedAuth: G.keybundle.bundle.auth,
        adoptedDigest: null,
      });
      if (!r.ok) throw new Error(`pre-send check refused: ${r.reason}`);
      return r.verified;
    })();
    verifiedCache.set(op, p);
  }
  return p;
}
