// Rough PBKDF2 timing. Browser numbers matter more; run the same loop in the popup console on a slow machine.
const { subtle } = globalThis.crypto;
const pw = new TextEncoder().encode("correct horse battery staple");
const salt = crypto.getRandomValues(new Uint8Array(16));
const base = await subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
for (const iterations of [600_000, 1_000_000]) {
  const t = performance.now();
  for (let i = 0; i < 5; i++) await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
  console.log(`PBKDF2-SHA256 ${iterations}: ${((performance.now() - t) / 5).toFixed(0)} ms avg of 5`);
}
