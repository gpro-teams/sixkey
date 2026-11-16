import { useEffect, useState } from "preact/hooks";
import type { PopupRuntime } from "../../platform/runtime-base";
import { VaultDial } from "../../ui/art";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { openOptions } from "../chrome";

/** A copy of the backup in Chrome sync, offered first (./CsbFound.tsx): its own chunk, loaded by the welcome only. */
const csbFound = () => import("./CsbFound");

/**
 * No vault yet: what Sixkey is, and the ways to start. App renders it inside Frame. Every way opens the settings page,
 * where the first run asks for the master password before anything is written (H1). Not here: the popup closes as soon
 * as focus leaves it, for example to save the password or the recovery code, and would lose what was not saved yet.
 * With a copy of the backup in Chrome sync found, its restore comes first ("从 Chrome 同步恢复", #setup-csb) and "start"
 * is not the main button any more. The props are App's; nothing here needs them any more.
 */
export function Welcome(_: { rt: PopupRuntime; reload: () => Promise<void> }) {
  const [m, setM] = useState<Awaited<ReturnType<typeof csbFound>> | null>(null);
  const [found, setFound] = useState(false);
  useEffect(() => {
    void csbFound().then(
      (x) => setM(() => x),
      () => undefined, // a chunk that cannot be loaded: the welcome as it was
    );
  }, []);
  return (
    <div class="center welcome">
      <div class="hero">
        <VaultDial size={124} class="idle" />
      </div>
      <h1 class="prompt">{t("welcomeTitle")}</h1>
      <p>{t("welcomeBody")}</p>
      <ul class="trust">
        <li>
          <Icon name="device" />
          <span>{t("trustLocal")}</span>
        </li>
        <li>
          <Icon name="shield" />
          <span>{t("trustNoTrack")}</span>
        </li>
        <li>
          <Icon name="key" />
          <span>{t("trustPerms")}</span>
        </li>
      </ul>
      <div class="stack">
        {m && <m.CsbFound onFound={setFound} />}
        <button class={found ? "btn ghost" : "btn"} id="start-secure" onClick={() => openOptions("#setup")}>
          <Icon name="shieldCheck" />
          {t("welcomeStartSecure")}
        </button>
        <button class="btn ghost" id="start-restore" onClick={() => openOptions("#setup-restore")}>
          <Icon name="upload" />
          {t("welcomeRestore")}
        </button>
      </div>
    </div>
  );
}
