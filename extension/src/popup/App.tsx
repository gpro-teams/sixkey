// The popup: which screen to show, and nothing else. Each screen lives in its own module.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createPopupRuntime } from "../platform/runtime-base";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { t } from "../ui/i18n";
import { Frame } from "./chrome";
import { csbChanges, watchCsbChanges } from "./csb-changes";
import { loadScreen, screenOf, type Screen } from "./load";
import { Main } from "./main/Main";
import { SecurityNotice } from "./main/Notices";
import { ackNotice, afterFirstCode, readNotice, type SecNotice } from "./notice";
import { startPageDelay } from "./page-delay";
import type { UnlockInfo } from "./screens/Locked";
import { surface } from "./surface";

// The in-page suggestion's release gate (scripts/suggest-ui.mjs, the build's define): a constant of this module, folded by
// the build. With it open, the input delay of a surface holding a page's fill request (page-delay.ts; AUTOFILL2 patch 4a)
// starts with this document; with it closed, the delay is not in the build.
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;
if (SUGGEST_UI) startPageDelay();

// The backup in Chrome sync's records' changes, counted from the start, before any read of them (./csb-changes.ts).
watchCsbChanges();

/** Every screen but the list (./screens/late.ts): loaded when one is needed, so they are not in the popup's counted bundle. */
const late = () => import("./screens/late");

export function Late({
  rt,
  screen,
  reload,
  onUnlocked,
}: {
  rt: ReturnType<typeof createPopupRuntime>;
  screen: Screen;
  reload: () => Promise<void>;
  onUnlocked: (info?: UnlockInfo) => Promise<void>;
}) {
  const [m, setM] = useState<Awaited<ReturnType<typeof late>>>();
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  // a chunk that cannot be loaded (a damaged install) must not leave a locked vault looking like an empty app: say so, with
  // the page's own words (the counted catalog), and offer another try
  useEffect(() => {
    setFailed(false);
    late().then(setM, () => setFailed(true));
  }, [tries]);
  if (failed)
    return (
      <Frame>
        <div class="center" id="late-failed">
          <h1 class="prompt">{t("errorTitle")}</h1>
          <div class="stack">
            <button class="btn" onClick={() => setTries(tries + 1)}>
              {t("retry")}
            </button>
          </div>
        </div>
      </Frame>
    );
  if (!m) return <Frame>{null}</Frame>;
  if (screen.k === "locked")
    return (
      <m.Locked
        rt={rt}
        {...(screen.format ? { format: screen.format } : {})}
        {...(screen.device ? { device: screen.device } : {})}
        onUnlocked={onUnlocked}
      />
    );
  return (
    <Frame>
      {screen.k === "welcome" ? (
        <m.Welcome rt={rt} reload={reload} />
      ) : screen.k === "lost" ? (
        <m.Lost />
      ) : screen.k === "newer" ? (
        <m.Newer />
      ) : screen.k === "error" ? (
        <m.ErrorScreen code={screen.code} onRetry={reload} />
      ) : null}
    </Frame>
  );
}

export function App() {
  const rt = useMemo(() => createPopupRuntime(), []);
  const [screen, setScreen] = useState<Screen>({ k: "loading" });
  // The pending fill request this popup's own unlock was made for (its lock screen showed the request's line with this
  // nonce when the secret was typed): the list may fill that page, once (AUTOFILL2 patch 1). Only `unlocked` sets it; a
  // load that does not end on the list (a lock) drops it, and no other load ever sets it (a following unlock does not).
  const [resume, setResume] = useState<string | null>(null);
  // the count of the backup's record changes when a load began (./csb-changes.ts): an unlock's view takes the one of the
  // load that showed the lock screen, which began before the unlock's read
  const mark = useRef(0);
  const reload = useCallback(async () => {
    mark.current = csbChanges();
    const next = await loadScreen(rt, mark.current);
    if (next.k !== "main") setResume(null);
    setScreen(next);
  }, [rt]);
  // The security record's notice (PHASE0X-PLAN C7, ./notice.ts): read by an unlock in this popup and by nothing else, once
  // the list it unlocked to shows its first code; acked once it has been on screen, with the number shown.
  const [notice, setNotice] = useState<SecNotice | null>(null);
  const asked = useRef(0); // the latest unlock: an earlier one's answer is dropped
  const acked = useRef<SecNotice | null>(null);
  // Opened with the PIN or the device unlock: the notice is shown, never acked (its count comes off only after the
  // master password).
  const viaPin = useRef(false);
  // An unlock returns the view, so nothing is loaded again (PHASE0X-PLAN A2). Without one (a reset), load as on opening.
  const unlocked = useCallback(
    async (info?: UnlockInfo) => {
      const ask = ++asked.current;
      setNotice(null);
      viaPin.current = info?.via !== undefined;
      if (!info?.view) return reload();
      setResume(info.req ?? null);
      setScreen(screenOf(info.view, mark.current));
      void afterFirstCode()
        .then(() => readNotice(rt))
        .then((n) => {
          if (asked.current === ask) setNotice(n);
        });
    },
    [reload, rt],
  );
  const shown = useCallback(() => {
    if (!notice || acked.current === notice || viaPin.current) return;
    acked.current = notice;
    void ackNotice(rt, notice);
  }, [rt, notice]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A lock from anywhere (Lock now in another page, the `lock` shortcut, the idle timer, the screen lock) bumps the lock
  // epoch: the list drops its vault and codes at once and shows the lock screen (QUICK-UNLOCK §5.12 item 3).
  const showing = useRef(screen.k);
  showing.current = screen.k;
  useEffect(() => {
    const area = chrome.storage?.session;
    const changed = (c: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in c && showing.current === "main") void reload();
    };
    area?.onChanged.addListener(changed);
    return () => area?.onChanged.removeListener(changed);
  }, [reload]);
  // The side panel follows changes made elsewhere and locks when idle (./surface.ts); nothing in the popup.
  useEffect(() => surface.panel?.attach(rt, reload, () => showing.current), [rt, reload]);

  // Every load that reaches the list (opening, and each reload after a change) counts as activity: it moves the idle
  // deadline, and the service worker re-arms its auto-lock timer. Fire and forget, once the list has rendered. In the side
  // panel only the user's own input counts as use (./surface.ts).
  useEffect(() => {
    if (screen.k !== "main") return;
    if (surface.panel) surface.panel.shown(rt);
    else
      void rt.service
        .touch()
        .then(() => chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }))
        .catch(() => undefined);
  }, [rt, screen]);

  switch (screen.k) {
    case "loading":
      return <Frame>{null}</Frame>;
    case "welcome":
    case "lost":
    case "newer":
    case "error":
    case "locked":
      return <Late rt={rt} screen={screen} reload={reload} onUnlocked={unlocked} />;
    case "main":
      return (
        <Main
          rt={rt}
          screen={screen}
          reload={reload}
          resume={resume}
          extra={notice && <SecurityNotice notice={notice} onShown={shown} />}
        />
      );
  }
}
