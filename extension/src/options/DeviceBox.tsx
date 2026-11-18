// Settings › Security › Unlock with Touch ID / Windows Hello (QUICK-UNLOCK §5.3, §5.6, §6.3; Stage 2): add this computer's
// sign-in, see what each one can do, turn one back on after a key change, remove one, and, with a gate and a PIN both set
// up, choose which reopens Sixkey after it locks. A lazy chunk with its own text (src/ui/device-text.ts), loaded by the
// Security leaf (Security.tsx), so the settings page's parts carry none of it. Enrolment runs here, in a tab, never in
// the popup (§0A.5 item 3).
//
// Every change asks for the master password again (core/service/device-admin.ts), typed once in the box's field; the
// choice of method asks for none, since it only ends what is armed. Locked, the box shows the list only. The labels say
// what each one protects and what it does not (quickOnPrf, quickOnPrfSynced, quickOnGate in QUICK-UNLOCK §6.5). The
// synced opt-in is off by default and shows its notice before it can be ticked (Q2); it is never offered in a profile
// declared shared. The box is one line until opened (shared.tsx Fold); closing it, a lock or a hidden tab drop the typed
// password.
import { useEffect, useMemo, useState } from "preact/hooks";
import { DeviceAdmin, type DeviceCred, type DeviceState, type Enrolment } from "../core/service/device-admin";
import { PRF_KEY } from "../core/service/prf-store";
import { quickChanged } from "../platform/session";
import { webauthn } from "../platform/webauthn";
import { deviceName, dx } from "../ui/device-text";
import { formatDate, t } from "../ui/i18n";
import { Icon } from "./icons";
import { MasterField } from "./MasterField";
import { errText, Fold, type Ctx } from "./shared";
import "./device-box.css";

const WHERE = {
  icloud: "dvWhereIcloud",
  google: "dvWhereGoogle",
  chrome: "dvWhereGoogle", // Chrome's own passkeys are listed in its password manager, with Google Password Manager's
  windows: "dvWhereWindows",
} as const;

/** What an enrolment or "turn back on" answered, in this box's words. */
function answer(r: Enrolment): { ok: boolean; text: string } {
  if (!r.ok)
    return {
      ok: false,
      text: dx(
        r.reason === "exists"
          ? "dvExists"
          : r.reason === "unsupported"
            ? "dvNone"
            : r.reason === "refused"
              ? "dvRefused"
              : "dvCancelled",
      ),
    };
  if (r.refused === "synced") return { ok: true, text: dx("dvSyncedRefused") };
  if (r.refused === "no_prf") return { ok: true, text: dx("dvNoPrf") };
  return { ok: true, text: dx("dvOn") }; // the list says what it can do
}

/** The honest line of one credential: what it opens, and what it does not stop. */
function rowLine(c: DeviceCred, shared: boolean, name: string): string {
  if (c.paused) return dx("dvPaused", name); // a PRF wrap or a gate's MAC under an older key: "turn back on"
  if (c.mode === "gate") return dx(shared ? "dvRowGateShared" : "dvRowGate", name);
  return dx(c.synced ? "dvRowPrfSynced" : "dvRowPrf");
}

