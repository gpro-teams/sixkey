// The popup's window chrome: the header bar of every screen but the list (which has its own toolbar), the brand, the
// language switch, the install-source banner, and the way out to the settings page.
import { useEffect, useState } from "preact/hooks";
import { checkInstallSource, lastInstallProblem } from "../platform/install-source";
import { Mark } from "../ui/art";
import { Icon } from "../ui/icons";
import { getLang, setLangChoice, t } from "../ui/i18n";
import { surface } from "./surface";

/** Open the settings page in a tab, at a section if given, and close the popup (the side panel stays open). */
export const openOptions = (hash = "") => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("options/index.html") + hash });
  if (!surface.panel) window.close();
};

/** One-tap switch between English and Chinese; shows the language it will switch to. */
export function LangToggle() {
  const zh = getLang() === "zh_CN";
  return (
    <button
      class="tb lang"
      id="lang-toggle"
      aria-label={t("languageLabel")}
      title={t("languageLabel")}
      onClick={() => {
        setLangChoice(zh ? "en" : "zh_CN");
        location.reload();
      }}
    >
      {zh ? "EN" : "中文"}
    </button>
  );
}

export function Brand() {
  return (
    <span class="brand">
      <Mark size={26} />
      <b>Sixkey</b>
    </span>
  );
}

/**
 * "Not installed from the Chrome Web Store" (H4), when this copy was loaded unpacked, sideloaded, or has an ID other
 * than the store's. It stays: there is nothing to dismiss, the copy really does not update itself. The full text and
 * the ID are on the settings page. role="status", never "alert" (tests count alerts).
 */
export function InstallBanner() {
  const [problem, setProblem] = useState(lastInstallProblem);
  useEffect(() => {
    let live = true;
    void checkInstallSource().then((p) => live && setProblem(p));
    return () => {
      live = false;
    };
  }, []);
  if (!problem) return null;
  return (
    <div class="note warn" id="install-banner" role="status">
      <span class="ni">
        <Icon name="alert" />
      </span>
      <span class="nt">
        <b>{t("instTitle")}</b>
        <span>{t("instBody")}</span>
      </span>
      <button class="btn sm ghost" onClick={() => openOptions("#install")}>
        {t("instDetails")}
      </button>
    </div>
  );
}

/** `banner`: under the header, a notice about the whole extension; the install-source banner unless a screen says otherwise. */
export function Frame({
  children,
  banner = <InstallBanner />,
}: {
  children: preact.ComponentChildren;
  banner?: preact.ComponentChildren;
}) {
  return (
    <>
      <div class="ph">
        <Brand />
        <span class="sp" />
        <LangToggle />
      </div>
      {banner}
      {children}
    </>
  );
}
