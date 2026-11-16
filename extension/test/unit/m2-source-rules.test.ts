// M2's rules about the source (SYNC-DESIGN §0.0i req. 3, 5, 15; YUBIKEY-DESIGN §5.1 R2-R5, R8): what holds by
// construction and that no run-time check would notice a new line breaking. Comments are not code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys, readCatalogs } from "../../scripts/catalog-keys.mjs";
import { toB64 } from "../../src/core/crypto/bytes";
import { SECURITY_KINDS } from "../../src/core/service/security-kinds";
import { parseSecurityLog, SECURITY_LOG_VERSION, FAILURES } from "../../src/core/service/security-log";
import { checkBundleShape } from "../../src/core/sync/crypto/keybundle";
import { bundleOf, keyrings } from "../helpers/sync-keyrings";

const ROOT = join(__dirname, "../../src");
function sources(dir = ROOT): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const files = sources().map((p) => ({ path: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") }));
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
function sites(re: RegExp, only?: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (only && !only(f.path)) continue;
    code(f.text)
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${f.path}:${i + 1}`);
      });
  }
  return out;
}
// the service is two files since the budget relief: service-core.ts (what the popup builds) and service.ts (VaultService)
const M2_SYNC_CODE = (p: string) =>
  p === "core/service/service.ts" ||
  p === "core/service/service-core.ts" ||
  p === "core/service/sync-flows.ts" ||
  p.startsWith("core/sync/local/");

describe("M2 source rules", () => {
  it("finds the M2 sources (so the rules are not vacuous)", () => {
    for (const p of [
      "core/service/service.ts",
      "core/service/service-core.ts",
      "core/service/sync-flows.ts",
      "core/sync/local/sync-local.ts",
      "core/sync/local/records.ts",
      "core/sync/local/port.ts",
      "core/sync/local/identity.ts",
    ])
      expect(
        files.some((f) => f.path === p),
        p,
      ).toBe(true);
  });

  it("R2: no hand-written schemaVersion outside the vault model (model.ts, merge.ts, validate.ts): vaults are built by emptyVault, parseVault, mergeVaults and ops", () => {
    expect(
      sites(/schemaVersion\s*:/)
        .map((s) => s.split(":")[0])
        .filter((p) => !["core/vault/model.ts", "core/vault/merge.ts", "core/vault/validate.ts"].includes(p!)),
    ).toEqual([]);
    expect(sites(/schemaVersion\s*=(?!=)/)).toEqual([]); // and no assignment anywhere (spreading a vault and setting it)
  });

  it("R3: the sync code judges an account's identity only through the named helpers (entryIdentity, isPurged), never by comparing `.secret`", () => {
    expect(sites(/\.secret\s*[!=]==?|[!=]==?\s*[\w.]+\.secret\b|\$\{[^}]*\.secret\b/, M2_SYNC_CODE)).toEqual([]);
    expect(
      sites(
        /\.secret\s*[!=]==?|[!=]==?\s*[\w.]+\.secret\b|\$\{[^}]*\.secret\b/,
        (p) => p === "core/vault/ops.ts" || p === "core/sync/local/guard.ts",
      ),
    ).toEqual([]);
    const service = files.find((f) => f.path === "core/service/service.ts")!.text;
    const purge = service.slice(service.indexOf("async purgeForever("));
    expect(purge.slice(0, purge.indexOf("\n  }\n"))).toMatch(/entryIdentity\(/);
    expect(files.find((f) => f.path === "core/sync/local/guard.ts")!.text).toMatch(/entryIdentity\(/);
    expect(files.find((f) => f.path === "core/vault/ops.ts")!.text).toMatch(/const id = entryIdentity\(e\)/);
  });

  it("R5: sk_prf and sk_oath are not vault data (hasAnyData), not sync keys, and turning sync off does not list them", () => {
    const store = files.find((f) => f.path === "core/storage/store.ts")!.text;
    const has = store.slice(store.indexOf("private async hasAnyData("));
    expect(has.slice(0, has.indexOf("\n  }\n"))).not.toMatch(/sk_prf|sk_oath|sk_sync|prejoin/);
    const keys = files.find((f) => f.path === "core/sync/local/keys.ts")!.text;
    expect(code(keys)).toMatch(
      /LOCAL_ONLY_KEYS = \{ prf: "sk_prf", oath: "sk_oath", pin: "sk_pin", restart: "sk_pin_restart" \}/,
    );
    expect(code(keys).match(/SYNC_OFF_KEYS[^\n]*/)![0]).not.toMatch(/sk_prf|sk_oath|sk_pin|sk_prejoin/);
    expect(has.slice(0, has.indexOf("\n  }\n"))).not.toMatch(/sk_pin|sk_quick/);
  });

  it("A4R-4: the runtime builds the records with the store's own lock name; the flows reach the service's steps only from sync-flows.ts", () => {
    // the wiring every context shares (platform/runtime.ts builds it with VaultService, the popup with ServiceCore)
    const rt = files.find((f) => f.path === "platform/runtime-base.ts")!.text;
    expect(code(rt)).toMatch(/createSyncPort\(\{ local, vaultLock: webLock\("sixkey-vault"\) \}\)/);
    // and the PIN's set-up (QUICK-UNLOCK §5.9), the device unlock's record (Stage 2), and the plugin grant store's
    // record (autofill's switch, its code lazy) under the store's own lock
    expect(code(rt)).toMatch(/vkRecords: \[\.\.\.sync\.records, pins, prfs, grants\]/);
    expect(code(rt)).toMatch(
      /new GrantStore\(\{ local, session: new ChromeLocalKV\(area\), lock: webLock\("sixkey-vault"\) \}\)/,
    );
    expect(code(rt)).toMatch(/new PrfStore\(local, webLock\("sixkey-vault"\)\)/);
    expect(code(rt)).toMatch(/new PinStore\(local, webLock\("sixkey-vault"\)\)/);
    // the recovery hook clears sync's lastSynced first (D1), then marks the cloud backup's link (CLOUDBK patch 4, rule 2)
    expect(code(rt)).toMatch(
      /beforeRecoveryWrite: async \(\) => \{\s*await sync\.clearLastSynced\(\);\s*await markCsbHeld\(local, webLock\("sixkey-csb"\)\);\s*\}/,
    );
    // element access to the service's private steps: in sync-flows.ts only, and the admins' below; the device unlock's
    // own steps too (REVIEW S6: prfs, also, finishUnlock, devicePlan, quickUsable, dropIfSame, vkOf), and the PIN after a
    // restart's (OWNER-DECISIONS/20: currentVk, the PIN store's kv and lock, and what openView read, seen)
    const access = sites(
      /\b\w+\["(store|settings|sync|rng|now|diag|requireVk|committed|record|session|pins|quickLock|hardLock|iterations|prfs|also|finishUnlock|devicePlan|quickUsable|dropIfSame|vkOf|rotated|currentVk|kv|lock|seen)"\]/,
    ).map((s) => s.split(":")[0]);
    expect(access.length).toBeGreaterThan(0); // the rule is not vacuous
    // and the PIN box's operations (QUICK-UNLOCK Stage 1), the device unlock's (Stage 2: the settings box's, and the
    // lock screen's, a lazy chunk), and the PIN after a restart's (its switch's, and its lazy lock-screen steps), which
    // reuse the same steps rather than copy them (prf-write.ts reaches the device unlock's store's kv and lock so too)
    expect(new Set(access)).toEqual(
      new Set([
        "core/service/sync-flows.ts",
        "core/service/pin-admin.ts",
        "core/service/device-admin.ts",
        "core/service/device-unlock.ts",
        "core/service/prf-write.ts",
        "core/service/pin-restart-admin.ts",
        "core/service/pin-restart-steps.ts",
        "core/service/pin-restart-count.ts",
      ]),
    );
  });

  it("the popup carries none of the sync flows: no page, UI or runtime module imports sync-flows, sync-local, record-writers or identity; only platform/sync-engine.ts builds SyncFlows and SyncLocal (M5), once each", () => {
    const heavy =
      /from\s+["'][^"']*(sync-flows|sync-local|record-writers|local\/identity|local\/pins|local\/guard)["']/;
    const importers = files
      .filter((f) => heavy.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    // M3 extends the allowed importers by the sync engine (core/sync/engine/), which runs only in the contexts that sync and
    // builds on these modules by design; test/unit/m3-source-rules.test.ts adds that nothing outside it imports the engine
    // and that the popup's module graph holds none of it (docs/design/notes/M3-NOTES.md). M5 adds the one module that builds them for
    // the contexts that sync (the service worker and a page running the engine), which the popup's graph does not hold
    // (the graph test below, and m3-source-rules). M6 adds the settings page's Sync section through its one door to sync,
    // options/sync/gateway.ts (a chunk the settings page loads lazily; not in the popup's graph, the graph test below).
    for (const p of importers)
      expect(
        p.startsWith("core/service/sync-flows.ts") ||
          p.startsWith("core/sync/local/") ||
          p.startsWith("core/sync/engine/") ||
          p === "platform/sync-engine.ts" ||
          p === "options/sync/gateway.ts",
        p,
      ).toBe(true);
    expect(sites(/new (SyncFlows|SyncLocal)\s*\(/).map((x) => x.split(":")[0])).toEqual([
      "platform/sync-engine.ts",
      "platform/sync-engine.ts",
    ]);
    // the service names the flows' types only, and never loads them (either of its two files)
    expect(code(files.find((f) => f.path === "core/service/service.ts")!.text)).not.toMatch(/sync-flows|import\(/);
    expect(code(files.find((f) => f.path === "core/service/service-core.ts")!.text)).not.toMatch(/sync-flows|import\(/);
  });
});

describe("the popup's own module graph (M2R-8): what scripts/catalog-keys.mjs reads from the popup's entry points", () => {
  let popup: { modules: string[]; keys: string[] };
  beforeAll(() => {
    popup = popupKeys(resolve(__dirname, "../.."));
  }, 30_000);
  // (the previous list's cap left the popup with the budget relief: only VaultService's key operations use it, service.ts)
  it("of sync's code, the popup loads exactly the cleanup's two records, the sync state's one read and its clear, the size check, the key names, M1's constants, and the outbox writer with the write proof (M5 wires it into the runtime's port): a new import anywhere in that graph fails here, whatever its name", () => {
    expect(popup.modules.filter((m) => m.startsWith("src/core/sync/"))).toEqual([
      "src/core/sync/crypto/basic-encoding.ts",
      "src/core/sync/crypto/constants.ts",
      "src/core/sync/crypto/errors.ts",
      "src/core/sync/crypto/labels.ts",
      "src/core/sync/crypto/padding.ts",
      "src/core/sync/crypto/write-proof.ts",
      "src/core/sync/local/keys.ts",
      "src/core/sync/local/outbox-writer.ts",
      "src/core/sync/local/port.ts",
      "src/core/sync/local/records.ts",
      "src/core/sync/local/size.ts",
      "src/core/sync/local/state.ts",
    ]);
  });
  it("the engine-only parts of the modules the popup shared with the Sync section stay out of its graph (SYNC-DESIGN §7, revision 24): the KeyBundle, the wire encodings, the other VK subkeys, the outbox records' parsers, the turn-off's keep rule", () => {
    // what the popup needs of them lives in modules of their own (cap-previous, basic-encoding, write-proof,
    // outbox-writer; local/state.ts keeps only what the popup uses); the bundler shares whole modules, so one of these in
    // the popup's graph would carry into the popup's chunk everything the Sync section uses of it once the release gate
    // opens (M6-NOTES §5)
    for (const m of [
      "crypto/keybundle.ts",
      "crypto/encoding.ts",
      "crypto/subkeys.ts",
      "local/outbox.ts",
      "local/kept-at-turn-off.ts",
    ])
      expect(popup.modules, m).not.toContain(`src/core/sync/${m}`);
    expect(popup.modules).toContain("src/core/service/service-core.ts"); // not vacuous: the graph is the popup's
    expect(popup.modules).not.toContain("src/core/service/sync-flows.ts");
    // nor VaultService itself (the settings page's key operations), nor the runtime that builds it
    expect(popup.modules).not.toContain("src/core/service/service.ts");
    expect(popup.modules).not.toContain("src/platform/runtime.ts");
  });
  it("the popup's catalog carries none of M2's settings-page text (the secK* labels, RR-11's two error texts: scripts/i18n/m2.py)", () => {
    const full = Object.keys(readCatalogs(resolve(__dirname, "../..")).en!);
    const pageOnly = ["errSyncOn", "errNextSyncOn", "errCleanupPending", "errNextCleanupPending"];
    for (const k of ["secKSyncOn", ...pageOnly]) expect(full).toContain(k); // the full one does
    expect(popup.keys.filter((k) => k.startsWith("secK") || pageOnly.includes(k))).toEqual([]);
  });
  it("RR-11: the settings page says what sync_on and cleanup_pending mean, in both languages, never the code (errText)", async () => {
    const { errText } = await import("../../src/options/shared");
    const { ServiceError } = await import("../../src/core/service/service-error");
    const { loadCatalog, setLangChoice } = await import("../../src/ui/i18n");
    const { fullCatalog } = await import("../../src/ui/catalog-full");
    try {
      for (const lang of ["en", "zh_CN"] as const) {
        setLangChoice(lang);
        await loadCatalog(fullCatalog);
        const cat = readCatalogs(resolve(__dirname, "../.."))[lang]!;
        for (const [code, what, next] of [
          ["sync_on", "errSyncOn", "errNextSyncOn"],
          ["cleanup_pending", "errCleanupPending", "errNextCleanupPending"],
        ] as const) {
          const text = errText(new ServiceError(code));
          expect(text, `${lang} ${code}`).toContain(cat[what]!.message);
          expect(text, `${lang} ${code}`).toContain(cat[next]!.message);
          expect(text).not.toContain(code);
        }
      }
    } finally {
      setLangChoice("en");
      await loadCatalog(fullCatalog);
    }
  });
});

describe("§0.0i item 16: the commit capabilities", () => {
  it("only M1's bundle-eval.ts (the adopt verdicts) and presend.ts (published) issue them; M2 only reads them (keysOf)", () => {
    const importers = files
      .filter((f) => /import\s*\{[^}]*\bissue\b[^}]*\}\s*from\s*["']\.\/capability["']/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["core/sync/crypto/bundle-eval.ts", "core/sync/crypto/presend.ts"]);
    expect(new Set(sites(/\bissue\(/).map((x) => x.split(":")[0]))).toEqual(
      new Set(["core/sync/crypto/bundle-eval.ts", "core/sync/crypto/presend.ts"]),
    );
    const readers = files
      .filter((f) => /import\s*\{[^}]*\bkeysOf\b[^}]*\}\s*from\s*["'][^"']*capability["']/.test(code(f.text)))
      .map((f) => f.path);
    expect(readers).toEqual(["core/service/sync-flows.ts"]);
  });
});

describe("R4: a KeyBundle's keyring wraps exactly password and recovery (kept, with a test)", () => {
  it("a webauthn-prf wrap (a YubiKey's, which stays in sk_prf) makes the bundle invalid", async () => {
    const f = await keyrings();
    const b = await bundleOf(f.v1, f.k1, 2);
    const prf = {
      method: "webauthn-prf",
      vkId: f.k1.vkId,
      iv: toB64(new Uint8Array(12)),
      wrapped: toB64(new Uint8Array(48)),
      credentialId: "x",
      createdAt: 0,
    };
    expect(() =>
      checkBundleShape({ ...b, keyring: { ...b.keyring, wraps: [...b.keyring.wraps, prf] } }, "read"),
    ).toThrow(expect.objectContaining({ code: "invalid_bundle" }));
    expect(() =>
      checkBundleShape({ ...b, keyring: { ...b.keyring, wraps: [b.keyring.wraps[0], prf] } }, "read"),
    ).toThrow(expect.objectContaining({ code: "invalid_bundle" }));
  }, 30_000);
});

describe("R8: the security record's one version bump", () => {
  // The version-1 reader as shipped in Phase 0.x (security-log.ts before M2): anything above v: 1 is a newer version's.
  const v1Reader = (x: unknown) =>
    typeof x === "object" && x !== null && typeof (x as { v?: unknown }).v === "number" && (x as { v: number }).v > 1
      ? "newer"
      : "readable";
  it("written as version 2, which a version-1 reader takes as newer and leaves alone; this version reads both", () => {
    expect(SECURITY_LOG_VERSION).toBe(2);
    expect(v1Reader({ v: SECURITY_LOG_VERSION, entries: [] })).toBe("newer");
    expect(parseSecurityLog({ v: 1, entries: [{ at: 1, kind: "unlock_failed" }] })).toMatchObject({
      v: 2,
      entries: [{ at: 1, kind: "unlock_failed" }],
      failed: 1,
    });
    expect(parseSecurityLog({ v: 2, entries: [{ at: 1, kind: "prf_failed" }] })).toMatchObject({
      v: 2,
      entries: [{ kind: "prf_failed" }],
      failed: 0,
    });
    expect(parseSecurityLog({ v: 3, entries: [] })).toBe("newer");
  });
  it("one bump covers M2's kinds and the device unlock's; the wrong-guess count is still only wrong passwords and codes", () => {
    for (const k of [
      "sync_on",
      "sync_off",
      "identity_restored",
      "keys_adopted",
      "device_approved",
      "device_revoked",
      "history_cleared",
      "prf_enrolled",
      "prf_removed",
      "prf_failed",
    ])
      expect(SECURITY_KINDS, k).toContain(k);
    // the YubiKey reservations (oath_on, oath_off) went with budget work 3: since revision 25 a version keeps the entries
    // of kinds it does not know (StoredEntry), so a kind needs no reservation; the YubiKey features add theirs with them,
    // and none was ever recorded (docs/design/notes/BUDGET3-NOTES.md §3)
    for (const k of ["oath_on", "oath_off"]) expect(SECURITY_KINDS, k).not.toContain(k);
    expect(parseSecurityLog({ v: 2, entries: [{ at: 1, kind: "oath_on" }] })).toMatchObject({
      entries: [{ at: 1, kind: "oath_on" }],
      failed: 0,
    });
    // QUICK-UNLOCK Stage 1 added pin_failed, a wrong PIN: a guess like a wrong password (still no version bump: M6's rule)
    expect(FAILURES).toEqual(["unlock_failed", "recovery_failed", "pin_failed"]);
  });
});
