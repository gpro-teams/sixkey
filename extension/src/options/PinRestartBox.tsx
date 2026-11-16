// Settings › Security › PIN quick unlock's lazy part (OWNER-DECISIONS/20 and its 2026-10-30 notes; docs/design/notes/
// PIN-RESTART-NOTES.md §1, §18): what the PIN costs, in the owner's words (anyone with a copy of this browser profile can
// guess the PIN offline; a longer PIN is harder to guess), shown above the PIN's own form so that it is read before a PIN
// is set; and, when the PIN's record waits for the master password (5 wrong tries, "End quick unlock now") or a key event
// paused it, "Turn back on": with the PIN alone right after this page's own key event (a wrong one moves to the master
// password), else with the master password (src/core/service/pin-restart-admin.ts turnBackOn; the next master password on
// a lock screen does the same by itself). A lazy chunk, loaded by the PIN box when the PIN is available here (and by the
// inventory for its line), with its one line of text in a catalog of its own (src/ui/restart-text.ts) and every other
// word the device unlock's (src/ui/device-text.ts: "Turn back on", "That didn't work") or the settings page's own: a
// vault's page has room for no more (PIN-RESTART-NOTES.md §8). Closing the PIN box, a lock or a hidden tab drop what was
// typed (the PIN box unmounts it).
import { useEffect, useMemo, useState } from "preact/hooks";
import { RestartAdmin, type RestartView } from "../core/service/pin-restart-admin";
import { dx } from "../ui/device-text";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import { rx } from "../ui/restart-text";
import { MasterField } from "./MasterField";
import { errText, type Ctx } from "./shared";

/** Both catalogs it draws from are in (false: one could not be read, and nothing of it is drawn). */
const textReady = (): Promise<boolean> =>
  Promise.all([rx.loaded, dx.loaded]).then(() => rx.words() != null && dx.words() != null);

/**
 * What Sixkey keeps in this profile: the record's line (src/options/SecurityCard.tsx), what it costs, once the text is in;
 * null when it cannot be read, or when the vault is open here and the record is not Sixkey's own (RestartAdmin.state: it
 * is removed then; locked, a record stored is listed as it is).
 */
export async function inventoryLine(rt: Ctx["rt"]): Promise<string | null> {
  const view = await new RestartAdmin(rt.service).state().catch(() => null);
  if (view && !view.on) return null;
  return (await textReady()) ? rx("rsCost") : null;
}

export function PinRestartBox({ rt, changed }: { rt: Ctx["rt"]; changed: () => void }) {
  const admin = useMemo(() => new RestartAdmin(rt.service), [rt]);
  const [view, setView] = useState<RestartView | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinFailed, setPinFailed] = useState(false); // the PIN alone was refused: the master password from now on
  const refresh = () => admin.state().then(setView, () => setView(null));
  useEffect(() => {
    void refresh();
    void textReady().then(setReady);
  }, []);
  if (!ready) return null;
  const byPin = !!view?.byPin && !pinFailed;

  async function run(fn: () => Promise<void>, pinTry = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSecret("");
    } catch (e) {
      const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
      if (pinTry && code === "wrong_secret") {
        setPinFailed(true); // "That didn't work. Use your master password."
        setError(dx("dvFailed"));
      } else setError(code === "bad_pin" ? t("pinFormat") : errText(e));
    } finally {
      setBusy(false);
      await refresh();
      changed();
    }
  }

  const back = !!view?.on && view.state !== "pin"; // paused, or the master password once: "Turn back on"
  return (
    <div id="pin-restart">
      <p class="callout" id="pin-restart-cost">
        <Icon name="info" size={16} />
        <span>{rx("rsCost")}</span>
      </p>
      {back && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!secret || busy) return;
            const typed = secret;
            setSecret("");
            if (byPin) void run(() => admin.turnBackOn({ pin: typed }), true);
            else void run(() => admin.turnBackOn({ password: typed }));
          }}
        >
          {byPin ? (
            <div class="field">
              <label for="pin-restart-pin">{t("pinLabel")}</label>
              <input
                id="pin-restart-pin"
                type="password"
                inputMode="numeric"
                autocomplete="off"
                value={secret}
                onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
              />
            </div>
          ) : (
            <MasterField id="pin-restart-pw" label={t("passwordLabel")} value={secret} onValue={setSecret} rt={rt} />
          )}
          <div class="row2">
            <button id="pin-restart-go" class="btn" type="submit" disabled={busy || !secret}>
              {dx("dvTurnOn")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <div class="err" role="alert" id="pin-restart-error">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
    </div>
  );
}
