import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ServiceError, type ServiceStatus } from "../core/service/service";
import { trashEntries, type Vault } from "../core/vault/model";
import { VaultError } from "../core/vault/validate";
import { CSB_CFG_KEY, CSB_STATE_KEY, parseCsbConfig, parseCsbState } from "../platform/csb-config";
import { createRuntime } from "../platform/runtime";
import { LOCK_EPOCH_KEY } from "../platform/session";
import { VaultDial } from "../ui/art";
import { t } from "../ui/i18n";
import { Icon } from "./icons";
import type { SetupDone, SetupStart } from "./FirstRun";
import { dropHandoffs } from "./import-handoff";
import { InstallNotice } from "./InstallNotice";
import { useKeyOps } from "./key-ops";
// every part of the page is drawn through its wrapper, once its text is in (parts.tsx)
import {
  AddAccounts,
  Advanced,
  Appearance,
  Autofill,
  Backup,
  Clipboard,
  FirstRun,
  Groups,
  loadParts,
  partsFor,
  partsReady,
  PendingDeletes,
  ResetPassword,
  Security,
  SecurityKeys,
  SecurityRecord,
  SetupReady,
  Trash,
  UnlockBar,
} from "./parts";
import { Rail, SubNav, type RailCsb, type RailSection } from "./Rail";
import type { ResetOutcome } from "./Reset";
import { DEFAULT_LEAF, groupOf, LEAVES, leafOfHash, nextPicked, panelOfHash } from "./route";
import { BoxTitle, errText, RecoveryCodeBox, type Ctx } from "./shared";
import { watchSettings } from "./settings-store";

// The rail's groups (route.ts GROUPS has the leaves of each, one of which is on the page at a time): [id, title key, icon].
const SECTIONS: readonly RailSection[] = [
  ["accounts", "grpAccounts", "key"],
  ["security", "secTitle", "shield"],
  ["appearance", "lookTitle", "sun"],
  ["advanced", "advancedTitle", "sliders"],
];
/** The groups that have leaves of their own, with their titles: [leaf id, title key] (the links under the page's title). */
const TABS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  accounts: [
    ["add", "addTitle"],
    ["groups", "groupsTitle"],
    ["backup", "backupTitle"],
    ["trash", "trashTitle"],
  ],
  security: [
    ["security", "secLockTab"],
    ["security-keys", "secKeysTab"],
    ["security-log", "secLogTitle"],
    // the sites Chrome lets TOTP autofill into, and what that allows (AUTOFILL2-NOTES.md §7.3 P2-5)
    ["autofill", "afsTitle"],
  ],
};
const TABS_TITLE: Readonly<Record<string, string>> = { accounts: "grpAccounts", security: "secTitle" };

/**
 * #setup and #setup-restore come from the popup's welcome screen, and #setup-csb (the restore from Chrome Sync) from its
 * button where a copy of the backup is in Chrome Sync.
 */
const setupFromHash = (): SetupStart => ({
  mode: location.hash === "#setup-restore" ? "restore" : location.hash === "#setup-csb" ? "csb" : "create",
});
const clearSetupHash = () => {
  if (location.hash.startsWith("#setup")) history.replaceState(null, "", location.pathname + location.search);
};
/** #reset comes from the popup's "Set a new password" (A4R-1): the reset runs here, where the page survives a focus change. */
const clearResetHash = () => {
  if (location.hash === "#reset") history.replaceState(null, "", location.pathname + location.search);
};

