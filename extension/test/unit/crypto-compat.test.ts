import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decryptVault, isEnvelopeIntact } from "../../src/core/crypto/envelope";
import {
  unlockWithDevice,
  unlockWithPassword,
  unlockWithRecoveryCode,
  validateKeyring,
} from "../../src/core/crypto/keyring";

// A frozen sample written by format v1. If this fails, a change broke data that real users already have.
const fx = JSON.parse(readFileSync(new URL("../fixtures/crypto-v1.json", import.meta.url), "utf8"));

describe("format v1 compatibility", () => {
  it("device-wrapped keyring and envelope still open", async () => {
    const keyring = validateKeyring(fx.device.keyring);
    expect(await isEnvelopeIntact(fx.device.envelope)).toBe(true);
    const text = new TextDecoder().decode(await decryptVault(fx.device.envelope, await unlockWithDevice(keyring)));
    expect(text).toBe(fx.plaintext);
  });
  it("password-protected keyring opens with the password and the recovery code", async () => {
    const keyring = validateKeyring(fx.protected.keyring);
    expect(await isEnvelopeIntact(fx.protected.envelope)).toBe(true);
    for (const vk of [
      await unlockWithPassword(keyring, fx.password),
      await unlockWithRecoveryCode(keyring, fx.recoveryCode),
    ]) {
      expect(new TextDecoder().decode(await decryptVault(fx.protected.envelope, vk))).toBe(fx.plaintext);
    }
  });
});
