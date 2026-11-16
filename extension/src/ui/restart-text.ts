// The PIN's record's settings-page text (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/PIN-RESTART-NOTES.md
// §8, §18): a catalog of its own, catalogs/restart-<lang>.json (scripts/messages.py, the fragment scripts/i18n/pinrestart.py's
// RESTART_EN / RESTART_ZH): what the PIN costs, above the PIN's form in Settings › Security › PIN quick unlock
// (src/options/PinRestartBox.tsx) and in what Sixkey keeps in this profile. Loaded with that lazy chunk and counted in no
// page's up-front budget; one of the lazy catalogs a vault's page can hold together. The lookup is lazy-text.ts's: until
// the text is in, or when neither language's can be read, nothing of it is drawn. The lock screens have no text of the
// record's own (their one line, lockPinWaiting, is the settings unlock catalog's and the popup's).
import { lazyText } from "./lazy-text";

/** One literal import per language, so each is its own chunk (assets/restart-locale-<lang>-*.js); only `.default`. */
export const rx = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/restart-zh_CN.json")).default
      : (await import("../../catalogs/restart-en.json")).default,
  true,
);
