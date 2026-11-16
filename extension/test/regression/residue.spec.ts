// Regression: LevelDB keeps old values in its log files after they are overwritten. Accounts that existed before the
// master password was turned on can therefore still be read from a copy of the profile with the old device key (a limit
// of the storage engine, see docs/security/local-vault.md). The defences tested here: the password is set before any account can be
// added, and a restored or started-over vault is never under a device key either (SYNC-DESIGN H1, review H-a); an old
// vault that already has accounts gets a warning.
import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createBackup } from "../../src/core/backup/backup";
import { parseOtpauth } from "../../src/core/totp/otpauth";
import { createClock } from "../../src/core/vault/hlc";
import { emptyVault } from "../../src/core/vault/model";
import { addEntry } from "../../src/core/vault/ops";
import {
  addByPaste,
  AWS_URI,
  close,
  finishWizard,
  GITHUB_URI,
  launch,
  openOptions,
  openPopup,
  seedLegacyDeviceVault,
  startFresh,
  STRONG,
  writeTmp,
  type Profile,
} from "../e2e/harness";
import { unlockWithDevice, validateKeyring } from "../../src/core/crypto/keyring";
import { decryptVault } from "../../src/core/crypto/envelope";
import { deserializeVault } from "../../src/core/vault/validate";

/** Pull every JSON object that starts with `start` out of raw LevelDB bytes (the .log file stores values verbatim). */
function objectsIn(raw: string, start: string): unknown[] {
  const out: unknown[] = [];
  for (let i = raw.indexOf(start); i >= 0; i = raw.indexOf(start, i + 1)) {
    let depth = 0;
    for (let j = i; j < raw.length; j++) {
      if (raw[j] === "{") depth++;
      else if (raw[j] === "}" && --depth === 0) {
        try {
          out.push(JSON.parse(raw.slice(i, j + 1)));
        } catch {
          /* split record */
        }
        break;
      }
    }
  }
  return out;
}

