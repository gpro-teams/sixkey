// Code generation for the UI: one imported HMAC key per account, reused every period.
import { importHmacKey, totp, totpCounter } from "../core/totp/hotp";
import { decodeBase32 } from "../core/totp/base32";
import type { Entry } from "../core/vault/model";

const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(e: Entry): Promise<CryptoKey> {
  const id = `${e.id}:${e.algorithm}:${e.secret}`;
  let k = keys.get(id);
  if (!k) {
    k = importHmacKey(decodeBase32(e.secret), e.algorithm);
    keys.set(id, k);
  }
  return k;
}

export { canGenerate, remaining } from "./otp-time";

export async function codeAt(e: Entry, timeMs: number): Promise<string> {
  return totp(await keyFor(e), timeMs, { algorithm: e.algorithm, digits: e.digits, period: e.period });
}

export const counterAt = (e: Entry, timeMs: number) => totpCounter(timeMs, e.period);

export const formatCode = (c: string) => `${c.slice(0, c.length / 2)} ${c.slice(c.length / 2)}`;
