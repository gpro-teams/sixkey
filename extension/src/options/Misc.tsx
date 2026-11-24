import { useEffect, useRef, useState } from "preact/hooks";
import { accountsOf, markedSites, markSite, unmarkSite } from "../core/autofill-marks";
import { aliveEntries, isPurged, trashEntries, type Entry } from "../core/vault/model";
import { parseHlc } from "../core/vault/hlc";
import { restoreEntry } from "../core/vault/ops";
import {
  answered,
  offHint,
  readList,
  removeSite,
  requestSite,
  siteGranted,
  SITES_KEY,
} from "../platform/autofill-sites";
import { readDiag } from "../platform/diag";
import {
  askMacLink,
  macHello,
  macLinkOn,
  mergeFromMac,
  sendVaultToMac,
  stopMacLink,
  type MacSend,
} from "../platform/mac-link";
import { storageClosed } from "../platform/storage-access";
import { formatDate, formatDateTime, t } from "../ui/i18n";
import { Avatar } from "../ui/art";
import { Icon } from "./icons";
import type { SetupStart } from "./FirstRun";
import { ConfirmField, useConfirm } from "./ConfirmField";
import { BoxTitle, download, errText, Panel, stamp, type Ctx } from "./shared";

const TRASH_DAYS = 30;

export function Trash({ rt, vault, status, reload }: Ctx) {
  const unlocked = status.state === "unlocked" && vault !== null;
  const trash = vault ? trashEntries(vault) : [];
  const [error, setError] = useState<string | null>(null);
  // Deleting for good cannot be undone: the PIN or the master password typed again, whenever there is a master password
  // (the service checks it, VaultService.confirmSecret; the PIN since 2026-11-24, OWNER-DECISIONS/26), so that an
  // unlocked page left alone never reaches it. The field is emptied on a lock (useConfirm).
  const needsPw = status.state === "unlocked" && status.passwordProtected;
  const confirm = useConfirm(rt, unlocked);
  const canErase = unlocked && (!needsPw || confirm.value.length > 0);
  const deletedAt = (e: Entry) => (e.dhlc ? (parseHlc(e.dhlc)?.wall ?? 0) : 0);

  const oldOnes = trash.filter((e) => deletedAt(e) > 0 && Date.now() - deletedAt(e) > TRASH_DAYS * 86_400_000);

  /** Back from the trash. */
  async function restore(id: string) {
    setError(null);
    try {
      await rt.service.mutate((v, c) => restoreEntry(v, id, c));
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  }
  async function erase(ids: string[]) {
    setError(null);
    try {
      await rt.service.purgeForever(ids, needsPw ? confirm.secret() : "");
      confirm.setValue("");
      await reload();
    } catch (e) {
      setError(confirm.refused(e) ?? errText(e));
    }
  }
  return (
    <Panel id="trash" icon="trash" title={t("trashTitle")} lead={t("trashLead")}>
      {error && (
        <div class="err" role="alert">
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}
      {needsPw && trash.length > 0 && (
        <ConfirmField
          c={confirm}
          id="trash-pw"
          fieldId="trash-pw-field"
          label={t("passwordLabel")}
          rt={rt}
          describedBy="trash-pw-why"
        >
          <p class="muted" id="trash-pw-why">
            {t("eraseNeedsPassword")}
          </p>
        </ConfirmField>
      )}
      {oldOnes.length > 0 && (
        <div class="row2">
          <button
            id="trash-clear-old"
            class="btn sm danger"
            disabled={!canErase}
            onClick={() => void erase(oldOnes.map((e) => e.id))}
          >
            <Icon name="trash" size={14} />
            {t("trashClearOld", oldOnes.length, TRASH_DAYS)}
          </button>
        </div>
      )}
      {trash.length === 0 ? (
        <div class="nothing">
          <Icon name="trash" size={20} />
          <span>{t("trashEmpty")}</span>
        </div>
      ) : (
        <table class="tlist">
          <tbody>
            {trash.map((e) => (
              <tr key={e.id}>
                <td class="tw">
                  <Avatar name={e.issuer || e.label} size={30} />
                  <span>
                    <b>{e.issuer || e.label}</b>
                    <span class="muted">{e.issuer ? e.label : ""}</span>
                  </span>
                </td>
                <td class="muted num">{formatDate(deletedAt(e))}</td>
                <td>
                  <button class="btn sm ghost" disabled={!unlocked} onClick={() => void restore(e.id)}>
                    <Icon name="restore" size={14} />
                    {t("restore")}
                  </button>{" "}
                  <button class="btn sm ghost danger-text" disabled={!canErase} onClick={() => void erase([e.id])}>
                    {t("deleteForever")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {vault && vault.entries.some(isPurged) && <p class="muted">{t("purgedNote")}</p>}
    </Panel>
  );
}

export function Clipboard() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void chrome.permissions.contains({ permissions: ["clipboardRead", "clipboardWrite"] }).then(setOn);
  }, []);
  async function toggle() {
    if (on) {
      await chrome.permissions.remove({ permissions: ["clipboardRead", "clipboardWrite"] });
      setOn(false);
    } else {
      setOn(await chrome.permissions.request({ permissions: ["clipboardRead", "clipboardWrite"] }));
    }
  }
  return (
    <Panel id="clipboard" icon="clipboard" title={t("clipTitle")} lead={t("clipBody")}>
      <div class={`switchrow${on ? " is-on" : ""}`}>
        <span class="sw-ic">
          <Icon name="clipboard" size={18} />
        </span>
        <span class="sw-tx">
          <b>{t("clipRowTitle")}</b>
          <span id="clip-state" class={`chip ${on ? "ok" : ""}`}>
            {on === null ? "" : on ? t("clipOn") : t("clipOff")}
          </span>
        </span>
        <button id="clip-toggle" class={`btn ${on ? "ghost" : ""}`} onClick={() => void toggle()}>
          {on ? t("clipDisable") : t("clipEnable")}
        </button>
      </div>
      <p class="callout">
        <Icon name="info" size={16} />
        <span>{t("clipHistoryNote")}</span>
      </p>
    </Panel>
  );
}

/**
 * Autofill, a leaf of Security (TOTP autofill Stage 2, patch 2; docs/design/notes/AUTOFILL2-NOTES.md §7): the sites the
 * user turned code suggestions on for (platform/autofill-sites.ts), each with Chrome's grant as Chrome says it now: On,
 * or Turned off in Chrome (withdrawn in Chrome's own settings; "Turn on again" asks Chrome for that one site, as the
 * first thing its click does). Remove takes the site off the list and gives Chrome's grant for it back. Where Sixkey
 * cannot close its storage to web pages (STORAGEGATE's storageClosed: a second layer, since Sixkey installs only on Chrome
 * 140 and later, which can close it), it says so and asks Chrome for nothing; Remove still works. Nothing here needs the
 * vault, so the list works locked too. It is the built-in autofill's page: on top, its switch and its recent requests
 * (options/AutofillSwitch.tsx, a chunk of its own, shown while unlocked); while it is off, no site is offered to turn
 * on again.
 */
let switchChunk: Promise<typeof import("./AutofillSwitch")> | null = null;
const loadSwitch = () =>
  (switchChunk ??= import("./AutofillSwitch")
    .then(async (m) => (await m.prepare(), m))
    .catch((e) => {
      switchChunk = null;
      throw e;
    }));

// The site rules' updater's switch (TOTP autofill Stage 3, AF3-U2; options/RulesUpdate.tsx, a chunk of its own with its
// own text), at the foot of this page, in a build whose updater's release gate is open and in no other. The gate is the
// build's define, used where it stands (never through a constant of this module, which the minifier would keep), so that
// with the gate closed the page's code is byte for byte what it was before the updater (the store build: check-dist and
// the build lists hold it).
declare const __RULES_UPDATE__: boolean;
function RulesHost() {
  const [Switch, setSwitch] = useState<(typeof import("./RulesUpdate"))["RulesUpdate"] | null>(null);
  useEffect(() => {
    let live = true;
    if (typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__)
      void import("./RulesUpdate").then(
        async (m) => (await m.prepare(), live && setSwitch(() => m.RulesUpdate)),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, []);
  return Switch && <Switch />;
}

export function Autofill(ctx: Ctx) {
  const [Switch, setSwitch] = useState<(typeof import("./AutofillSwitch"))["AutofillSwitch"] | null>(null);
  const [off, setOff] = useState(offHint());
  useEffect(() => {
    let live = true;
    void loadSwitch().then(
      (m) => live && setSwitch(() => m.AutofillSwitch),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  const [rows, setRows] = useState<{ host: string; on: boolean }[] | null>(null);
  const [closed, setClosed] = useState<boolean | null>(null);
  const reads = useRef(0);
  // the list and each site's grant, read again whenever either changes (here, in another page, in Chrome's settings)
  const read = async () => {
    const mine = ++reads.current;
    const hosts = await readList();
    const next = await Promise.all(hosts.map(async (host) => ({ host, on: await siteGranted(host) })));
    if (mine === reads.current) setRows(next); // a later read shows what is true now
  };
  useEffect(() => {
    void storageClosed().then(setClosed);
    void read();
    const local = chrome.storage?.local;
    const listChanged = (c: Record<string, unknown>) => void (SITES_KEY in c && read());
    const grantsChanged = () => void read();
    local?.onChanged.addListener(listChanged);
    chrome.permissions?.onAdded?.addListener(grantsChanged);
    chrome.permissions?.onRemoved?.addListener(grantsChanged);
    return () => {
      local?.onChanged.removeListener(listChanged);
      chrome.permissions?.onAdded?.removeListener(grantsChanged);
      chrome.permissions?.onRemoved?.removeListener(grantsChanged);
    };
  }, []);
  // The list across computers (core/autofill-marks.ts; the owner's request of 2026-11-18): this computer's sites are
  // marked on their accounts in the vault, which the backup in Chrome sync carries; the sites marked on another computer
  // and not on this one are offered below, each turned on by a click (Chrome's prompt, then this computer's list).
  const { rt, vault, status, reload } = ctx;
  const unlocked = status.state === "unlocked" && vault !== null;
  const live = vault ? aliveEntries(vault) : [];
  const marked = markedSites(live);
  const others = rows ? marked.filter((h) => !rows.some((r) => r.host === h)) : [];
  const marking = useRef("");
  useEffect(() => {
    if (!unlocked || !rows) return;
    const todo = rows
      .map((r) => r.host)
      .filter((h) => !marked.includes(h))
      .map((h) => [h, accountsOf(live, h).map((e) => e.id)] as const)
      .filter(([, ids]) => ids.length > 0);
    const key = todo.map(([h]) => h).join(" ");
    if (!todo.length || marking.current === key) return; // (once per set of sites: a refused write is not retried here)
    marking.current = key;
    void rt.service
      .mutate((v, c) => todo.reduce((n, [h, ids]) => markSite(n, ids, h, c), v))
      .then(reload, () => undefined);
  }, [unlocked, rows, vault]);
  /** A site of another computer, turned on here: Chrome's prompt FIRST, in the click, then this computer's list. */
  function here(host: string): void {
    const asked = requestSite(host);
    void asked
      .catch(() => false)
      .then((granted) => answered(host, granted))
      .then(read, read);
  }
  /** Taken off the list of every computer (its mark); each computer's own list keeps it until removed there. */
  async function forget(host: string): Promise<void> {
    if (unlocked) await rt.service.mutate((v, c) => unmarkSite(v, host, c)).then(reload, () => undefined);
  }
  /** "Turn on again": Chrome's prompt FIRST, in the click itself (a gesture spent on an await is gone). */
  function again(host: string): void {
    const asked = requestSite(host);
    void asked
      .catch(() => false)
      .then((granted) => answered(host, granted)) // (the site is on the list already: this ends the ask)
      .then(read, read);
  }
  return (
    <Panel id="autofill" icon="keyboard" title={t("afsTitle")} lead={t("afsLead")}>
      {Switch && <Switch rt={ctx.rt} status={ctx.status} onChange={() => (setOff(offHint()), void read())} />}
      {closed === false && (
        <p class="callout warn" id="afs-old" role="status">
          <Icon name="alert" size={16} />
          <span>{t("afsOld")}</span>
        </p>
      )}
      {rows?.length === 0 && (
        <div class="nothing">
          <Icon name="keyboard" size={20} />
          <span>{t("afsNone")}</span>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <table class="tlist" id="afs-sites">
          <tbody>
            {rows.map((r) => (
              <tr key={r.host} data-host={r.host}>
                <td class="tw">
                  <b>{r.host}</b>
                </td>
                <td>
                  {/* while autofill is off its grants were given back on purpose: no "Turned off in Chrome" (the switch says) */}
                  {!off && <span class={`chip ${r.on ? "ok" : "warn"}`}>{r.on ? t("clipOn") : t("afsOff")}</span>}
                </td>
                <td>
                  {!r.on && closed === true && !off && (
                    <button class="btn sm ghost afs-again" onClick={() => again(r.host)}>
                      {t("afsAgain")}
                    </button>
                  )}{" "}
                  <button
                    class="btn sm ghost danger-text afs-remove"
                    onClick={() =>
                      void removeSite(r.host)
                        .then(() => forget(r.host))
                        .then(read, read)
                    }
                  >
                    {t("afsRemove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {others.length > 0 && !off && (
        <div class="box" id="afs-others">
          <BoxTitle icon="sync">{t("afsOthersTitle")}</BoxTitle>
          <p class="muted">{t("afsOthersLead")}</p>
          <table class="tlist">
            <tbody>
              {others.map((h) => (
                <tr key={h} data-host={h}>
                  <td class="tw">
                    <b>{h}</b>
                  </td>
                  <td>
                    {closed === true && (
                      <button class="btn sm afs-here" onClick={() => here(h)}>
                        {t("afsHere")}
                      </button>
                    )}{" "}
                    <button class="btn sm ghost danger-text afs-forget" onClick={() => void forget(h)}>
                      {t("afsRemove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {typeof __RULES_UPDATE__ === "boolean" && __RULES_UPDATE__ ? (
        <>
          <p class="muted">{t("afsChrome")}</p>
          <RulesHost />
        </>
      ) : (
        <p class="muted">{t("afsChrome")}</p>
      )}
    </Panel>
  );
}

/**
 * The link with Sixkey for Mac (platform/mac-link.ts): turned on by a click, which asks Chrome for the optional
 * nativeMessaging permission first thing; then the vault is sent once, and whether the app answers is shown.
 */
function MacLink({ rt }: Pick<Ctx, "rt">) {
  const [on, setOn] = useState<boolean | null>(null);
  const [line, setLine] = useState("");
  const version = chrome.runtime.getManifest().version;
  const said = (sent: MacSend): string =>
    sent === "kept"
      ? t("macLinkSent")
      : sent === "not_sendable"
        ? t("macLinkNeedsPassword")
        : sent === "no_app"
          ? t("macLinkNoApp")
          : "";
  const look = async () => {
    const linked = await macLinkOn();
    setOn(linked);
    if (!linked) return setLine("");
    const h = await macHello(version);
    setLine(!h.found ? t("macLinkNoApp") : h.vault ? t("macLinkFound", h.app) : t("macLinkNoVault", h.app));
  };
  useEffect(() => void look(), []);
  const send = async () => {
    const { sent, mac } = await sendVaultToMac(() => rt.store.load(), `Sixkey ${version}`);
    if (sent === "kept") {
      await mergeFromMac(rt.service, mac); // the Mac's own changes come back with its answer
      await look();
    }
    setLine(said(sent) || line);
  };
  const turnOn = () => {
    const asked = askMacLink(); // first in the click: Chrome's prompt
    void asked.then(async (granted) => {
      if (!granted) return;
      setOn(true);
      await send();
    });
  };
  return (
    <div class="box" id="mac-link">
      <BoxTitle icon="device">{t("macLinkTitle")}</BoxTitle>
      <p class="muted">{t("macLinkBody")}</p>
      {line && (
        <p id="mac-link-line" role="status">
          {line}
        </p>
      )}
      <div class="row2">
        {on ? (
          <>
            <button class="btn ghost" id="mac-link-send" onClick={() => void send()}>
              {t("macLinkSendNow")}
            </button>
            <button
              class="btn ghost"
              id="mac-link-off"
              onClick={() => void stopMacLink().then(() => (setOn(false), setLine("")))}
            >
              {t("macLinkOff")}
            </button>
          </>
        ) : (
          on === false && (
            <button class="btn" id="mac-link-on" onClick={turnOn}>
              {t("macLinkOn")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** `onSetup`: starting over continues in the first-run wizard; nothing is erased until it finishes. */
export function Advanced({ rt, status, onSetup }: Ctx & { onSetup: (s: SetupStart) => void }) {
  const [confirm, setConfirm] = useState("");
  return (
    <Panel id="advanced" icon="sliders" title={t("advancedTitle")} lead={t("advLead")}>
      <div class="cards">
        <div class="box">
          <BoxTitle icon="clock">{t("clockTitle")}</BoxTitle>
          <p id="clock-now" class="clock">
            {formatDateTime(Date.now())}
          </p>
          <p class="muted">{t("clockBody")}</p>
        </div>
        <div class="box">
          <BoxTitle icon="pulse">{t("diagTitle")}</BoxTitle>
          <p class="muted">{t("diagBody")}</p>
          <div class="row2">
            <button
              class="btn ghost"
              onClick={async () =>
                download(
                  `sixkey-diagnostics-${stamp()}.json`,
                  JSON.stringify(
                    { at: Date.now(), events: await rt.store.listEvents(), log: await readDiag(rt.local) },
                    null,
                    2,
                  ),
                )
              }
            >
              <Icon name="download" size={16} />
              {t("diagExport")}
            </button>
          </div>
        </div>
        <MacLink rt={rt} />
      </div>
      {status.state === "lost" && (
        <div class="box danger">
          <BoxTitle icon="alert">{t("startOverTitle")}</BoxTitle>
          <p>{t("startOverBody")}</p>
          <div class="field">
            <label for="so-confirm">{t("startOverType", "DELETE")}</label>
            <input
              id="so-confirm"
              class="mono"
              type="text"
              value={confirm}
              onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="row2">
            <button
              class="btn danger"
              id="so-go"
              disabled={confirm !== "DELETE"}
              onClick={() => onSetup({ mode: "startOver" })}
            >
              {t("startOverAction")}
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