/** What someone with a copy of the profile folder can read, with no password. */
async function attack(dir: string): Promise<string[]> {
  const recovered: string[] = [];
  for (const f of filesUnder(join(dir, "Default", "Local Extension Settings"))) {
    for (const g of objectsIn(readFileSync(f).toString("latin1"), '{"envelope":') as any[]) {
      try {
        const vk = await unlockWithDevice(validateKeyring(g.keyring));
        const v = deserializeVault(await decryptVault(g.envelope, vk));
        for (const e of v.entries)
          recovered.push(`${e.issuer}:${e.label} secret=${e.secret.slice(0, 6)}... (${f.split("/").pop()})`);
      } catch {
        /* not a device-protected generation */
      }
    }
  }
  return [...new Set(recovered)];
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Device-key material in the files of the extension's two stores. chrome.storage.local (Local Extension Settings) keeps
 * JSON; IndexedDB (the mirror) keeps V8-serialized values, where field names are plain bytes but there is no JSON, so the
 * bare field name is what is searched for in both. The legacy-vault test below shows this finds what it looks for.
 */
function deviceMaterialIn(dir: string): { settings: string[]; indexedDb: string[] } {
  const out = { settings: [] as string[], indexedDb: [] as string[] };
  for (const f of filesUnder(join(dir, "Default"))) {
    const where = /Local Extension Settings/.test(f) ? "settings" : /IndexedDB/.test(f) ? "indexedDb" : null;
    if (!where) continue;
    const raw = readFileSync(f).toString("latin1");
    if (raw.includes("deviceKey") || raw.includes('"method":"device"')) out[where].push(f.split("/").pop()!);
  }
  return out;
}

/** The seeds, base32 as stored, in any file of the two stores. */
function seedsIn(dir: string, seeds: string[]): string[] {
  const hits: string[] = [];
  for (const f of filesUnder(join(dir, "Default"))) {
    if (!/Local Extension Settings|IndexedDB/.test(f)) continue;
    const raw = readFileSync(f).toString("latin1");
    for (const s of seeds) if (raw.includes(s)) hits.push(`${s.slice(0, 6)}... in ${f.split("/").pop()}`);
  }
  return hits;
}

const GITHUB_SEED = "GEZDGNBVGY3TQOJQ";
const AWS_SEED = "JBSWY3DPEHPK3PXP";

let p: Profile;
test.afterEach(async () => {
  if (p) await close(p);
});

test("setting the password before adding accounts leaves nothing to recover from the profile files", async () => {
  p = await launch();
  await startFresh(p); // the first run: master password and recovery code before any account can be added
  const opt = await openOptions(p, "#security");
  await expect(opt.locator("#security")).toBeVisible();
  expect(await opt.locator("#residue-warning").count()).toBe(0); // empty vault: nothing to warn about
  await addByPaste(p, GITHUB_URI);
  await opt.waitForTimeout(1500);

  const dir = p.dir;
  await close(p, false);
  expect(await attack(dir)).toEqual([]);
  // the secret itself is not in any profile file, in any form
  for (const f of filesUnder(join(dir, "Default"))) {
    if (!/Local Extension Settings|IndexedDB/.test(f)) continue;
    expect(readFileSync(f).toString("latin1")).not.toContain("GEZDGNBVGY3TQOJQ");
  }
  p = undefined as never;
});

test("accounts added before the password was turned on: the page says they may still be recoverable", async () => {
  p = await launch();
  await seedLegacyDeviceVault(p); // a Phase 0 vault "without a password": new installs can no longer make one
  await addByPaste(p, GITHUB_URI);
  const opt = await openOptions(p, "#security");
  await expect(opt.locator("#residue-warning")).toBeVisible();

  // Control for the scans below: on this vault they do find the device key, in both stores, and the seed is recoverable.
  await opt.waitForTimeout(1500);
  const dir = p.dir;
  await close(p, false);
  p = undefined as never;
  const found = deviceMaterialIn(dir);
  expect(found.settings.length).toBeGreaterThan(0);
  expect(found.indexedDb.length).toBeGreaterThan(0);
  expect((await attack(dir)).join()).toContain("GitHub");
});

// H1 acceptance (review H-a): a fresh profile set up from a backup. The real seeds go straight under the master password,
// so no copy of the profile folder, compacted or not, holds a device key or a device wrap that could open them.
test("restoring a backup into a fresh profile leaves no seed, device key or device wrap in the profile files", async () => {
  const clock = createClock("cccc");
  let v = emptyVault("backup-vault-res-1");
  for (const u of [GITHUB_URI, AWS_URI]) {
    const r = parseOtpauth(u);
    if (!r.ok) throw new Error(r.error);
    v = addEntry(v, r.value, clock).vault;
  }
  const file = writeTmp("backup.json", JSON.stringify(await createBackup(v, STRONG)));

  p = await launch();
  const pop = await openPopup(p);
  const [opt] = await Promise.all([p.ctx.waitForEvent("page"), pop.locator("#start-restore").click()]);
  await opt.waitForLoadState();
  await opt.locator("#fr-backup-file").setInputFiles(file);
  await opt.locator("#fr-open-pw").fill(STRONG);
  await opt.getByRole("button", { name: /Open backup|打开备份/ }).click();
  await opt.locator("#fr-restore-next").click();
  await finishWizard(opt);
  await addByPaste(p, "otpauth://totp/Later:me?secret=MFRGGZDFMZTWQ2LK&issuer=Later"); // a write after the restore, too
  const check = await openPopup(p);
  await expect(check.locator(".row")).toHaveCount(3);
  await opt.waitForTimeout(1500);

  const dir = p.dir;
  await close(p, false);
  p = undefined as never;
  expect(deviceMaterialIn(dir)).toEqual({ settings: [], indexedDb: [] });
  expect(await attack(dir)).toEqual([]);
  expect(seedsIn(dir, [GITHUB_SEED, AWS_SEED, "MFRGGZDFMZTWQ2LK"])).toEqual([]);
});

// The same for "Start over" after the stored data became unreadable.
test("starting over after unreadable data leaves no device key or device wrap in the profile files", async () => {
  p = await launch();
  const seedPage = await openPopup(p);
  await seedPage.evaluate(() => chrome.storage.local.set({ sk_active: "a", sk_slot_a: { torn: "half a write" } })); // unreadable, nothing to recover
  await seedPage.close();
  const opt = await openOptions(p, "#advanced");
  await expect(opt.getByRole("alert").first()).toContainText(/could not be read|无法读取/);
  await opt.locator("#so-confirm").fill("DELETE");
  await opt.locator("#so-go").click();
  await finishWizard(opt);
  await addByPaste(p, GITHUB_URI);
  const check = await openPopup(p);
  await expect(check.locator(".row")).toHaveCount(1);
  await opt.waitForTimeout(1500);

  const dir = p.dir;
  await close(p, false);
  p = undefined as never;
  expect(deviceMaterialIn(dir)).toEqual({ settings: [], indexedDb: [] });
  expect(await attack(dir)).toEqual([]);
  expect(seedsIn(dir, [GITHUB_SEED])).toEqual([]);
});
