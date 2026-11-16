// "Scan with camera" on Settings > Add account (docs/design/notes/IMPORT-FILE-NOTES.md §4). The settings tab only: the
// toolbar popup gets no camera prompt. Each code read is handed to the page (`onLine`), which keeps the codes as a row of
// their own, like a file's, never in the paste box: a Google Authenticator export is put together with the rest of the
// import, and its preview says which codes are still needed. The camera stops on every way out (platform/camera.ts),
// and no frame is kept.
import { useEffect, useRef, useState } from "preact/hooks";
import { EMPTY_SCAN, scanProgress, seedScan, takeScan, type ScanState } from "../core/import/scan-batch";
import { decodeAllQrFromBitmap } from "../lib/qr";
import { CameraScan, stopWhenAway, type CameraError, type StreamLike } from "../platform/camera";
import { t } from "../ui/i18n";
import { Icon } from "./icons";

/** The longest side of a frame handed to the QR reader: enough for a phone's code held up to the camera. */
const FRAME_SIDE = 960;

export function AddCamera({
  enabled,
  boxText,
  onLine,
  onChoose,
}: {
  enabled: boolean;
  /** the paste box's text and the codes read so far: the codes of an export already there count as read */
  boxText: () => string;
  onLine: (line: string) => void;
  /** "choose a screenshot instead": opens the file picker */
  onChoose: () => void;
}) {
  const [on, setOn] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<CameraError | null>(null);
  const [note, setNote] = useState<"other" | "notOtp" | null>(null);
  const [scan, setScan] = useState<ScanState>(EMPTY_SCAN);
  const video = useRef<HTMLVideoElement>(null);
  const state = useRef<ScanState>(EMPTY_SCAN);
  const cam = useRef<CameraScan | null>(null);

  if (!cam.current)
    cam.current = new CameraScan(
      {
        getUserMedia: (c) => {
          const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
          return md?.getUserMedia ? md.getUserMedia(c) : Promise.reject(new Error("no camera"));
        },
        show: async (s: StreamLike | null) => {
          const v = video.current;
          if (!v) throw new Error("no preview");
          v.srcObject = s as MediaStream | null;
          if (s) await v.play();
        },
        grab: async () => {
          const v = video.current;
          if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
          const k = Math.min(1, FRAME_SIDE / Math.max(v.videoWidth, v.videoHeight));
          const bitmap = await createImageBitmap(v, {
            resizeWidth: Math.max(1, Math.round(v.videoWidth * k)),
            resizeHeight: Math.max(1, Math.round(v.videoHeight * k)),
            resizeQuality: "low",
          });
          try {
            return await decodeAllQrFromBitmap(bitmap);
          } finally {
            bitmap.close(); // the frame is gone once read
          }
        },
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      {
        onCodes: (texts) => {
          let over = false;
          for (const text of texts) {
            const { state: next, event } = takeScan(state.current, text);
            state.current = next;
            if (event.k === "link") {
              onLine(event.text);
              // one code is the whole scan, unless an export is being collected: then it is taken and the scan goes on
              if (next.batchId === null) over = true;
            } else if (event.k === "part") {
              onLine(text.trim());
              setNote(null);
            } else if (event.k === "done") {
              onLine(text.trim());
              over = true;
            } else if (event.k === "other_batch") setNote("other");
            else if (event.k === "not_otp") setNote("notOtp");
          }
          setScan(state.current);
          return over;
        },
        onError: (e) => {
          setError(e);
          setOn(false);
        },
        onLive: (l) => {
          setLive(l);
          if (!l) setOn(false);
        },
      },
    );

  // Started once the preview is on the page; stopped when it leaves (Cancel, a code found, unmount), the tab is hidden,
  // the page is left, or Sixkey locks anywhere.
  useEffect(() => {
    if (!on) return;
    const c = cam.current!;
    const unwatch = stopWhenAway(() => c.stop(), { doc: document, win: window });
    void c.start();
    return () => {
      unwatch();
      c.stop();
    };
  }, [on]);
  useEffect(() => {
    if (!enabled) setOn(false);
  }, [enabled]);

  const start = () => {
    setError(null);
    setNote(null);
    state.current = seedScan(boxText());
    setScan(state.current);
    setOn(true);
  };
  const p = scanProgress(scan);

  return (
    <div class="cam" id="add-camera">
      {!on ? (
        <button type="button" class="btn ghost sm" id="cam-start" disabled={!enabled} onClick={start}>
          <Icon name="scan" size={15} />
          {t("camStart")}
        </button>
      ) : (
        <div class="cam-live" id="cam-live">
          <video ref={video} class={live ? "on" : ""} muted playsInline autoplay aria-hidden="true" />
          <div class="cam-side">
            <p class="pv-line muted" role="status">
              <Icon name="scan" size={14} />
              {scan.batchId !== null ? t("previewIncomplete", p.received, p.size, p.missing.join(", ")) : t("camHint")}
            </p>
            {note && (
              <p class="pv-line err" id="cam-note">
                <Icon name="alert" size={14} />
                {note === "other" ? t("camOther") : t("camNotOtp")}
              </p>
            )}
            <button type="button" class="btn ghost sm" id="cam-stop" onClick={() => setOn(false)}>
              {t("camStop")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div class="cam-err err" role="alert" id="cam-error">
          <Icon name="alert" size={15} />
          <span>{error === "denied" ? t("camDenied") : t("camFailed")}</span>
          <button type="button" class="btn ghost sm" id="cam-file" onClick={onChoose}>
            <Icon name="image" size={15} />
            {t("chooseImages")}
          </button>
        </div>
      )}
    </div>
  );
}
