import { describe, expect, it } from "vitest";
import { fullCatalog } from "../../src/ui/catalog-full";
import { resolveLang, t, setLangChoice, getLang, loadCatalog } from "../../src/ui/i18n";

describe("language choice", () => {
  it("auto follows the browser; every Chinese variant gets the Chinese catalog", () => {
    for (const l of ["zh", "zh-CN", "zh-TW", "zh-HK", "zh-Hans-CN", "ZH-cn"])
      expect(resolveLang("auto", l), l).toBe("zh_CN");
    for (const l of ["en", "en-US", "en-GB", "de", "ja", "", "zhx"]) expect(resolveLang("auto", l), l).toBe("en");
  });
  it("an explicit choice wins over the browser", () => {
    expect(resolveLang("en", "zh-CN")).toBe("en");
    expect(resolveLang("zh_CN", "en-US")).toBe("zh_CN");
  });
  it("t() uses the chosen catalog, fills placeholders, and falls back to English then to the key", async () => {
    setLangChoice("en");
    await loadCatalog(fullCatalog);
    expect(getLang()).toBe("en");
    expect(t("count", 3)).toBe("3 accounts");
    setLangChoice("zh_CN");
    await loadCatalog(fullCatalog);
    expect(getLang()).toBe("zh_CN");
    expect(t("count", 3)).toBe("3 个账户");
    expect(t("previewFailed", 2, "x")).toBe("第 2 行已跳过：x");
    expect(t("no_such_key_anywhere")).toBe("no_such_key_anywhere");
    setLangChoice("en");
    await loadCatalog(fullCatalog);
  });
});

describe("dates follow the chosen language", () => {
  it("Chinese and English formats differ and carry the year", async () => {
    const { formatDateTime, formatDate } = await import("../../src/ui/i18n");
    const ms = Date.UTC(2026, 9, 15, 10, 31);
    setLangChoice("zh_CN");
    expect(formatDateTime(ms)).toMatch(/2026年10月15日/);
    expect(formatDate(ms)).toMatch(/2026年10月15日/);
    setLangChoice("en");
    expect(formatDateTime(ms)).toMatch(/15 Oct 2026/);
    setLangChoice("en");
  });
});
