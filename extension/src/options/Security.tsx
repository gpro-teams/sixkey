import { useEffect, useRef, useState } from "preact/hooks";
import { logError } from "../ui/errors";
import { t } from "../ui/i18n";
import { masterAccepts, type Strength } from "../ui/strength";
import { Icon } from "./icons";
import type { KeyOps } from "./key-ops";
import { MasterField } from "./MasterField";
import { PinBox } from "./PinBox";
import { SecurityCard } from "./SecurityCard";
import { SecurityMode } from "./SecurityMode";
import { BoxTitle, Fold, Panel, PasswordFields, type Ctx } from "./shared";

// Settings › Security is three leaves (route.ts): how it locks (this file's Security: the two modes, the lock settings,
// the PIN), the master password and the recovery code (SecurityKeys), and the record of what happened (SecurityRecord).
// The operations that change the master password or the keys, and the recovery code a new one shows, are not here: the
// page holds them (key-ops.ts, App.tsx), so that leaving these leaves mid-way loses neither the code nor the outcome. What is
// here is what is typed: each form is a component of its own that holds its fields, so that closing it (its button,
// Escape, another opening, a lock, a hidden tab, leaving the leaf) unmounts it, and the typed passwords go with it, as a
// lock drops them everywhere on this page.
// `syncOn` (the Sync section's rail line says sync is on): the key changes go through sync (Phase 0's are refused with
// sync on, §0.0i item 18), so the three boxes give way to one that points to the Sync section, where they are. null:
// not known yet (this profile has sync records and the section is still loading): neither is shown until it is.
type Props = Ctx & { keys: KeyOps };

/** A Phase 0 device-key vault: the box that turns a master password on. Its steps, and its fields, are its own. */
function EnableBox({ vault, keys }: { vault: Ctx["vault"]; keys: KeyOps }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const canSubmit = !keys.busy && pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
  return (
    <div class="box">
      <BoxTitle icon="shieldAlert">{t("deviceOnlyTitle")}</BoxTitle>
      <p>{t("deviceOnlyBody")}</p>
      {vault && vault.entries.some((e) => e.secret !== "") && (
        <p class="callout bad" id="residue-warning">
          <Icon name="alert" size={16} />
          <span>{t("residueWarning")}</span>
        </p>
      )}
      <p class="callout">
        <Icon name="info" size={16} />
        <span>{t("passwordLossWarning")}</span>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void keys.enable(pw, anyway === pw).then((ok) => {
            if (ok) {
              setPw("");
              setPw2("");
            }
          });
        }}
      >
        <PasswordFields
          idPrefix="enable"
          value={pw}
          confirm={pw2}
          onValue={setPw}
          onConfirm={setPw2}
          onStrength={setStrength}
          anyway={{ value: anyway, set: setAnyway }}
        />
        {pw && pw2 && pw !== pw2 && (
          <div class="err">
            <Icon name="alert" size={15} />
            {t("passwordsDiffer")}
          </div>
        )}
        {keys.error && (
          <div class="err" role="alert">
            <Icon name="alert" size={15} />
            {keys.error}
          </div>
        )}
        <div class="row2">
          <button id="enable-password" class="btn" type="submit" disabled={!canSubmit}>
            <Icon name="shieldCheck" size={16} />
            {t("enablePassword")}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The two steps of turning a master password on, while the vault has none (or its code is on screen). */
function Steps({ codePending }: { codePending: boolean }) {
  return (
    <ol class="steps" aria-hidden="true">
      <li class={codePending ? "done" : "on"}>
        <i>{codePending ? <Icon name="check" size={13} /> : "1"}</i>
        <span>{t("stepPassword")}</span>
      </li>
      <li class={codePending ? "on" : ""}>
        <i>2</i>
        <span>{t("stepRecovery")}</span>
      </li>
    </ol>
  );
}

/**
 * The last operation's refusal, at the top of Password & recovery whatever fold is open. Brought into view when it comes:
 * in a narrow window the form that was sent reaches far below it.
 */
function Refusal({ error }: { error: string | null }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) line.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  return error ? (
    <div class="err" role="alert" ref={line}>
      <Icon name="alert" size={15} />
      {error}
    </div>
  ) : null;
}

/** Change the master password: the current one, a new one twice. Closing the fold unmounts this, and with it the fields. */
function ChangeForm({ keys, rt, onDone }: { keys: KeyOps; rt: Ctx["rt"]; onDone: () => void }) {
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [strength, setStrength] = useState<Strength | null>(null);
  const [anyway, setAnyway] = useState<string | null>(null); // "Use anyway" was pressed for this value
  const canSubmit =
    !keys.busy && old.length > 0 && pw.length > 0 && pw === pw2 && masterAccepts(strength, anyway === pw);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void keys.change(old, pw, anyway === pw).then((ok) => ok && onDone());
      }}
    >
      <MasterField id="old-pw" label={t("oldPasswordLabel")} value={old} onValue={setOld} rt={rt} />
      <PasswordFields
        idPrefix="change"
        value={pw}
        confirm={pw2}
        onValue={setPw}
        onConfirm={setPw2}
        onStrength={setStrength}
        anyway={{ value: anyway, set: setAnyway }}
      />
      <div class="row2">
        <button class="btn" type="submit" disabled={!canSubmit}>
          {t("changePassword")}
        </button>
      </div>
    </form>
  );
}

