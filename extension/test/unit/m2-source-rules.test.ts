// M2's rules about the source (SYNC-DESIGN §0.0i req. 3, 5, 15; YUBIKEY-DESIGN §5.1 R2-R5, R8) that still hold now that
// the server sync's client is gone from the extension (OWNER-DECISIONS/25, DV-0b): what holds by construction and that no
// run-time check would notice a new line breaking. Comments are not code. (The rules about that client itself, its flows,
// records, capabilities and KeyBundle, went with it; scripts/build.mjs's graph guard and check-dist keep it out.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { popupKeys, readCatalogs } from "../../scripts/catalog-keys.mjs";
import { SECURITY_KINDS } from "../../src/core/service/security-kinds";
import { parseSecurityLog, SECURITY_LOG_VERSION, FAILURES } from "../../src/core/service/security-log";

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
const SERVICE_CODE = (p: string) => p === "core/service/service.ts" || p === "core/service/service-core.ts";

describe("M2 source rules", () => {
  it("finds the sources (so the rules are not vacuous), and none of the server sync's client (DV-0b)", () => {
    for (const p of [
      "core/service/service.ts",
      "core/service/service-core.ts",
      "core/storage/local-keys.ts",
      "platform/runtime-base.ts",
    ])
      expect(
        files.some((f) => f.path === p),
        p,
      ).toBe(true);
    expect(files.filter((f) => /^core\/sync\/|^core\/service\/sync-flows\.ts$|^platform\/sync-/.test(f.path))).toEqual(
      [],
    );
  });

  it("R2: no hand-written schemaVersion outside the vault model (model.ts, merge.ts, validate.ts): vaults are built by emptyVault, parseVault, mergeVaults and ops", () => {
    expect(
      sites(/schemaVersion\s*:/)
        .map((s) => s.split(":")[0])
        .filter((p) => !["core/vault/model.ts", "core/vault/merge.ts", "core/vault/validate.ts"].includes(p!)),
    ).toEqual([]);
    expect(sites(/schemaVersion\s*=(?!=)/)).toEqual([]); // and no assignment anywhere (spreading a vault and setting it)
  });

  it("R3: the service judges an account's identity only through the named helpers (entryIdentity, isPurged), never by comparing `.secret`", () => {
    expect(sites(/\.secret\s*[!=]==?|[!=]==?\s*[\w.]+\.secret\b|\$\{[^}]*\.secret\b/, SERVICE_CODE)).toEqual([]);
    expect(
      sites(/\.secret\s*[!=]==?|[!=]==?\s*[\w.]+\.secret\b|\$\{[^}]*\.secret\b/, (p) => p === "core/vault/ops.ts"),
    ).toEqual([]);
    const service = files.find((f) => f.path === "core/service/service.ts")!.text;
    const purge = service.slice(service.indexOf("async purgeForever("));
    expect(purge.slice(0, purge.indexOf("\n  }\n"))).toMatch(/entryIdentity\(/);
    expect(files.find((f) => f.path === "core/vault/ops.ts")!.text).toMatch(/const id = entryIdentity\(e\)/);
  });

  it("R5: sk_prf, sk_oath and the PIN's records are not vault data (hasAnyData), and are named in one place", () => {
    const store = files.find((f) => f.path === "core/storage/store.ts")!.text;
    const has = store.slice(store.indexOf("private async hasAnyData("));
    expect(has.slice(0, has.indexOf("\n  }\n"))).not.toMatch(/sk_prf|sk_oath|sk_sync|prejoin/);
    const keys = files.find((f) => f.path === "core/storage/local-keys.ts")!.text;
    expect(code(keys)).toMatch(
      /LOCAL_ONLY_KEYS = \{ prf: "sk_prf", oath: "sk_oath", pin: "sk_pin", restart: "sk_pin_restart" \}/,
    );
    expect(has.slice(0, has.indexOf("\n  }\n"))).not.toMatch(/sk_pin|sk_quick/);
  });

  it("A4R-4: the runtime builds the records with the store's own lock name; the service's steps are reached only from its admins", () => {
    // the wiring every context shares (platform/runtime.ts builds it with VaultService, the popup with ServiceCore): the
    // PIN's set-up (QUICK-UNLOCK §5.9), the device unlock's record (Stage 2), and the plugin grant store's record
    // (autofill's switch, its code lazy) under the store's own lock
    const rt = files.find((f) => f.path === "platform/runtime-base.ts")!.text;
    expect(code(rt)).toMatch(/vkRecords: \[pins, prfs, grants\]/);
    expect(code(rt)).toMatch(
      /new GrantStore\(\{ local, session: new ChromeLocalKV\(area\), lock: webLock\("sixkey-vault"\) \}\)/,
    );
    expect(code(rt)).toMatch(/new PrfStore\(local, webLock\("sixkey-vault"\)\)/);
    expect(code(rt)).toMatch(/new PinStore\(local, webLock\("sixkey-vault"\)\)/);
    // the recovery hook marks the cloud backup's link (CLOUDBK patch 4, rule 2), and nothing more since the server sync's
    // lastSynced went with its client
    expect(code(rt)).toMatch(/beforeRecoveryWrite: \(\) => markCsbHeld\(local, webLock\("sixkey-csb"\)\)/);
    // element access to the service's private steps: in the admins' below only (sync-flows.ts was one); the device unlock's
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
        "core/service/pin-admin.ts",
        "core/service/device-admin.ts",
        "core/service/device-unlock.ts",
        "core/service/prf-write.ts",
        "core/service/pin-restart-admin.ts",
        "core/service/pin-restart-steps.ts",
        "core/service/pin-restart-count.ts",
        // the master password compared without a record (an export confirmed with the PIN, OWNER-DECISIONS/26): the store
        "core/service/master-check.ts",
      ]),
    );
  });

  it("the service loads nothing on demand: neither of its two files imports a module at run time", () => {
    expect(code(files.find((f) => f.path === "core/service/service.ts")!.text)).not.toMatch(/import\(/);
    expect(code(files.find((f) => f.path === "core/service/service-core.ts")!.text)).not.toMatch(/import\(/);
  });
});

