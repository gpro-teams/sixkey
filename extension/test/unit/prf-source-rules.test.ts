// Rules about the source for the device unlock (QUICK-UNLOCK §7.1 "Source rules", Stage 2), which hold by construction
// and which no run-time check would notice a new line breaking. Comments are not code.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys } from "../../scripts/catalog-keys.mjs";

const EXT = resolve(__dirname, "../..");
const ROOT = join(EXT, "src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const files = sources().map((p) => {
  const text = readFileSync(p, "utf8");
  return { path: relative(ROOT, p).split("\\").join("/"), text, code: code(text) };
});
const where = (re: RegExp) => files.filter((f) => re.test(f.code)).map((f) => f.path);
const file = (p: string) => files.find((f) => f.path === p)!;
/** The value imports of a module (type-only ones are erased and do not load anything). */
const imports = (p: string) =>
  [...file(p).code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]!);

/** The lazy modules of the device unlock, which import nothing of the popup's main chunk (PRF-NOTES.md). */
const LAZY = {
  "core/service/device-unlock.ts": [
    "../crypto/assertion",
    "../crypto/crypto-error",
    "../crypto/prf",
    "../crypto/prf-check",
    "./prf-write",
    "./webauthn-port",
  ],
  "core/service/prf-write.ts": ["../crypto/prf-check"],
  "core/crypto/prf-check.ts": [],
  "core/crypto/prf.ts": ["./crypto-error"],
  "core/crypto/assertion.ts": [],
  "core/service/webauthn-port.ts": [],
  "platform/webauthn.ts": ["../core/service/webauthn-port"],
  "ui/device-text.ts": ["./lazy-text"],
  "ui/DeviceUnlock.tsx": [
    "preact/hooks",
    "../core/service/device-unlock",
    "../platform/webauthn",
    "./device-text",
    "./errors",
  ],
};

