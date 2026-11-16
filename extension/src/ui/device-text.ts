// The device unlock's text (Touch ID / Windows Hello; docs/design/notes/PRF-NOTES.md): a catalog of its own,
// catalogs/device-<lang>.json (scripts/messages.py, the fragment scripts/i18n/device.py's DEVICE_EN / DEVICE_ZH), loaded
// with the device unlock's lazy chunks (src/ui/DeviceUnlock.tsx: the lock screen's button in the popup, the side panel and
// the settings page's unlock bar; src/options/DeviceBox.tsx) and counted in no page's up-front budget. The lookup is
// lazy-text.ts's: until the text is in, or when neither language's can be read, the device unlock draws nothing of its own.
import { lazyText } from "./lazy-text";

/** One literal import per language, so each is its own chunk (assets/device-locale-<lang>-*.js); only `.default`. */
export const dx = lazyText(
  async (lang) =>
    lang === "zh_CN"
      ? (await import("../../catalogs/device-zh_CN.json")).default
      : (await import("../../catalogs/device-en.json")).default,
  true,
);

/** The platform, for the words and for where the ceremony runs, never for what a credential can do (PRF-NOTES.md). */
function platform(): string {
  const n = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return n?.userAgentData?.platform || n?.platform || "";
}
export const onMac = (): boolean => /^mac/i.test(platform());
export const onWindows = (): boolean => /^win/i.test(platform());

/** The name of this computer's sign-in, by the platform: "Touch ID", "Windows Hello", or "this computer's sign-in". */
export const deviceName = (): string => dx(onMac() ? "dvNameMac" : onWindows() ? "dvNameWin" : "dvNameOther");