/** A new recovery code, or a new key (`kind`): each asks for the master password (H3, C6-1). */
function AskForm({
  kind,
  keys,
  rt,
  onDone,
}: {
  kind: "code" | "rotate";
  keys: KeyOps;
  rt: Ctx["rt"];
  onDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const go = () => void (kind === "code" ? keys.newCode(pw) : keys.rotate(pw)).then((ok) => ok && onDone());
  return (
    <>
      <p class="muted">{t(kind === "code" ? "newCodeBody" : "rotateBody")}</p>
      <p class="muted" id={`${kind}-shares-note`}>
        {t("sharesStopWarn")}
      </p>
      {kind === "code" ? (
        <MasterField id="code-pw" label={t("passwordLabel")} value={pw} onValue={setPw} rt={rt} />
      ) : (
        <MasterField id="rot-pw" label={t("passwordLabel")} value={pw} onValue={setPw} rt={rt} />
      )}
      <div class="row2">
        <button
          class="btn ghost"
          id={kind === "code" ? "new-code" : "rotate-key"}
          disabled={keys.busy || !pw}
          onClick={go}
        >
          {t(kind === "code" ? "newCodeAction" : "rotateAction")}
        </button>
      </div>
    </>
  );
}

/**
 * Recovery key shares (docs/design/notes/SHAMIR-NOTES.md §5): the wizard and its text are a lazy chunk, loaded when the
 * fold opens, so this leaf carries only the fold's title. Closing the fold unmounts it, and the wizard with it.
 */
const shareWizard = () => import("./ShareWizard");
function SharesFold({ keys, rt, check }: { keys: KeyOps; rt: Ctx["rt"]; check: boolean }) {
  const [Wizard, setWizard] = useState<Awaited<ReturnType<typeof shareWizard>>["ShareWizard"] | null>(null);
  useEffect(() => {
    let live = true;
    void shareWizard().then(
      (m) => live && setWizard(() => m.ShareWizard),
      (e) => logError("settings shares wizard", e),
    );
    return () => {
      live = false;
    };
  }, []);
  return Wizard ? <Wizard rt={rt} keys={keys} {...(check ? { start: "check" as const } : {})} /> : null;
}

/**
 * Touch ID / Windows Hello (QUICK-UNLOCK Stage 2; docs/design/notes/PRF-NOTES.md): the box and its text are a lazy chunk,
 * loaded with this leaf, so the settings page's parts carry none of it. It draws nothing until it is in.
 */
const deviceBox = () => import("./DeviceBox");
function DeviceFold(ctx: Ctx) {
  const [Box, setBox] = useState<Awaited<ReturnType<typeof deviceBox>>["DeviceBox"] | null>(null);
  useEffect(() => {
    let live = true;
    void deviceBox().then(
      (m) => live && setBox(() => m.DeviceBox),
      (e) => logError("settings device box", e),
    );
    return () => {
      live = false;
    };
  }, []);
  return Box ? <Box {...ctx} /> : null;
}

/**
 * Right after the key was replaced here: Touch ID / Windows Hello turned back on with one touch (OWNER-DECISIONS/17 Q3),
 * from the device box's lazy chunk; nothing is drawn while it loads, or when nothing was paused.
 */
function AfterKeyChange({ rt, onDone }: { rt: Ctx["rt"]; onDone: () => void }) {
  const [Box, setBox] = useState<Awaited<ReturnType<typeof deviceBox>>["DeviceAfterKeyChange"] | null>(null);
  useEffect(() => {
    let live = true;
    void deviceBox().then(
      (m) => live && setBox(() => m.DeviceAfterKeyChange),
      (e) => logError("settings device after key change", e),
    );
    return () => {
      live = false;
    };
  }, []);
  return Box ? <Box rt={rt} onDone={onDone} /> : null;
}

/** Settings › Security: how it locks. The two modes with the lock and codes settings, the PIN, Touch ID / Windows Hello. */
export function Security({ rt, status, vault, reload, keys }: Props) {
  const unlocked = status.state === "unlocked";
  const isProtected = status.state === "unlocked" && status.passwordProtected;
  return (
    <Panel id="security" icon="shield" title={t("secLockTab")} lead={t("secLead")}>
      {unlocked && !isProtected && (
        <>
          <Steps codePending={keys.code !== null} />
          {keys.code === null && <EnableBox vault={vault} keys={keys} />}
        </>
      )}
      {!unlocked && status.state === "locked" && (
        <p class="callout">
          <Icon name="lock" size={16} />
          <span>{t("unlockToManage")}</span>
        </p>
      )}
      <SecurityMode rt={rt} status={status} vault={vault} reload={reload} />
      {(status.state === "unlocked" || status.state === "locked") && (
        <PinBox rt={rt} status={status} vault={vault} reload={reload} />
      )}
      {(status.state === "unlocked" || status.state === "locked") && (
        <DeviceFold rt={rt} status={status} vault={vault} reload={reload} />
      )}
    </Panel>
  );
}

// The address asks for the shares fold (the popup's reminder opens #shares); no address in a document without one.
const atShares = () => globalThis.location?.hash === "#shares";

/** Settings › Security › Password and recovery: the master password, a new recovery code, a new key. */
export function SecurityKeys({ rt, status, vault, reload, keys, syncOn = false }: Props & { syncOn?: boolean | null }) {
  const unlocked = status.state === "unlocked";
  const isProtected = status.state === "unlocked" && status.passwordProtected;
  // One form open at a time. Its fields are its own: closing it unmounts them.
  // #shares (the popup's reminder): the shares fold, at "Check my shares"; on opening and whenever the address says so
  const [fold, setFold] = useState<"change" | "code" | "rotate" | "shares" | null>(() =>
    atShares() ? "shares" : null,
  );
  const [checkFirst, setCheckFirst] = useState(atShares);
  // the address's ask, until the fold has been open with the vault unlocked: a page opened from the reminder while
  // Sixkey is locked (locking every time) opens the fold at the unlock that follows
  const wantShares = useRef(atShares());
  useEffect(() => {
    const onHash = () => {
      if (!atShares()) return;
      wantShares.current = true;
      setCheckFirst(true);
      setFold("shares");
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const opens = (k: "change" | "code" | "rotate" | "shares") => (on: boolean) => {
    keys.clear();
    wantShares.current = false;
    setCheckFirst(false);
    setFold(on ? k : null);
  };
  // a lock, or a hidden tab: nothing typed waits for whoever sits down next
  useEffect(() => {
    if (!unlocked) setFold(null);
    else if (wantShares.current) {
      setCheckFirst(true);
      setFold("shares");
    }
  }, [unlocked]);
  useEffect(() => {
    if (unlocked && fold === "shares") wantShares.current = false; // answered
  }, [unlocked, fold]);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") setFold(null);
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  return (
    <Panel id="security-keys" icon="key" title={t("secKeysTab")}>
      {unlocked && !isProtected && (
        <>
          <Steps codePending={keys.code !== null} />
          {keys.code === null && <EnableBox vault={vault} keys={keys} />}
        </>
      )}
      {isProtected && keys.code === null && syncOn === true && (
        <div class="box" id="sec-keys-in-sync">
          <BoxTitle icon="key">{t("secKeysInSyncTitle")}</BoxTitle>
          <p class="muted">{t("secKeysInSyncBody")}</p>
          <div class="row2">
            <a class="btn ghost" href="#sync" id="sec-keys-in-sync-open">
              {t("secKeysInSyncOpen")}
            </a>
          </div>
        </div>
      )}
      {isProtected && keys.code === null && syncOn === false && (
        <>
          {/* the last operation's refusal stays here, whatever fold is open or closed, until the next attempt (or a fold opens) */}
          <Refusal error={keys.error} />
          {keys.rotated && <AfterKeyChange rt={rt} onDone={keys.clear} />}
          <Fold
            id="fold-change"
            icon="lock"
            title={t("changePasswordTitle")}
            open={fold === "change"}
            onToggle={opens("change")}
            note={
              keys.info && (
                <div class="ok-msg" role="status">
                  <Icon name="check" size={15} />
                  {keys.info}
                </div>
              )
            }
          >
            <ChangeForm keys={keys} rt={rt} onDone={() => setFold(null)} />
          </Fold>
          <Fold id="fold-code" icon="key" title={t("newCodeTitle")} open={fold === "code"} onToggle={opens("code")}>
            <AskForm kind="code" keys={keys} rt={rt} onDone={() => setFold(null)} />
          </Fold>
          <Fold
            id="fold-rotate"
            icon="restore"
            title={t("rotateTitle")}
            open={fold === "rotate"}
            onToggle={opens("rotate")}
          >
            <AskForm kind="rotate" keys={keys} rt={rt} onDone={() => setFold(null)} />
          </Fold>
          <Fold
            id="fold-shares"
            icon="key"
            title={t("sharesFoldTitle")}
            open={fold === "shares"}
            onToggle={opens("shares")}
          >
            <SharesFold keys={keys} rt={rt} check={checkFirst} />
          </Fold>
        </>
      )}
      {!unlocked && status.state === "locked" && (
        <p class="callout">
          <Icon name="lock" size={16} />
          <span>{t("unlockToManage")}</span>
        </p>
      )}
    </Panel>
  );
}

/** Settings › Security › Record: what happened to this profile's security, and what Sixkey keeps in it. */
export function SecurityRecord({ rt, status, vault, reload }: Ctx) {
  return (
    <Panel id="security-log" icon="shieldAlert" title={t("secLogTitle")} lead={t("secLogLead")}>
      <SecurityCard rt={rt} status={status} vault={vault} reload={reload} />
    </Panel>
  );
}
