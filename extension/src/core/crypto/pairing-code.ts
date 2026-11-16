// The pairing code of an approval join (SYNC-DESIGN §2.2, §3.2 M2, MUST 10; revision 27): the approving device's 128-bit
// pairing secret S, shown like a recovery code (28 symbols, 7 groups of 4) but with check bits of its own domain, so a
// recovery code typed where the pairing code belongs fails them (and the other way round), but for about 1 in 4096.
// The codec is the recovery code's (recovery-code.ts); this module names the kind. Only the enrolment code imports it.
import { randomBytes, type Random } from "./bytes";
import { formatCode, parseCode } from "./recovery-code";

/** The pairing code's check-bit tag (§2.2). The sync labels list it with the enrolment's other tags (enroll-labels.ts). */
export const PAIRING_CODE_TAG = "sixkey-pairing-code|1|";
/** S is 128 bits; never to be shortened (an offline guess would become feasible: a PAKE is needed then, §3.2 MUST 10). */
export const PAIRING_SECRET_BYTES = 16;

/** S and its text, drawn by the approving device only. */
export type PairingCode = { secret: Uint8Array; text: string };

export async function generatePairingCode(rng: Random = randomBytes): Promise<PairingCode> {
  const secret = rng(PAIRING_SECRET_BYTES);
  if (!(secret instanceof Uint8Array) || secret.length !== PAIRING_SECRET_BYTES) throw new RangeError("pairing secret");
  return { secret, text: await formatPairingCode(secret) };
}

export const formatPairingCode = (secret: Uint8Array): Promise<string> => formatCode(secret, PAIRING_CODE_TAG);

/**
 * What the user typed or pasted on the new device: pairing_length or pairing_char (not 28 symbols of the alphabet once
 * read the Crockford way), or pairing_checksum (a typo the check bits caught, or a recovery code typed here).
 */
export const parsePairingCode = (input: string): Promise<Uint8Array> => parseCode(input, PAIRING_CODE_TAG, "pairing");
