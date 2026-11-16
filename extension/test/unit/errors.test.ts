// PHASE0X-PLAN C8: error text says what happened and what to do next, in both languages, and never shows an error's
// name, code or message. Only the code or class reaches the local diagnostics log, and only for unexpected errors.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackupError } from "../../src/core/backup/backup";
import { CryptoError } from "../../src/core/crypto/bytes";
import { ServiceError } from "../../src/core/service/service";
import { StorageError } from "../../src/core/storage/store";
import { VaultError } from "../../src/core/vault/validate";
import { describeError, errorCode, errorLine, sectionOf } from "../../src/ui/errors";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice, t } from "../../src/ui/i18n";

const SECRET = "JBSWY3DPEHPK3PXP";

/** Typical errors, each with every name, code and message text that must never reach the screen. */
const CASES: { label: string; e: unknown; hidden: string[] }[] = [
  {
    label: "TypeError",
    e: new TypeError(`Cannot read properties of undefined (reading '${SECRET}')`),
    hidden: ["TypeError", SECRET, "undefined"],
  },
  {
    label: "DOMException QuotaExceededError",
    e: new DOMException("The quota has been exceeded.", "QuotaExceededError"),
    hidden: ["QuotaExceededError", "DOMException", "quota has been"],
  },
  ...(["verify_failed", "lost_needs_confirm", "unreadable"] as const).map((c) => ({
    label: `StorageError ${c}`,
    e: new StorageError(c, `slot a did not read back ${SECRET}`),
    hidden: ["StorageError", c, SECRET, "slot a"],
  })),
  ...(["invalid_file", "newer_format", "wrong_password_or_damaged", "weak_password"] as const).map((c) => ({
    label: `BackupError ${c}`,
    e: new BackupError(c),
    hidden: ["BackupError", c],
  })),
  ...(["locked", "wrong_secret", "bad_state", "weak_password", "already_protected", "not_protected"] as const).map(
    (c) => ({
      label: `ServiceError ${c}`,
      e: new ServiceError(c, `detail ${SECRET}`),
      hidden: ["ServiceError", SECRET, ...(c.includes("_") ? [c] : [])],
    }),
  ), // "locked" is also a plain word
  ...(["invalid_vault", "newer_schema"] as const).map((c) => ({
    label: `VaultError ${c}`,
    e: new VaultError(c, "entry 3 label too long"),
    hidden: ["VaultError", c, "entry 3"],
  })),
  ...(["decrypt_failed", "recovery_checksum", "unwrap_failed"] as const).map((c) => ({
    label: `CryptoError ${c}`,
    e: new CryptoError(c),
    hidden: ["CryptoError", c],
  })),
  { label: "plain Error", e: new Error(`otpauth://totp/x?secret=${SECRET}`), hidden: ["otpauth", SECRET, "Error:"] },
  {
    label: "plain object with a code",
    e: { code: "some_internal_code", detail: SECRET },
    hidden: ["some_internal_code", SECRET],
  },
  { label: "plain object without one", e: { foo: 1 }, hidden: ["foo", "[object Object]"] },
  { label: "a class name, as the popup's loader passes it", e: "TypeError", hidden: ["TypeError"] },
  { label: "a store class name", e: "StorageError", hidden: ["StorageError"] },
  { label: "a string message", e: `failed with ${SECRET}`, hidden: [SECRET, "failed with"] },
  { label: "null", e: null, hidden: ["null"] },
  { label: "a number", e: 42, hidden: ["42"] },
];

const LANGS = ["en", "zh_CN"] as const;
const keyLike = /\b(err|error|wrong|weak|need|bad|already|device|invalid|newer|backup|lost)[A-Z][A-Za-z]*\b/; // t() shows a missing key's name

async function use(lang: (typeof LANGS)[number]) {
  setLangChoice(lang);
  await loadCatalog(fullCatalog);
}

