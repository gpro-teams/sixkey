import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("has WebCrypto, which core/ depends on", async () => {
    expect(globalThis.crypto?.subtle).toBeDefined();
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(20).fill(1),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new Uint8Array(8));
    expect(mac.byteLength).toBe(20);
  });
});
