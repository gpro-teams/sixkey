import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../../ui/icons";
import { t } from "../../ui/i18n";
import { openOptions } from "../chrome";
import { inputOf, pasteKey, type AddInput } from "./add-input";
import "./add.css";

// [id, title, description, icon]. Every option but "scan" continues on the settings page at #add-<id>.
const OPTIONS = [
  ["scan", "optScan", "optScanD", "scan"],
  ["upload", "optUpload", "optUploadD", "image"],
  ["manual", "optManual", "optManualD", "keyboard"],
  ["google", "optGoogle", "optGoogleD", "transfer"],
] as const;

/**
 * The "Add account" view (PHASE0X-PLAN B3): a paste zone at the top, focused, that takes a link, a key or a QR
 * screenshot (pasted or dropped; typed text goes on with Enter), then the other ways to add. Nothing pasted is ever
 * shown in the zone: it goes straight to the confirm page.
 */
export function AddMenu({
  onBack,
  onScan,
  onInput,
}: {
  onBack: () => void;
  onScan: () => Promise<void>;
  onInput: (input: AddInput) => void;
}) {
  const [typed, setTyped] = useState("");
  const [over, setOver] = useState(false);
  const zone = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => zone.current?.focus(), []);
  const take = (dt: DataTransfer | null) => {
    const input = inputOf(dt);
    if (input) onInput(input);
  };
  return (
    <>
      <div class="ph">
        <button class="tb back" onClick={onBack}>
          <Icon name="back" />
          {t("back")}
        </button>
        <span class="title">{t("addTitle")}</span>
        <span class="sp" />
      </div>
      <div class="opts">
        <div class={`pz${over ? " over" : ""}`}>
          <Icon name="clipboard" size={18} />
          <textarea
            id="pa-box"
            ref={zone}
            rows={2}
            spellcheck={false}
            autocomplete="off"
            aria-label={t("paZone")}
            aria-describedby="pa-help"
            placeholder={t("paZone")}
            value={typed}
            onInput={(e) => setTyped((e.target as HTMLTextAreaElement).value)}
            onPaste={(e) => {
              e.preventDefault();
              take(e.clipboardData);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              take(e.dataTransfer);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && typed.trim()) {
                e.preventDefault();
                onInput({ text: typed });
              }
            }}
          />
          {typed.trim() ? (
            <button class="btn sm" onClick={() => onInput({ text: typed })}>
              {t("continue")}
            </button>
          ) : (
            <kbd>{pasteKey()}</kbd>
          )}
        </div>
        <p class="pz-help" id="pa-help">
          {t("paZoneHelp")}
        </p>
        {OPTIONS.map(([id, a, b, icon], i) => (
          <button
            key={id}
            class={`opt${i === 0 ? " primary" : ""}`}
            style={`--n:${i}`}
            onClick={() => (id === "scan" ? void onScan() : openOptions(`#add-${id}`))}
          >
            <span class="oi">
              <Icon name={icon} size={18} />
            </span>
            <span class="ot">
              <b>{t(a)}</b>
              <small>{t(b)}</small>
            </span>
            <Icon name="next" class="chev" />
          </button>
        ))}
      </div>
      <p class="opts-foot">
        <Icon name="shield" size={14} />
        <span>{t("addPrivacy")}</span>
      </p>
    </>
  );
}
