// "Not installed from the Chrome Web Store" (H4) at the top of the settings page: one line (what it is, and a Details
// toggle), and under the toggle what it means, this copy's ID to compare, the store's ID once there is one, and what the
// check cannot do. It is not dismissed and not hidden for good: every opening of the page shows the line. The popup's
// banner links here (#install), which opens the details. The line is a native <details>, so it works from the keyboard.
import { useEffect, useState } from "preact/hooks";
import { checkInstallSource, lastInstallProblem, storeId } from "../platform/install-source";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import "./install.css";

const atNotice = () => location.hash === "#install";

export function InstallNotice() {
  const [problem, setProblem] = useState(lastInstallProblem);
  const [open, setOpen] = useState(atNotice);
  useEffect(() => {
    let live = true;
    void checkInstallSource().then((p) => live && setProblem(p));
    const onHash = () => atNotice() && setOpen(true);
    addEventListener("hashchange", onHash);
    return () => {
      live = false;
      removeEventListener("hashchange", onHash);
    };
  }, []);
  if (!problem) return null;
  const store = storeId();
  return (
    <div class="inst" id="install" role="status">
      <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <Icon name="alert" size={16} />
          <b>{t("instTitle")}</b>
          <span class="inst-toggle">
            {t("instDetails")}
            <Icon name="next" size={13} />
          </span>
        </summary>
        <div class="inst-body">
          <p>{t("instLong")}</p>
          <dl class="inst-ids">
            <dt>{t("instThisId")}</dt>
            <dd class="mono" id="install-id">
              {chrome.runtime.id}
            </dd>
            {store && <dt>{t("instStoreId")}</dt>}
            {store && (
              <dd class="mono" id="install-store-id">
                {store}
              </dd>
            )}
          </dl>
          {!store && <p>{t("instNoStoreYet")}</p>}
          <p class="muted">{t("instLimit")}</p>
        </div>
      </details>
    </div>
  );
}
