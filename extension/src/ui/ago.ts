// The time since a moment, in the page's language, with no text of any catalog: "3 分钟前" / "3 minutes ago". The
// backup in Chrome sync's card and first run (src/options/csb/model.ts re-exports it) and the popup's pill and welcome
// (src/popup/main/CsbPop.tsx, src/popup/screens/CsbFound.tsx) say when a copy was handed over or made with it, so the
// pages say it alike.

/** "3 分钟前" / "3 minutes ago": the time since `at`, in the page's language, with no text of the catalog's. */
export function ago(at: number, now: number, lang: string): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  const f = new Intl.RelativeTimeFormat(lang === "zh_CN" ? "zh-CN" : "en", { numeric: "auto" });
  if (s < 60) return f.format(-s, "second");
  if (s < 3600) return f.format(-Math.floor(s / 60), "minute");
  if (s < 86_400) return f.format(-Math.floor(s / 3600), "hour");
  return f.format(-Math.floor(s / 86_400), "day");
}
