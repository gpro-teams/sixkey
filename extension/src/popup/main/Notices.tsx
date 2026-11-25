import { useEffect } from "preact/hooks";
import type { StorageEvent } from "../../core/storage/format";
import { Icon } from "../../ui/icons";
import { formatDateTime, t } from "../../ui/i18n";
import { InstallBanner, openOptions } from "../chrome";
import type { SecNotice } from "../notice";

/**
 * The notices above the list: "data restored" (one at a time, until acknowledged), "no master password yet", and
 * "not installed from the Chrome Web Store" (C3; Main has no Frame, so it is drawn here). `extra` is a slot after them
 * for later notices (PHASE0X-PLAN C7); they use role="status", never "alert".
 */
export function Notices({
  events,
  onAck,
  noPassword,
  extra,
}: {
  events: StorageEvent[];
  onAck: (ev: StorageEvent) => Promise<void>;
  noPassword: boolean;
  extra?: preact.ComponentChildren;
}) {
  return (
    <>
      {events.slice(0, 1).map((ev) => (
        <div class="note good" key={ev.id} role="alert">
          <span class="ni">
            <Icon name="restore" />
          </span>
          <span class="nt">
            <b>{t("recoveredTitle")}</b>
            <span>{t("recoveredBody", formatDateTime(ev.restoredTo))}</span>
          </span>
          <button class="btn sm ghost" onClick={() => onAck(ev)}>
            {t("gotIt")}
          </button>
        </div>
      ))}
      {noPassword && (
        <div class="note warn">
          <span class="ni">
            <Icon name="shieldAlert" />
          </span>
          <span class="nt">
            <span>{t("noPasswordNotice")}</span>
          </span>
          <button class="btn sm ghost" onClick={() => openOptions("#security")}>
            {t("setPassword")}
          </button>
        </div>
      )}
      <InstallBanner />
      {extra}
    </>
  );
}

/**
 * The security record's line after an unlock (PHASE0X-PLAN C7; what and when: ../notice.ts). role="status", its own
 * element, never the "data restored" banner. `onShown` runs once it is on screen (an effect runs after the paint); App
 * acks from there, once per unlock, however often the list view comes and goes.
 */
export function SecurityNotice({ notice, onShown }: { notice: SecNotice; onShown: () => void }) {
  useEffect(() => {
    onShown();
  }, []);
  return (
    <div class="note warn" id="sec-notice" role="status">
      <span class="ni">
        <Icon name="shieldAlert" />
      </span>
      <span class="nt" id="sec-notice-t">
        {"failed" in notice ? t("secNoticeFailed", notice.failed) : t("secNoticeBad")}
      </span>
      <button class="btn sm ghost" aria-describedby="sec-notice-t" onClick={() => openOptions("#security-log")}>
        {t("instDetails")}
      </button>
    </div>
  );
}