export function App() {
  const rt = useMemo(() => createRuntime(), []);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(null);
  // the backup in Chrome sync's records: the rail's line for it, and while it runs (on, not stopped) the rail's backup
  // line is no reminder, as the popup's is not
  const [csb, setCsb] = useState<RailCsb>(null);
  const readBackup = useCallback(async () => {
    const [at, r] = await Promise.all([
      rt.service.lastBackupAt(),
      rt.local.get([CSB_CFG_KEY, CSB_STATE_KEY]).catch(() => ({}) as Record<string, unknown>),
    ]);
    setLastBackup(at);
    setCsb({ cfg: parseCsbConfig(r[CSB_CFG_KEY]), st: parseCsbState(r[CSB_STATE_KEY]) });
  }, [rt]);
  // and again when either changes, or a backup is made (sk_last_backup): from this page, the popup, or the worker
  useEffect(() => {
    const area = chrome.storage?.local;
    const changed = (c: Record<string, chrome.storage.StorageChange>) => {
      if (CSB_CFG_KEY in c || CSB_STATE_KEY in c || "sk_last_backup" in c) void readBackup().catch(() => undefined);
    };
    area?.onChanged.addListener(changed);
    return () => area?.onChanged.removeListener(changed);
  }, [readBackup]);
  const [problem, setProblem] = useState<string | null>(null);
  // The first-run wizard, once entered, stays until it is finished or left: making the vault changes the status, but steps
  // after that (clipboard, the hint at "Add accounts") still belong to it. While it runs the panels are not mounted.
  const [setup, setSetup] = useState<SetupStart | null>(null);
  const [holding, setHolding] = useState(false); // the wizard has prepared keys: no reload (the language menu) until it is done
  const [ready, setReady] = useState<SetupDone | null>(null);
  const [resetting, setResetting] = useState(() => location.hash === "#reset"); // shown only while the vault is locked
  const [resetDone, setResetDone] = useState<ResetOutcome>(null);
  // The leaf the hash names (null: none, so the default). Back and Forward, the rail's links and every link to a part of
  // the page change the hash, and with it this: the page shows what its address says.
  const [picked, setPicked] = useState(() => leafOfHash(location.hash, LEAVES));
  const leaf = picked ?? (status?.state === "lost" ? "backup" : DEFAULT_LEAF); // a lost vault: its way out is the restore
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => {
      setPicked(nextPicked(location.hash, LEAVES));
      setHash(location.hash);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  // Switching leaf (not the first drawing: that would take the focus from the unlock, reset and wizard fields) starts the
  // new one at the top, with the focus on its heading, where a screen reader begins reading.
  const shown = useRef<string | null>(null);
  const drawn = status !== null;
  useEffect(() => {
    if (!drawn) return;
    if (shown.current !== null && shown.current !== leaf) {
      scrollTo(0, 0);
      document.querySelector<HTMLElement>(`#${leaf} h2`)?.focus({ preventScroll: true });
    }
    shown.current = leaf;
  }, [leaf, drawn]);
  // A hash that points at a panel inside a leaf (#clipboard, from Locking's link) brings that panel into view
  // and, after the first drawing, puts the focus on its heading: the panel can be below the window's bottom edge. The
  // leaf's panels fill in as their own state is read, so the page is not as tall as it will be: the scroll is made again
  // for a moment, and given up at the person's first wheel, touch or key. A page that opens locked (the unlock bar, the
  // reset) stays at its top: what it asks for first is above the leaf.
  const firstHash = useRef(true);
  useEffect(() => {
    if (!drawn) return;
    const panel = panelOfHash(hash);
    const el = panel ? document.getElementById(panel) : null;
    const first = firstHash.current;
    firstHash.current = false;
    if (!el || (first && status?.state !== "unlocked")) return;
    el.scrollIntoView({ block: "start" });
    if (!first) el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    let tries = 0;
    const again = setInterval(() => {
      el.scrollIntoView({ block: "start" });
      if (++tries >= 8) stop();
    }, 120);
    const stop = () => {
      clearInterval(again);
      for (const ev of ["wheel", "touchstart", "keydown"]) removeEventListener(ev, stop);
    };
    for (const ev of ["wheel", "touchstart", "keydown"]) addEventListener(ev, stop, { passive: true });
    return stop;
  }, [hash, leaf, drawn]);
  // A file dropped anywhere on the page is not opened by the browser as a page of its own (a plain text export would be
  // shown in the tab): only Add account's drop zone takes files, and it is on the page only in its leaf.
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
    };
    document.addEventListener("dragover", guard);
    document.addEventListener("drop", guard);
    return () => {
      document.removeEventListener("dragover", guard);
      document.removeEventListener("drop", guard);
    };
  }, []);

  // Reloads can overlap (a lock arrives while the vault of an earlier one is still being read): only the latest one
  // shows the vault it read, so a lock is never followed by the vault an older reload read before it.
  const reloads = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++reloads.current;
    try {
      const st = await rt.service.status();
      // the text of the view this state opens on, before it is drawn (parts.tsx; never rejects). A page with a vault has
      // the lock's text already, so a lock from anywhere is shown at once, with nothing awaited here
      const view = partsFor(st.state);
      if (!partsReady(view)) await loadParts(view);
      setStatus(st);
      // H1: with no vault there is nothing to manage yet, and the only way on is a master password: the page is the wizard.
      if (st.state === "empty") setSetup((cur) => cur ?? setupFromHash());
      else if (st.state === "lost" && (location.hash === "#setup-restore" || location.hash === "#setup-csb"))
        setSetup((cur) => cur ?? setupFromHash());
      setProblem(null);
      await readBackup();
      if (st.state === "unlocked") {
        const opened = await rt.service.read();
        if (mine !== reloads.current) return; // a newer reload shows what is true now
        setVault(opened.vault);
        void rt.service
          .touch()
          .then(() => chrome.runtime.sendMessage({ type: "sk-reschedule-autolock" }))
          .catch(() => undefined);
      } else setVault(null);
    } catch (e) {
      setVault(null);
      if (e instanceof VaultError && e.code === "newer_schema") setProblem(t("newerBody"));
      else if (e instanceof ServiceError && e.code === "locked") {
        const view = partsFor("locked");
        if (!partsReady(view)) await loadParts(view);
        setStatus({ state: "locked", events: [] });
      } else setProblem(errText(e));
    }
  }, [rt]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A change of the settings record made on another page (the View menu in the popup or the side panel, another settings
  // tab): every panel shows what is stored.
  useEffect(() => watchSettings(rt), [rt]);

  // The master password's and the keys' operations, and the recovery code a new one shows, live here and not in the
  // leaf that asks for them (key-ops.ts): leaving it mid-way must not lose the code of a change that has committed.
  const keys = useKeyOps(rt, reload);
  const codePending = keys.code !== null;
  // The new code is on this page only: leaving (closing the tab, the language menu's reload) loses it for good, so ask
  // first, as the first-run wizard does, until the person has saved it.
  // (also while an operation is under way: its code arrives a second or more after the click, and closing meanwhile
  // would lose it)
  const keyHold = codePending || keys.busy;
  useEffect(() => {
    if (!keyHold) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [keyHold]);
  // What an operation answered shows in its leaf (the forms); anywhere else it shows at the top, until the person has
  // moved on once it was seen.
  // (Locking draws an answer only in the device-key vault's box that turns a master password on.)
  const deviceOnly = status?.state === "unlocked" && !status.passwordProtected;
  const keysLeaf = leaf === "security-keys" || (leaf === "security" && deviceOnly);
  const answered = keys.error !== null || keys.info !== null;
  const seenOn = useRef<string | null>(null);
  useEffect(() => {
    if (!answered || keysLeaf) seenOn.current = null;
    else if (seenOn.current === null) seenOn.current = leaf;
    else if (seenOn.current !== leaf) keys.clear();
  }, [answered, keysLeaf, leaf]);

  // A lock from anywhere (Lock now, the `lock` shortcut, the idle timer, the screen lock) bumps the lock epoch: an unlocked
  // page drops its vault at once and shows itself locked (QUICK-UNLOCK §5.12 item 3).
  const unlockedNow = status?.state === "unlocked";
  // A file handed over from Backup that Add account has not taken yet does not outlive a lock
  useEffect(() => {
    if (!unlockedNow) dropHandoffs();
  }, [unlockedNow]);
  useEffect(() => {
    if (!unlockedNow) return;
    const area = chrome.storage?.session;
    const changed = (c: Record<string, chrome.storage.StorageChange>) => {
      if (LOCK_EPOCH_KEY in c) void reload();
    };
    area?.onChanged.addListener(changed);
    return () => area?.onChanged.removeListener(changed);
  }, [reload, unlockedNow]);

  if (!status)
    return (
      <div class="shell">
        <main>
          <h1>Sixkey</h1>
          <p class="muted">{problem ?? ""}</p>
        </main>
      </div>
    );
  const ctx: Ctx = { rt, status, vault, reload };
  const group = groupOf(leaf);
  // reload() pins the wizard in the same render that first shows "empty", so `setup` alone decides. Leaving it waits for
  // the new status first; otherwise one render would still see "empty" and could show a fresh wizard over the new vault.
  const wizard = setup;
  const leave = async () => {
    clearSetupHash();
    await reload();
    setSetup(null);
  };
  const finished = async (r: SetupDone) => {
    // the wizard ends at Add accounts ("add your first account"), whatever section the page was opened on
    history.replaceState(null, "", `${location.pathname}${location.search}#add`);
    setPicked("add");
    await reload();
    setSetup(null);
    setReady(r);
  };
  const resetLeft = (outcome: ResetOutcome) => {
    clearResetHash();
    setResetting(false);
    setResetDone(outcome);
    void reload();
  };

  return (
    <div class="shell">
      <Rail
        sections={wizard || codePending ? [] : SECTIONS}
        current={group?.id ?? leaf}
        status={status}
        vault={vault}
        lastBackup={lastBackup}
        csb={csb}
        langLocked={holding || codePending}
      />
      <main>
        <header class="top">
          <div>
            <h1>{t("settings")}</h1>
            <p class="intro">{t("optionsLead")}</p>
          </div>
          <VaultDial size={116} class="deco" />
        </header>
        <InstallNotice />
        {problem && (
          <div class="err" role="alert">
            <Icon name="alert" size={15} />
            {problem}
          </div>
        )}
        {wizard ? (
          <FirstRun
            key={wizard.mode}
            rt={rt}
            start={wizard}
            {...(status.state === "empty" ? { onSwitch: setSetup } : {})}
            onExit={() => void leave()}
            onDone={(r) => void finished(r)}
            onRefresh={reload}
            onHolding={setHolding}
          />
        ) : (
          <>
            {resetDone && (
              <p class="callout good" id="reset-done" role="status">
                <Icon name="check" size={16} />
                <span>{t(resetDone === "unlocked" ? "resetDone" : "resetDoneLocked")}</span>
              </p>
            )}
            {status.state === "locked" &&
              (resetting ? (
                <ResetPassword ctx={ctx} onLeave={resetLeft} onHolding={setHolding} />
              ) : (
                <UnlockBar ctx={ctx} />
              ))}
            {status.state === "lost" && (
              <div class="box warn banner" role="alert">
                <BoxTitle icon="alert">{t("lostTitle")}</BoxTitle>
                <p>{t("lostBody")}</p>
              </div>
            )}
            {/* A new recovery code is above every leaf, whichever one the person is on, until they have saved it */}
            {keys.code !== null && (
              <RecoveryCodeBox
                code={keys.code}
                onDone={() => {
                  keys.codeSaved();
                  void reload();
                }}
              />
            )}
            <PendingDeletes />
            {answered && !keysLeaf && (
              <div class={keys.error ? "err" : "ok-msg"} role={keys.error ? "alert" : "status"}>
                <Icon name={keys.error ? "alert" : "check"} size={15} />
                {keys.error ?? keys.info}
              </div>
            )}
            {!codePending && group && TABS[group.id] && (
              <SubNav
                label={t(TABS_TITLE[group.id]!)}
                leaves={TABS[group.id]!}
                current={leaf}
                trashCount={vault ? trashEntries(vault).length : 0}
              />
            )}
            {leaf === "security" && <Security {...ctx} keys={keys} />}
            {leaf === "security-keys" && <SecurityKeys {...ctx} keys={keys} />}
            {leaf === "security-log" && <SecurityRecord {...ctx} />}
            {leaf === "add" && (
              <>
                {ready && <SetupReady rt={rt} {...ready} />}
                <AddAccounts {...ctx} />
              </>
            )}
            {leaf === "groups" && <Groups {...ctx} />}
            {leaf === "backup" && <Backup {...ctx} onSetup={setSetup} />}
            {leaf === "trash" && <Trash {...ctx} />}
            {leaf === "appearance" && (
              <>
                <Appearance {...ctx} />
                <Clipboard />
              </>
            )}
            {leaf === "autofill" && <Autofill {...ctx} />}
            {leaf === "advanced" && <Advanced {...ctx} onSetup={setSetup} />}
          </>
        )}
      </main>
    </div>
  );
}