export function DeviceBox({ rt, status, reload }: Ctx) {
  const admin = useMemo(() => new DeviceAdmin(rt.service, webauthn), [rt]);
  const [ready, setReady] = useState(dx.words() !== undefined);
  const [st, setSt] = useState<DeviceState | null>(null);
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const unlocked = status.state === "unlocked";
  const wipe = () => {
    setPw("");
    setOptIn(false);
  };

  const refresh = () => admin.state().then(setSt, () => setSt(null));
  useEffect(() => {
    if (!ready) void dx.loaded.then(() => setReady(true));
  }, []);
  useEffect(() => {
    void refresh();
  }, [status]);
  useEffect(() => {
    const changed = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if ((area === "session" && quickChanged(c)) || (area === "local" && PRF_KEY in c)) void refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== "hidden") return;
      wipe();
      setOpen(false);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => {
    if (!unlocked) {
      wipe();
      setOpen(false);
    }
  }, [unlocked]);

  if (!ready || dx.words() === null || !st || st.available === "no_vault" || st.available === "off") return null;
  const name = deviceName();
  if (st.available === "no_password")
    return (
      <div class="box" id="device-box">
        <p class="muted">{t("pinNeedsPassword")}</p>
      </div>
    );
  // nothing to show where there is no platform authenticator and nothing is enrolled (the PIN box is beside this one)
  if (!st.platform && !st.creds.length)
    return (
      <div class="box" id="device-box">
        <p class="muted" id="device-none">
          {dx("dvNone")}
        </p>
      </div>
    );

  async function run(fn: () => Promise<{ ok: boolean; text: string } | null>) {
    setBusy(true);
    setMsg(null);
    try {
      const m = await fn();
      if (m) setMsg(m);
      if (m?.ok) wipe();
    } catch (e) {
      const code = e instanceof Error ? (e as { message?: string }).message : "";
      setMsg({ ok: false, text: code === "device_full" ? dx("dvFull") : errText(e) });
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  const enrol = () =>
    void run(async () => {
      const r = await admin.enrol(pw, { name, allowSynced: optIn && !st.shared });
      // a gate armed now: the service worker sets its sk-quick-expiry alarm, as after any unlock
      if (r.ok) void chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }).catch(() => undefined);
      return answer(r);
    });
  const remove = (c: DeviceCred) =>
    void run(async () => {
      await admin.remove(pw, c.id);
      return { ok: true, text: dx("dvRemoved", dx(c.provider ? WHERE[c.provider] : "dvWhereUnknown")) };
    });
  const turnOn = (c: DeviceCred) =>
    void run(async () => {
      const r = await admin.reenable(pw, c.id);
      if (r.ok) void chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }).catch(() => undefined); // armed
      return answer(r);
    });
  // "Also after a restart" for a synced gate (OWNER-DECISIONS/17 Q4): the synced notice first, then one touch
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const alsoAfterRestart = (c: DeviceCred) =>
    void run(async () => {
      setUpgrading(null);
      return answer(await admin.alsoAfterRestart(pw, c.id));
    });
  const endQuick = () =>
    void run(async () => {
      await admin.endQuickUnlock();
      await reload(); // a hard lock: this page is locked now too
      return { ok: true, text: t("quickEnded") };
    });

  return (
    <Fold
      id="device-box"
      icon="shieldCheck"
      title={dx("dvUnlock", name)}
      open={open}
      onToggle={(on) => {
        wipe();
        setMsg(null);
        setOpen(on);
      }}
      note={
        <>
          {st.creds.length > 0 && (
            <ul class="dv-list" id="device-list">
              {st.creds.map((c) => (
                <li key={c.id} data-mode={c.mode} data-paused={c.paused ? "1" : undefined}>
                  <strong>{c.name}</strong>
                  {c.synced && <span class="dv-tag">{dx("dvSynced")}</span>}
                  <span class="muted"> · {formatDate(c.createdAt)}</span>
                  <p class="muted">{rowLine(c, st.shared, c.name)}</p>
                </li>
              ))}
            </ul>
          )}
          {st.due && <p class="muted">{dx("dvDue")}</p>}
          {/* the gate with no PIN beside it: "End quick unlock now" here too (the PIN box's words), locked as well */}
          {st.armed && !st.pin && !st.shared && (
            <div class="row2">
              <button id="device-quick-end" class="btn ghost" type="button" disabled={busy} onClick={endQuick}>
                {t("quickEndNow")}
              </button>
            </div>
          )}
          {!unlocked && (
            <p class="callout">
              <Icon name="lock" size={16} />
              <span>{t("unlockToManage")}</span>
            </p>
          )}
          {msg && (
            <div class={msg.ok ? "ok-msg" : "err"} role={msg.ok ? "status" : "alert"} id="device-msg">
              <Icon name={msg.ok ? "check" : "alert"} size={15} />
              {msg.text}
            </div>
          )}
        </>
      }
    >
      <p class="muted">{dx("dvLead", name)}</p>
      {unlocked && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pw && !busy && st.platform && !st.full) enrol();
          }}
        >
          <MasterField id="device-pw" label={t("passwordLabel")} value={pw} onValue={setPw} rt={rt} />
          {st.creds.length > 0 && (
            <ul class="dv-actions">
              {st.creds.map((c) => (
                <li key={c.id}>
                  <span>{c.name}</span>
                  {c.paused && (
                    <button
                      type="button"
                      class="btn sm ghost"
                      id={`device-on-${c.id}`}
                      disabled={busy || !pw}
                      onClick={() => turnOn(c)}
                    >
                      {dx("dvTurnOn")}
                    </button>
                  )}
                  {/* a synced gate made persistent in place (Q4): the notice is on screen before the touch */}
                  {c.mode === "gate" && c.synced && !c.paused && !st.shared && (
                    <button
                      type="button"
                      class="btn sm ghost"
                      id={`device-also-${c.id}`}
                      disabled={busy || !pw}
                      aria-expanded={upgrading === c.id}
                      onClick={() => setUpgrading(upgrading === c.id ? null : c.id)}
                    >
                      {dx("dvAlsoRestart")}
                    </button>
                  )}
                  <button
                    type="button"
                    class="btn sm ghost"
                    id={`device-remove-${c.id}`}
                    disabled={busy || !pw}
                    onClick={() => remove(c)}
                  >
                    {dx("dvRemove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {upgrading && !st.shared && (
            <div class="callout bad" id="device-also-notice">
              <Icon name="alert" size={16} />
              <span>{dx("dvOptInNotice", name)}</span>
              <div class="row2">
                <button
                  type="button"
                  class="btn sm"
                  id="device-also-go"
                  disabled={busy || !pw}
                  onClick={() => {
                    const c = st.creds.find((x) => x.id === upgrading);
                    if (c) alsoAfterRestart(c);
                  }}
                >
                  {dx("dvAdd", name)}
                </button>
                <button type="button" class="btn sm ghost" id="device-also-cancel" onClick={() => setUpgrading(null)}>
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}
          {st.platform && !st.full && (
            <>
              {/* the synced opt-in is never offered in a profile declared shared (a copy of it is likely) */}
              {!st.shared && (
                <label class="show" id="device-optin-label">
                  <input
                    type="checkbox"
                    id="device-optin"
                    checked={optIn}
                    aria-describedby="device-optin-notice"
                    onChange={(e) => setOptIn((e.target as HTMLInputElement).checked)}
                  />
                  {dx("dvOptIn")}
                </label>
              )}
              {/* the notice is on screen whenever the box is ticked: the choice is made with it in view (Q2) */}
              {optIn && !st.shared && (
                <p class="callout bad" id="device-optin-notice">
                  <Icon name="alert" size={16} />
                  <span>{dx("dvOptInNotice", name)}</span>
                </p>
              )}
              <p class="muted">{dx("dvPick")}</p>
              <div class="row2">
                <button id="device-add" class="btn" type="submit" disabled={busy || !pw}>
                  {dx("dvAdd", name)}
                </button>
              </div>
            </>
          )}
          {st.full && <p class="muted">{dx("dvFull")}</p>}
        </form>
      )}
      <p class="muted">{dx("dvNotWorking")}</p>
    </Fold>
  );
}

/**
 * Right after this page's own key change (Settings › Security › Password and recovery, Replace the key): what the change
 * paused, turned back on one at a time, one touch each, without the master password typed again (OWNER-DECISIONS/17 Q3;
 * device-admin.ts target(null): this page's key change, to this very key, in the last 10 minutes). Each credential has
 * its own button and its own answer (REVIEW-r2 G4). Nothing is drawn when nothing was paused. Everywhere else "turn
 * back on" asks for the master password.
 */
export function DeviceAfterKeyChange({ rt, onDone }: { rt: Ctx["rt"]; onDone: () => void }) {
  const admin = useMemo(() => new DeviceAdmin(rt.service, webauthn), [rt]);
  const [ready, setReady] = useState(dx.words() !== undefined);
  const [paused, setPaused] = useState<DeviceCred[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, { ok: boolean; text: string }>>({});
  useEffect(() => {
    if (!ready) void dx.loaded.then(() => setReady(true));
    void admin.state().then(
      (s) => setPaused(s.available === "ok" ? s.creds.filter((c) => c.paused) : []),
      () => setPaused([]),
    );
  }, []);
  if (!ready || !paused.length) return null;
  const turnOn = async (c: DeviceCred) => {
    setBusy(true);
    let m: { ok: boolean; text: string };
    try {
      m = answer(await admin.reenable(null, c.id));
      if (m.ok) void chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }).catch(() => undefined);
    } catch (e) {
      m = { ok: false, text: errText(e) };
    }
    setBusy(false);
    setDone((d) => ({ ...d, [c.id]: m }));
  };
  return (
    <div class="box" id="device-after-key">
      <p>{dx("dvKeyChanged", deviceName())}</p>
      <ul class="dv-actions">
        {paused.map((c) => (
          <li key={c.id} id={`device-after-${c.id}`}>
            <span>{c.name}</span>
            {done[c.id] ? (
              <span class={done[c.id]!.ok ? "ok-msg" : "err"} role={done[c.id]!.ok ? "status" : "alert"}>
                <Icon name={done[c.id]!.ok ? "check" : "alert"} size={15} />
                {done[c.id]!.text}
              </span>
            ) : (
              <button
                class="btn sm"
                type="button"
                id={`device-after-on-${c.id}`}
                disabled={busy}
                onClick={() => void turnOn(c)}
              >
                {dx("dvTurnOn")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div class="row2">
        <button class="btn ghost" type="button" id="device-after-later" disabled={busy} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