describe("error text", () => {
  beforeAll(() => use("en"));
  afterEach(() => use("en"));

  for (const lang of LANGS) {
    it(`${lang}: every typical error says what happened and what to do, and shows no name, code, message or key`, async () => {
      await use(lang);
      for (const { label, e, hidden } of CASES) {
        const { what, next } = describeError(e);
        const line = errorLine(e);
        for (const text of [what, next, line]) {
          expect(text.trim().length, label).toBeGreaterThan(3);
          for (const h of hidden) expect(text, `${label}: ${h}`).not.toContain(h);
          expect(text, label).not.toMatch(/[a-z]+_[a-z_]+/); // no snake_case code
          expect(text, label).not.toMatch(/\b[A-Z][a-z]+(Error|Exception)\b/); // no class name
          expect(text, label).not.toMatch(keyLike);
          expect(text, label).not.toContain("$");
        }
        expect(next, label).not.toBe(what);
        expect(line, label).toContain(what);
        expect(line, label).toContain(next);
      }
    });
  }

  it("the texts say the right thing for each kind (English)", () => {
    expect(describeError(new TypeError("x"))).toEqual({
      what: t("errorTitle"),
      next: "Try again. If it keeps failing, save diagnostics under Settings › Advanced.",
    });
    expect(describeError(new DOMException("q", "QuotaExceededError")).what).toBe(t("errSpace"));
    expect(describeError(new StorageError("unreadable")).next).toBe(
      "Try again. If it keeps failing, restore from a backup file under Settings › Backup.",
    );
    expect(describeError("StorageError")).toEqual(describeError(new StorageError("unreadable")));
    expect(describeError(new StorageError("verify_failed")).what).toBe(t("errSave"));
    expect(describeError(new ServiceError("wrong_secret")).what).toBe(t("wrongPassword"));
    expect(describeError(new ServiceError("weak_password")).next).toContain(`“${t("generate")}”`);
    expect(describeError(new BackupError("invalid_file")).next).toContain(`“${t("exportEncrypted")}”`);
    expect(describeError(new VaultError("newer_schema"))).toEqual({ what: t("newerTitle"), next: t("newerBody") });
    expect(errorLine(new ServiceError("wrong_secret"))).toBe("Wrong password. Check it and try again.");
    expect(errorLine({})).toBe(t("errorBody")); // the generic line other files still show by its old key
  });

  it("the places the text names are the real section titles, in both languages", async () => {
    for (const lang of LANGS) {
      await use(lang);
      expect(describeError(new Error("x")).next).toContain(`${t("settings")} › ${t("advancedTitle")}`);
      expect(describeError(new StorageError("unreadable")).next).toContain(`${t("settings")} › ${t("backupTitle")}`);
      expect(t("errorBody")).toContain(`${t("settings")} › ${t("advancedTitle")}`);
    }
  });

  it("the popup's settings button goes where the text says", () => {
    expect(sectionOf("TypeError")).toBe("advanced");
    expect(sectionOf(new StorageError("verify_failed"))).toBe("advanced");
    expect(sectionOf("StorageError")).toBe("backup");
    expect(sectionOf(new StorageError("lost_needs_confirm"))).toBe("backup");
    expect(sectionOf(new ServiceError("wrong_secret"))).toBeNull();
    expect(sectionOf(new DOMException("q", "QuotaExceededError"))).toBeNull();
  });
});

describe("errorCode, for the diagnostics log", () => {
  it("is the code, else the class name, and never a message", () => {
    expect(errorCode(new StorageError("verify_failed", SECRET))).toBe("verify_failed");
    expect(errorCode(new TypeError(SECRET))).toBe("TypeError");
    expect(errorCode(new DOMException("q", "QuotaExceededError"))).toBe("QuotaExceededError"); // numeric code skipped
    expect(errorCode("TypeError")).toBe("TypeError");
    expect(errorCode(`failed with ${SECRET}`)).toBe("unknown");
    expect(errorCode({ code: `bad ${SECRET}` })).toBe("unknown");
    expect(errorCode({ code: 7, name: "X" })).toBe("X");
    expect(errorCode(null)).toBe("unknown");
    expect(errorCode(undefined)).toBe("unknown");
  });
});

describe("logError", () => {
  const g = globalThis as Record<string, unknown>;
  let saved: Record<string, unknown>;
  afterEach(() => {
    delete g.chrome;
    vi.resetModules();
  });

  async function fresh() {
    saved = {};
    const area = {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in saved).map((k) => [k, saved[k]])),
      set: async (items: Record<string, unknown>) => void Object.assign(saved, items),
    };
    g.chrome = { storage: { local: area } };
    vi.resetModules();
    return (await import("../../src/ui/errors")).logError;
  }
  const log = () => (saved.sk_diag ?? []) as { message: string; error?: string }[];
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("records an unexpected error's class or code with where it was shown, never its message", async () => {
    const logError = await fresh();
    logError("popup could not open", "TypeError");
    await settle();
    logError("settings page error", new StorageError("verify_failed", SECRET));
    await settle();
    logError("settings page error", new Error(`otpauth://totp/x?secret=${SECRET}`));
    await settle();
    expect(log().map((x) => [x.message, x.error])).toEqual([
      ["popup could not open", "TypeError"],
      ["settings page error", "verify_failed"],
      ["settings page error", "Error"],
    ]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it("does not record what the user typed wrong", async () => {
    const logError = await fresh();
    for (const e of [
      new ServiceError("wrong_secret"),
      new ServiceError("weak_password"),
      new BackupError("invalid_file"),
      new BackupError("wrong_password_or_damaged"),
      new CryptoError("recovery_checksum"),
      new VaultError("invalid_vault"),
    ])
      logError("x", e);
    await settle();
    expect(log()).toEqual([]);
  });

  it("never throws without extension storage", async () => {
    vi.resetModules();
    const { logError } = await import("../../src/ui/errors");
    expect(() => logError("x", new TypeError("y"))).not.toThrow();
  });
});
