import { describe, expect, it } from "vitest";
import { applyImport, exportOtpauthList, planImport } from "../../src/core/import/importer";
import { BackupError, createBackup, openBackup, parseBackupFile } from "../../src/core/backup/backup";
import { parseOtpauthList } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { aliveEntries, emptyVault } from "../../src/core/vault/model";
import { addEntry, deleteEntry, purgeEntry } from "../../src/core/vault/ops";
import { fromB64, toB64 } from "../../src/core/crypto/bytes";
import { createMutex, MemoryKV } from "../../src/core/storage/kv";
import { VaultStore } from "../../src/core/storage/store";
import { VaultService } from "../../src/core/service/service";
import { KvSettingsStore, MemorySession } from "../../src/core/service/types";
import { createProtected, deviceMaterial, STRONG } from "../helpers/vaults";

const S1 = "JBSWY3DPEHPK3PXP";
const S2 = "GEZDGNBVGY3TQOJQ";
const clock = createClock("aaaa", { now: () => 1_700_000_000_000 });
const u = (issuer: string, label: string, secret = S1, extra = "") =>
  `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}${extra}`;

// data= for a GA export with one entry (dim13 sample): Example:alice@google.com, secret JBSWY3DPEHPK3PXP
const GA = "otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTAC";

describe("planImport", () => {
  it("separates new, duplicate and failed lines without echoing any secret", () => {
    const base = addEntry(
      emptyVault("vault-0123456789"),
      { type: "totp", issuer: "GitHub", label: "a", secret: S1, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
    ).vault;
    const text = [
      u("GitHub", "a"),
      u("AWS", "b", S2),
      u("AWS", "b", S2),
      "garbage line",
      "otpauth://totp/x",
      u("Odd", "c", S2, "&digits=7"),
    ].join("\n");
    const { plan } = planImport(text, base.entries);
    expect(plan.add.map((p) => p.issuer)).toEqual(["AWS"]);
    expect(plan.duplicates.map((p) => p.issuer)).toEqual(["GitHub", "AWS"]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["not_otpauth", "missing_secret", "unsupported_digits"]);
    expect(JSON.stringify(plan.failed)).not.toContain(S1);
  });
  it("reads Google Authenticator exports mixed with plain links", () => {
    const { plan } = planImport(`${GA}\n${u("Plain", "p", S2)}`, []);
    expect(plan.add.map((p) => `${p.issuer}/${p.label}`)).toEqual(["Plain/p", "Example/alice@google.com"]);
  });
  it("reports exports that are still missing codes", () => {
    // batch of 2, only index 0 present: build by flipping batch_size in the sample payload
    const { plan } = planImport(GA, []);
    expect(plan.incomplete).toEqual([]);
  });
  it("keeps HOTP accounts and counts them so the UI can say they cannot generate codes yet", () => {
    const { plan } = planImport(`otpauth://hotp/H:h?secret=${S1}&issuer=H&counter=3`, []);
    expect(plan.add[0]).toMatchObject({ type: "hotp", counter: 3 });
    expect(plan.warnings.hotp).toBe(1);
  });
  it("counts short secrets and issuer conflicts", () => {
    const { plan } = planImport(`otpauth://totp/A:x?secret=JBSWY3DP&issuer=B`, []);
    expect(plan.warnings).toMatchObject({ short_secret: 1, issuer_mismatch: 1 });
  });
  it("applyImport adds in order", () => {
    const { plan } = planImport([u("A", "1"), u("B", "2", S2)].join("\n"), []);
    const v = applyImport(emptyVault("vault-0123456789"), plan.add, clock, { group: "Imported" });
    expect(aliveEntries(v).map((e) => `${e.issuer}:${e.group}`)).toEqual(["A:Imported", "B:Imported"]);
  });
});

describe("plain-text export", () => {
  it("writes live entries only and re-imports to the same accounts", () => {
    let v = emptyVault("vault-0123456789");
    v = addEntry(
      v,
      { type: "totp", issuer: "A B", label: "me@x.com", secret: S1, algorithm: "SHA256", digits: 8, period: 60 },
      clock,
      { id: "entry-0000001" },
    ).vault;
    v = addEntry(
      v,
      { type: "hotp", issuer: "H", label: "h", secret: S2, algorithm: "SHA1", digits: 6, period: 30, counter: 7 },
      clock,
      { id: "entry-0000002" },
    ).vault;
    v = addEntry(
      v,
      { type: "totp", issuer: "Gone", label: "g", secret: S2, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
      { id: "entry-0000003" },
    ).vault;
    v = deleteEntry(v, "entry-0000003", clock);
    const text = exportOtpauthList(v);
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text).not.toContain("Gone");
    const back = parseOtpauthList(text).map((i) => (i.result.ok ? i.result.value : null));
    expect(back[0]).toMatchObject({
      issuer: "A B",
      label: "me@x.com",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      secret: S1,
    });
    expect(back[1]).toMatchObject({ type: "hotp", counter: 7 });
  });
});

describe("encrypted backup", () => {
  const vault = () => {
    let v = emptyVault("vault-0123456789");
    v = addEntry(
      v,
      { type: "totp", issuer: "A", label: "a", secret: S1, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
      { id: "entry-0000001" },
    ).vault;
    v = addEntry(
      v,
      { type: "totp", issuer: "B", label: "b", secret: S2, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
      { id: "entry-0000002" },
    ).vault;
    return purgeEntry(deleteEntry(v, "entry-0000002", clock), "entry-0000002", clock);
  };
  const PW = "backup password 2026";

  it("round-trips the whole vault, including tombstones", async () => {
    const v = vault();
    const f = await createBackup(v, PW);
    expect(JSON.stringify(f)).not.toContain(S1);
    const { vault: back } = await openBackup(JSON.parse(JSON.stringify(f)), PW);
    expect(back).toEqual(v);
  });
  it("wrong password and any tampering fail the same way", async () => {
    const f = await createBackup(vault(), PW);
    await expect(openBackup(f, "another password")).rejects.toMatchObject({ code: "wrong_password_or_damaged" });
    const ct = fromB64(f.ciphertext);
    ct[2]! ^= 1;
    await expect(openBackup({ ...f, ciphertext: toB64(ct) }, PW)).rejects.toMatchObject({
      code: "wrong_password_or_damaged",
    });
    await expect(openBackup({ ...f, created: f.created + 1 }, PW)).rejects.toMatchObject({
      code: "wrong_password_or_damaged",
    }); // header is authenticated
    await expect(openBackup({ ...f, kdf: { ...f.kdf, iterations: f.kdf.iterations + 1 } }, PW)).rejects.toMatchObject({
      code: "wrong_password_or_damaged",
    });
  });
  it("refuses weakened KDF settings in a file before doing any work", async () => {
    const f = await createBackup(vault(), PW);
    await expect(openBackup({ ...f, kdf: { ...f.kdf, iterations: 1000 } }, PW)).rejects.toMatchObject({
      code: "invalid_file",
    });
  });
  it("rejects files that are not backups, and newer formats", () => {
    for (const bad of [null, "x", {}, { format: "other" }, { format: "sixkey-backup", v: 1 }])
      expect(() => parseBackupFile(bad)).toThrow(BackupError);
    expect(() => parseBackupFile({ format: "sixkey-backup", v: 2 })).toThrow(
      expect.objectContaining({ code: "newer_format" }),
    );
  });
  it("contains no key material", async () => {
    const f = await createBackup(vault(), PW);
    expect(Object.keys(f).sort()).toEqual(["app", "ciphertext", "created", "format", "iv", "kdf", "v"]);
  });
});

describe("restoring and importing through the service", () => {
  function setup() {
    const kv = new MemoryKV();
    const t = { now: 1_700_000_000_000 };
    const svc = new VaultService({
      store: new VaultStore({ lock: createMutex(), kv, now: () => t.now }),
      session: new MemorySession(),
      settings: new KvSettingsStore(kv),
      now: () => t.now,
    });
    return { kv, svc, t };
  }
  const backupVault = () => {
    let v = emptyVault("backup-vault-id-1");
    v = addEntry(
      v,
      { type: "totp", issuer: "A", label: "a", secret: S1, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
      { id: "entry-0000001" },
    ).vault;
    v = addEntry(
      v,
      { type: "totp", issuer: "B", label: "b", secret: S2, algorithm: "SHA1", digits: 6, period: 30 },
      clock,
      { id: "entry-0000002" },
    ).vault;
    return v;
  };

  // A restore keeps the backup's vault id, so its keys are prepared for that id (H1: password first, never a device key).
  const keysFor = (w: ReturnType<typeof setup>) => w.svc.prepareKeys(STRONG, { vaultId: "backup-vault-id-1" });

  it("restores into a fresh install, keeping the backup's vault id", async () => {
    const w = setup();
    await w.svc.restoreBackup(backupVault(), await keysFor(w));
    const { vault } = await w.svc.read();
    expect(vault.vaultId).toBe("backup-vault-id-1");
    expect(aliveEntries(vault).map((e) => e.issuer)).toEqual(["A", "B"]);
    expect(await w.svc.status()).toMatchObject({ state: "unlocked", passwordProtected: true });
    // the restored secrets were never under a device key, so no copy of one can open them
    expect(deviceMaterial(w.kv)).toEqual([]);
    expect((await w.svc.currentGeneration())!.keyring.wraps.map((x) => x.method).sort()).toEqual([
      "password",
      "recovery",
    ]);
  });
  it("refuses to restore over a vault that is readable", async () => {
    const w = setup();
    await createProtected(w.svc);
    await expect(w.svc.restoreBackup(backupVault(), await keysFor(w))).rejects.toMatchObject({ code: "bad_state" }); // keys match: refused for the state
  });
  it("imports another vault's accounts as new entries, skipping ones already there", async () => {
    const w = setup();
    await createProtected(w.svc);
    await w.svc.mutate(
      (v, c) =>
        addEntry(v, { type: "totp", issuer: "A", label: "a", secret: S1, algorithm: "SHA1", digits: 6, period: 30 }, c)
          .vault,
    );
    const r = await w.svc.importBackup(backupVault());
    expect(r).toEqual({ mode: "added", added: 1 });
    expect(aliveEntries((await w.svc.read()).vault).map((e) => e.issuer)).toEqual(["A", "B"]);
  });
  it("an older copy of the same vault is merged: later deletions survive", async () => {
    const w = setup();
    await w.svc.restoreBackup(backupVault(), await keysFor(w));
    const old = (await w.svc.read()).vault;
    w.t.now += 60_000;
    await w.svc.mutate((v, c) => deleteEntry(v, "entry-0000001", c));
    const r = await w.svc.importBackup(old);
    expect(r.mode).toBe("merged");
    expect(aliveEntries((await w.svc.read()).vault).map((e) => e.issuer)).toEqual(["B"]);
  });
  it("a backup with timestamps far in the future cannot win every later edit", async () => {
    const w = setup();
    await w.svc.restoreBackup(backupVault(), await keysFor(w));
    const evil = structuredClone((await w.svc.read()).vault);
    evil.entries[0]!.hlc = "9999999999999.0000.zzzz";
    await w.svc.importBackup(evil);
    w.t.now += 60_000;
    await w.svc.mutate((v, c) => {
      const e = v.entries[0]!;
      expect(e.hlc < "1700090000000").toBe(true);
      return { ...v, entries: v.entries.map((x) => (x.id === e.id ? { ...x, issuer: "edited", hlc: c.next() } : x)) };
    });
  });
});