describe("the popup's own module graph (M2R-8): what scripts/catalog-keys.mjs reads from the popup's entry points", () => {
  let popup: { modules: string[]; keys: string[] };
  beforeAll(() => {
    popup = popupKeys(resolve(__dirname, "../.."));
  }, 30_000);
  it("holds none of the server sync's client (gone: DV-0b), nor VaultService or the runtime that builds it", () => {
    expect(popup.modules).toContain("src/core/service/service-core.ts"); // not vacuous: the graph is the popup's
    expect(
      popup.modules.filter(
        (m) =>
          m.startsWith("src/core/sync/") ||
          /^src\/core\/service\/sync-flows\.ts$|^src\/platform\/(?:sync-|bridge-|fetch-transport|api-)/.test(m),
      ),
    ).toEqual([]);
    expect(popup.modules).not.toContain("src/core/service/service.ts");
    expect(popup.modules).not.toContain("src/platform/runtime.ts");
  });
  it("the popup's catalog carries none of M2's settings-page text (the secK* labels, RR-11's error text: scripts/i18n/m2.py)", () => {
    const full = Object.keys(readCatalogs(resolve(__dirname, "../..")).en!);
    const pageOnly = ["errCleanupPending", "errNextCleanupPending"];
    for (const k of ["secKPrfEnrolled", ...pageOnly]) expect(full).toContain(k); // the full one does
    expect(popup.keys.filter((k) => k.startsWith("secK") || pageOnly.includes(k))).toEqual([]);
  });
  it("RR-11: the settings page says what cleanup_pending means, in both languages, never the code (errText)", async () => {
    const { errText } = await import("../../src/options/shared");
    const { ServiceError } = await import("../../src/core/service/service-error");
    const { loadCatalog, setLangChoice } = await import("../../src/ui/i18n");
    const { fullCatalog } = await import("../../src/ui/catalog-full");
    try {
      for (const lang of ["en", "zh_CN"] as const) {
        setLangChoice(lang);
        await loadCatalog(fullCatalog);
        const cat = readCatalogs(resolve(__dirname, "../.."))[lang]!;
        const text = errText(new ServiceError("cleanup_pending"));
        expect(text, lang).toContain(cat.errCleanupPending!.message);
        expect(text, lang).toContain(cat.errNextCleanupPending!.message);
        expect(text).not.toContain("cleanup_pending");
      }
    } finally {
      setLangChoice("en");
      await loadCatalog(fullCatalog);
    }
  });
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
    for (const k of ["prf_enrolled", "prf_removed", "prf_failed"]) expect(SECURITY_KINDS, k).toContain(k);
    // the server sync's kinds went with its client (DV-0b): no kind nobody records; their entries in a record (a
    // developer profile's) are kept as a newer version's are, and counted as no guess
    for (const k of [
      "sync_on",
      "sync_off",
      "identity_restored",
      "keys_adopted",
      "device_approved",
      "device_revoked",
      "history_cleared",
      "keys_adopted_back",
    ]) {
      expect(SECURITY_KINDS, k).not.toContain(k);
      expect(parseSecurityLog({ v: 2, entries: [{ at: 1, kind: k }] }), k).toMatchObject({
        entries: [{ at: 1, kind: k }],
        failed: 0,
      });
    }
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