describe("the device unlock's sources", () => {
  it("navigator.credentials is called in platform/webauthn.ts only", () => {
    expect(where(/navigator\.credentials/)).toEqual(["platform/webauthn.ts"]);
    expect(where(/\bPublicKeyCredential\b/)).toEqual(["platform/webauthn.ts"]);
  });

  it("the PRF is decided by the verification get's results.first, never by prf.enabled (YR-28)", () => {
    expect(where(/\.enabled\b/).filter((p) => /webauthn|device|prf/.test(p))).toEqual([]);
    const wa = file("platform/webauthn.ts").code;
    expect(wa).toMatch(/\.prf\?\.results\?\.first/);
  });

  it('user verification is "required" in both ceremonies, never "preferred" or "discouraged" (REVIEW S5)', () => {
    // Sixkey checks the UV flag of every answer itself (assertion.ts, device-unlock.ts); this asks the authenticator for
    // it too, so a platform that would skip it is told not to
    const wa = file("platform/webauthn.ts").code;
    expect([...wa.matchAll(/userVerification: "(\w+)"/g)].map((m) => m[1])).toEqual(["required", "required"]);
    const create = wa.slice(wa.indexOf("navigator.credentials.create("), wa.indexOf("navigator.credentials.get("));
    const get = wa.slice(wa.indexOf("navigator.credentials.get("));
    expect(create).toMatch(/authenticatorSelection: \{[^}]*userVerification: "required"/);
    expect(get).toMatch(/userVerification: "required"/);
  });

  it('the synced passkey\'s answer points to "Also after a restart": adding it again would be refused (REVIEW F2, Q4)', () => {
    const cat = (lang: string) =>
      JSON.parse(readFileSync(join(EXT, `catalogs/device-${lang}.json`), "utf8")) as Record<
        string,
        { message: string }
      >;
    // it points to "Also after a restart" beside it (OWNER-DECISIONS/17 Q4), whose own label is the one named
    expect(cat("en").dvSyncedRefused!.message).toMatch(/choose “Also after a restart” beside it/);
    expect(cat("zh_CN").dvSyncedRefused!.message).toMatch(/点它旁边的“重启后也可以”/);
    expect(cat("en").dvAlsoRestart!.message).toBe("Also after a restart");
    expect(cat("zh_CN").dvAlsoRestart!.message).toBe("重启后也可以");
    const fragment = readFileSync(join(EXT, "scripts/i18n/device.py"), "utf8"); // what the catalogs are made from
    expect(fragment.match(/"dvSyncedRefused": "[^"]*choose “Also after a restart” beside it\."/g)).toHaveLength(1);
    expect(fragment.match(/"dvSyncedRefused": "[^"]*点它旁边的“重启后也可以”。"/g)).toHaveLength(1);
    // the flow it describes is the service's (prf-service.test.ts: "made one that also works after a restart, in place")
    expect(file("options/DeviceBox.tsx").code).toMatch(
      /r\.refused === "synced"\) return \{ ok: true, text: dx\("dvSyncedRefused"\) \}/,
    );
  });

  it('"sk_prf" is spelled in keys.ts (and restated in the lazy prf-write.ts); it is written only by prf-store.ts and prf-write.ts, in the vault lock', () => {
    expect(where(/"sk_prf"/).sort()).toEqual(["core/service/prf-write.ts", "core/sync/local/keys.ts"]);
    expect(file("core/service/prf-write.ts").code).toMatch(/^const KEY = "sk_prf";$/m);
    expect(where(/\bPRF_KEY\b/).sort()).toEqual([
      "core/service/prf-store.ts",
      "core/service/service-core.ts",
      "options/DeviceBox.tsx",
    ]);
    for (const p of ["core/service/service-core.ts", "options/DeviceBox.tsx"])
      expect(file(p).code, p).not.toMatch(/\{\s*\[PRF_KEY\]\s*:|remove\(\[PRF_KEY/);
    // the store's key-change step: its two writes, in its lock section
    const store = file("core/service/prf-store.ts").code;
    expect([...store.matchAll(/this\.kv\.(set|remove)\(/g)]).toHaveLength(2);
    const at = store.indexOf("  reencrypt(current: Vk)");
    const body = store.slice(at, store.indexOf("\n  }\n", at));
    expect(body).toMatch(/return this\.lock\(async \(\) => \{/);
    expect(body.match(/this\.kv\.(set|remove)\(/g)).toHaveLength(2);
    // the lazy writer's: its three (a record, a removal, the record healed), in the store's own lock (updatePrf), and
    // nothing else in it writes
    const writer = file("core/service/prf-write.ts").code;
    expect([...writer.matchAll(/\bkv\.(set|remove)\(/g)]).toHaveLength(3);
    const w = writer.slice(
      writer.indexOf("export function updatePrf("),
      writer.indexOf("\n}\n", writer.indexOf("export function updatePrf(")),
    );
    expect(w).toMatch(/return lock\(async \(\) => \{/);
    expect(w.match(/\bkv\.(set|remove)\(/g)).toHaveLength(3);
    // and the rest of the device unlock writes through these only
    for (const p of ["core/service/device-admin.ts", "core/service/service.ts", "core/service/service-core.ts"])
      expect(file(p).code, p).not.toMatch(/sk_prf|kv\.(set|remove)\(\s*\{?\s*\[?PRF_KEY/);
  });

  it("the lazy modules import nothing of the popup's main chunk (only each other, the leaf crypto-error.ts and the lazy helpers)", () => {
    for (const [p, allowed] of Object.entries(LAZY)) expect(imports(p).sort(), p).toEqual([...allowed].sort());
    // device-unlock.ts takes the service's steps by element access, not by import
    expect(file("core/service/device-unlock.ts").code).toMatch(/this\.s\["devicePlan"\]/);
  });

  it("the pages load the device unlock by import() only: the popup and the side panel the button, the settings page the box too", () => {
    for (const [p, chunk] of [
      ["popup/screens/Locked.tsx", "../../ui/DeviceUnlock"],
      ["options/UnlockBar.tsx", "../ui/DeviceUnlock"],
      ["options/Security.tsx", "./DeviceBox"],
    ] as const) {
      expect(file(p).code, p).toContain(`import("${chunk}")`);
      expect(imports(p), p).not.toContain(chunk);
    }
    expect(where(/from\s+"[^"]*DeviceBox"/)).toEqual([]); // nothing imports the box statically
    expect(where(/from\s+"[^"]*ui\/DeviceUnlock"/)).toEqual([]);
    // the settings page's operations and the box never reach the popup
    expect(where(/from\s+"[^"]*device-admin"/).sort()).toEqual(["options/DeviceBox.tsx"]);
  });

  it("nothing in the new modules writes to the console or the diagnostics log with a secret", () => {
    for (const p of [
      ...Object.keys(LAZY),
      "core/crypto/prf-record.ts",
      "core/service/prf-store.ts",
      "core/service/device-admin.ts",
      "options/DeviceBox.tsx",
    ]) {
      expect(file(p).code, p).not.toMatch(/console\./);
      for (const m of file(p).code.matchAll(/(?:logError|diag|onDiag)\(([^)]*)\)/g))
        expect(m[1]!.replace(/"[^"]*"/g, '""'), `${p}: ${m[0]}`).not.toMatch(
          /\b(prf|vk|salt|challenge|pw|password|a)\b/,
        );
    }
  });

  it("a gate never stores key material; a PRF credential's wrap is the only key on disk", () => {
    const admin = file("core/service/device-admin.ts").code;
    expect(admin).toMatch(/\{ \.\.\.head, publicKey: toB64\(made\.publicKey\), alg \}/);
    expect(admin).toMatch(/\{ \.\.\.head, salt: toB64\(salt\), wrap: await sealPrfWrap\(/);
    // the gate's arming parks the key in chrome.storage.session only (sk_quick: platform/session.ts)
    expect(where(/armDevice\(/).sort()).toEqual([
      "core/crypto/pin.ts",
      "core/service/device-admin.ts",
      "core/service/service-core.ts",
    ]);
  });

  it("verifyPassword knows nothing of the device unlock", () => {
    const s = file("core/service/service.ts").code;
    const at = s.indexOf("  async verifyPassword(");
    const body = s.slice(at, s.indexOf("\n  }\n", at));
    expect(body).not.toMatch(/prf|Prf|webauthn|WebAuthn|gate|Gate|quick|Quick/); // (hasDevice is the Phase 0 device key)
  });

  it("YR-24: the keyring has no webauthn-prf method any more", () => {
    expect(where(/webauthn-prf/)).toEqual([]);
  });
});

describe("the dev build's fixed extension ID (§8 release-order constraints)", () => {
  const read = (f: string) => JSON.parse(readFileSync(join(EXT, f), "utf8"));
  it("manifest.dev.json carries the public key of the ID check-dist expects; the store and e2e manifests carry none", () => {
    const dev = read("manifest.dev.json");
    expect(typeof dev.key).toBe("string");
    const der = Buffer.from(dev.key, "base64");
    expect(der[0]).toBe(0x30); // an SPKI public key, not a private key
    expect(dev.key).not.toMatch(/PRIVATE/);
    const id = [...createHash("sha256").update(der).digest("hex").slice(0, 32)]
      .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
      .join("");
    const dist = readFileSync(join(EXT, "scripts/check-dist.mjs"), "utf8");
    expect(/^const DEV_EXTENSION_ID = "([a-p]{32})";$/m.exec(dist)![1]).toBe(id);
    expect(read("manifest.base.json").key).toBeUndefined();
    expect(read("manifest.e2e.json").key).toBeUndefined();
    // Sixkey's store ID, as the store assigned it to the item (scripts/store-id.mjs): never the one this key gives
    const store = /^export const STORE_ID = "([^"]*)";$/m.exec(readFileSync(join(EXT, "scripts/store-id.mjs"), "utf8"));
    expect(store?.[1]).toBe("bbfpkjnpfcddoagjiadebfafdfbckpho");
    expect(store![1]).not.toBe(id);
  });
});

describe("the popup's bundle", () => {
  let popup: { modules: string[] };
  beforeAll(() => {
    popup = popupKeys(EXT);
  });
  it("can load the lock screen's device unlock (lazily) but not the settings page's box or its operations", () => {
    expect(popup.modules).toContain("src/ui/DeviceUnlock.tsx");
    expect(popup.modules).toContain("src/core/service/device-unlock.ts");
    expect(popup.modules).not.toContain("src/options/DeviceBox.tsx");
    expect(popup.modules).not.toContain("src/core/service/device-admin.ts");
  });
});
