// The screens that only report a state: data unreadable, data from a newer version, an error while opening.
// App renders each inside Frame.
import { useEffect } from "preact/hooks";
import { VaultDial } from "../../ui/art";
import { describeError, logError, sectionOf } from "../../ui/errors";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { openOptions } from "../chrome";

export function Lost() {
  return (
    <div class="center">
      <div class="hero">
        <VaultDial size={108} class="broken" />
      </div>
      <h1 class="prompt">{t("lostTitle")}</h1>
      <p>{t("lostBody")}</p>
      <div class="stack">
        <button class="btn" onClick={() => openOptions("#backup")}>
          <Icon name="upload" />
          {t("lostRestore")}
        </button>
      </div>
    </div>
  );
}

export function Newer() {
  return (
    <div class="center">
      <div class="hero">
        <span class="hero-ic">
          <Icon name="download" size={26} />
        </span>
      </div>
      <h1 class="prompt">{t("newerTitle")}</h1>
      <p>{t("newerBody")}</p>
    </div>
  );
}

/**
 * The popup could not open. `code` is the error's code or class name (from load.ts): it picks the text and goes to the
 * diagnostics log, and is never shown (PHASE0X-PLAN C8). Retry, and where the text points to a settings section, a way there.
 */
export function ErrorScreen({ code, onRetry }: { code: string; onRetry: () => Promise<void> }) {
  const { what, next } = describeError(code);
  const section = sectionOf(code);
  useEffect(() => logError("popup could not open", code), [code]);
  return (
    <div class="center">
      <div class="hero">
        <span class="hero-ic bad">
          <Icon name="alert" size={26} />
        </span>
      </div>
      <h1 class="prompt">{what}</h1>
      <p>{next}</p>
      <div class="stack">
        <button class="btn" onClick={() => void onRetry()}>
          {t("retry")}
        </button>
        {section && (
          <button class="btn ghost" onClick={() => openOptions(`#${section}`)}>
            <Icon name="sliders" />
            {t("settings")}
          </button>
        )}
      </div>
    </div>
  );
}
