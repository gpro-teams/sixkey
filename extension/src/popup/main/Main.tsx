import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { canRegister, firmGuess, hostOf } from "../../core/match";
import { displayOf, profileOf } from "../../core/service/types";
import type { StorageEvent } from "../../core/storage/format";
import { aliveEntries, type Entry } from "../../core/vault/model";
import { deleteEntry, editEntry, moveEntry, setGroup } from "../../core/vault/ops";
import { markSite } from "../../core/autofill-marks";
import { lookalikeOf } from "../../core/lookalike";
import { armClipboardClear, CLEAR_AFTER_MS } from "../../platform/clipboard";
import type { PopupRuntime } from "../../platform/runtime-base";
import { useCodes } from "../../ui/hooks";
import { useShortcut } from "../../ui/shortcut";
import { Icon, type IconName } from "../../ui/icons";
import { getLang, t } from "../../ui/i18n";
import { canGenerate, codeAt, remaining } from "../../ui/otp";
import { Brand, LangToggle, openOptions } from "../chrome";
import type { Screen } from "../load";
import { surface } from "../surface";
import { inputOf, pasteKey, type AddInput } from "./add-input";
import { List } from "./List";
import {
  aliasKey,
  askHost,
  autoGroups,
  buildSections,
  byUse,
  sameNames,
  sameTogether,
  filterRows,
  normalizeQuery,
  userFirst,
  type Order,
} from "./model";
import { Notices } from "./Notices";
import { scanTab } from "./scan";
import { countUse, readUses } from "./uses";
import { siteRules } from "./site-rules";

const BACKUP_REMINDER_MS = 7 * 86_400_000;

/**
 * The confirm page, with the importer, the otpauth and Google export parsers and the dedupe rules: loaded on first use
 * (PHASE0X-PLAN B3), so none of it is in the popup's counted bundle. It imports nothing that only the popup has: what
 * it needs from here (copying, saving, the current site, the way to the settings page) comes in as props.
 */
const confirmPage = () => import("./AddConfirm");
/**
 * The "Add account" view (and its styles): loaded on the first Add, as the confirm page is, so it is not in the popup's
 * counted bundle (docs/design/notes/QUICKVIEW-NOTES.md). What the list needs of it without the view is ./add-input.
 */
const addMenu = () => import("./AddMenu");
/**
 * The edit dialog (and its styles): loaded on the first Edit, as the confirm page is, so it is not in the popup's
 * counted bundle (the popup's gzip budget, scripts/check-dist.mjs BUDGET_GZ). Its words stay in the popup's catalog.
 */
const editDialog = () => import("./EditDialog");
/**
 * "Remember this site" (and the sites' styles it shares with the edit dialog, main/site.css): loaded together with the
 * site rules its choices come from, which it waited for already, so it adds no wait and is not in the counted bundle.
 */
const rememberSheet = () => import("./Remember");
/**
 * The View menu (the search field's button; docs/design/notes/QUICKVIEW-NOTES.md): loaded on the first click, with its own
 * text, so neither is in the popup's counted bundle.
 */
const viewMenu = () => import("./View");
/**
 * The Fill button and its text (TOTP-AUTOFILL Stage 1; Fill.tsx): loaded the first time the list has a TOTP account
 * registered for this page, so neither is in the popup's counted bundle.
 */
const fillView = () => import("./Fill");
/**
 * "Same sign-in" (TOTP autofill Stage 3, AF3-4; ./aliases.ts): the accounts that Apple's list, shipped with each release,
 * says share this page's sign-in. Loaded after the first code on a page no account is registered for, so neither its code,
 * the site rules' reader nor its text is in the popup's counted bundle.
 */
const aliasView = () => import("./aliases");
/**
 * The backup in Chrome sync's pill, footer and one click (./CsbPop.tsx), in every build: loaded with the list, with its
 * text, so neither is in the popup's counted bundle; it reads nothing at the open (its records come in the screen).
 * Until it is in, the footer shows the account count only: whether to remind is its to say (no reminder while the backup
 * runs), and a reminder that a moment later goes away would be wrong. A chunk that cannot be loaded: the popup's own.
 */
const csbPop = () => import("./CsbPop");
/** How long Space, or press and hold, shows a hidden code. */
const REVEAL_MS = 5000;

/** The unlocked popup: toolbar, search, notices, the list, the footer, and the add and edit views. `extra` goes to Notices. */
export function Main({
  rt,
  screen,
  reload,
  extra,
  resume = null,
}: {
  rt: PopupRuntime;
  screen: Extract<Screen, { k: "main" }>;
  reload: () => Promise<void>;
  extra?: preact.ComponentChildren;
  /** The nonce of the pending fill request this surface's own unlock was made for (App; the Fill chunk acts on it once). */
  resume?: string | null;
}) {
  const { vault } = screen;
  // The active tab's address: undefined until the browser has answered (the list waits for it, so an account never moves
  // into "this site" under the pointer just after opening), null when there is none.
  const [tabHost, setHost] = useState<string | null | undefined>(undefined);
  const host = tabHost ?? null;
  // the page is not secure: http, but not this computer's own address (127.x.x.x, ::1) (the owner's request of
  // 2026-11-18): said at the top
  const [plainHttp, setPlainHttp] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "add" | "confirm">("list");
  // What is being added: everything pasted or scanned since the confirm page opened, and the view to go back to.
  // `host`: the site as it was when the confirm page opened, kept for it (in the side panel the active tab can change
  // meanwhile, and the site an account is remembered for must be the one the user was on: SIDEPANEL-NOTES.md §4).
  const [adding, setAdding] = useState<{ inputs: AddInput[]; from: "list" | "add"; host: string | null } | null>(null);
  const [confirmMod, setConfirmMod] = useState<Awaited<ReturnType<typeof confirmPage>> | null>(null);
  // An account just added with "Add and copy code": copied once the list has it.
  const [copyAfter, setCopyAfter] = useState<string | null>(null);
  const [fillMod, setFillMod] = useState<Awaited<ReturnType<typeof fillView>> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [addMod, setAddMod] = useState<Awaited<ReturnType<typeof addMenu>> | null>(null);
  const [csbMod, setCsbMod] = useState<Awaited<ReturnType<typeof csbPop>> | null | false>(null);
  useEffect(() => {
    void csbPop().then(
      (m) => setCsbMod(() => m),
      () => setCsbMod(false),
    );
  }, []);
  useEffect(() => {
    if (view === "add" && !addMod)
      addMenu().then(setAddMod, () => {
        setView("list");
        say(t("errorTitle"), "alert", "bad");
      });
  }, [view]);
  const [editMod, setEditMod] = useState<Awaited<ReturnType<typeof editDialog>> | null>(null);
  useEffect(() => {
    if (editing && !editMod)
      editDialog().then(setEditMod, () => {
        setEditing(null);
        say(t("errorTitle"), "alert", "bad");
      });
  }, [editing]);
  // "Remember this site" for one account, with the choices for this page (worked out by a module loaded on first use).
  const [remembering, setRemembering] = useState<{ id: string; choices: string[]; pick: string } | null>(null);
  // The page whose account the user is choosing, from the line above the list ("which account is it?"): every row then
  // offers "Remember", as a related one does. It ends with Escape, the line's button again, or the line going away.
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [rememberMod, setRememberMod] = useState<Awaited<ReturnType<typeof rememberSheet>> | null>(null);
  const [Menu, setMenu] = useState<Awaited<ReturnType<typeof viewMenu>>["ViewMenu"] | null>(null); // the open View menu
  const [toast, setToast] = useState<{ msg: string; icon: IconName; tone: string } | null>(null);
  const [clipUntil, setClipUntil] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [events, setEvents] = useState(screen.events);
  // How the list looks (density, hidden codes, order). It comes with the screen (PHASE0X-PLAN A2: openView reads the
  // settings with everything else), so it is known before the first frame: a hidden code never flashes up and the rows
  // never change height under the pointer, and opening costs no read of its own.
  const display = useMemo(() => displayOf(screen.settings), [screen.settings]);
  const [shownId, setShownId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // the `lock` shortcut, for the Lock now button's tooltip and its accessible shortcut (QUICK-UNLOCK §5.12 item 1)
  const lockKey = useShortcut("lock");
  const toastTimer = useRef<number>(0);
  const revealTimer = useRef<number>(0);

  // The active tab's address, readable because opening the popup grants activeTab. A layout effect, so the read starts
  // before the first paint and runs alongside the first codes. The side panel reads it again whenever the active tab may
  // have changed (a tab it was not opened on reads as no address: the browser gives none without a new click).
  const win = useRef<number>();
  // the user name already typed on that page (platform/page-user.ts, a lazy chunk): its account is listed first
  const [pageUserName, setPageUser] = useState<string | null>(null);
  // how often each account was used here (./uses.ts): read at the opening and at each look at the tab, never after a click
  const [uses, setUses] = useState(readUses);
  useLayoutEffect(() => {
    const ask = () =>
      chrome.tabs.query({ active: true, currentWindow: true }).then(
        (tabs) => {
          win.current = tabs[0]?.windowId;
          setHost(hostOf(tabs[0]?.url));
          setPlainHttp(
            /^http:/i.test(tabs[0]?.url ?? "") && !/^(127(\.\d+){3}|\[::1\])$/.test(hostOf(tabs[0]?.url) ?? ""),
          );
          setPageUser(null);
          setUses(readUses());
          const id = tabs[0]?.id;
          if (hostOf(tabs[0]?.url))
            void import("../../platform/page-user").then(
              (m) =>
                m.pageUser(id).then((u) => {
                  setPageUser(u);
                  m.armScripting(); // not held: asked for in the first click, for the next opening
                }),
              () => undefined,
            );
        },
        () => setHost(null),
      );
    void ask();
    return surface.panel?.watchTab(ask);
  }, []);

  const entries = useMemo(() => aliveEntries(vault), [vault]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const hide = display.hideCodes;
  useEffect(() => setShownId(null), [hide]); // hiding again (the View menu) ends a reveal, as a lock does
  useEffect(() => void (view !== "list" && setMenu(null)), [view]); // the menu belongs to the list
  const sortName = display.sort === "name";
  const order = useMemo<Order>(
    () =>
      sortName
        ? {
            sort: "name",
            compare: new Intl.Collator(getLang() === "zh_CN" ? "zh-CN" : "en", { sensitivity: "base", numeric: true })
              .compare,
          }
        : { sort: "manual" },
    [sortName],
  );

  const q = normalizeQuery(query);
  // "Same sign-in" (./aliases.ts, once loaded: it keeps each page's answer, and says when one came in time). The list reads
  // it only when it is rebuilt anyway, when the search, the page or the accounts (their ids and sites, in no order:
  // `accounts`) change, or when `aliasN` counts an answer that came in time; never on a reload that changes nothing (a View
  // menu choice, the side panel following a setting), a new order (a drag, or one synced in), nor a render a click caused
  const aliases = useRef<Awaited<ReturnType<typeof aliasView>>>();
  const [aliasN, setAliasN] = useState(0);
  const accounts = entries.map(aliasKey).sort().join(" ");
  const shown = useMemo(() => aliases.current?.shown(entries, host), [q, host, aliasN, accounts]);
  const rows = useMemo(() => filterRows(entries, q, host, shown), [entries, q, host, shown]);
  const sections = useMemo(
    () =>
      // the account the page's user name names first, in the site's sections, whatever the order
      buildSections(
        rows,
        q,
        host,
        { results: t("results"), ungrouped: t("ungrouped"), related: t("siteRelated") },
        order,
      )
        .map((s) =>
          s.key === "site" || s.key === "related"
            ? { ...s, rows: userFirst(byUse(s.rows, uses), pageUserName) }
            : s.key === "results"
              ? { ...s, rows: userFirst(s.rows, pageUserName) }
              : s,
        )
        // the accounts of one name side by side, in every section (List frames them)
        .map((s) => ({ ...s, rows: sameTogether(s.rows) })),
    [rows, q, host, order, pageUserName, uses],
  );
  const site = sections[0]?.key === "site" ? sections[0] : undefined;
  useEffect(() => {
    // the Fill chunk gets the vault key through the platform's gate only (MOD-PLATFORM §7.2 Option I; W1b)
    if ((site || resume) && !fillMod)
      void fillView().then(
        (m) => (
          m.connect(
            () => rt.service.grantKeys(),
            // a site with code suggestions, marked on its account once (core/autofill-marks.ts): no write if it is
            (id, host) => {
              const e = entriesRef.current.find((x) => x.id === id); // as they are now, not as at this effect
              if (e && !e.autofill?.includes(host))
                void mutate((v, c) => markSite(v, [id], host, c)).catch(() => undefined);
            },
          ),
          setFillMod(m)
        ),
      );
  }, [!!site, !!resume]);
  const rememberHost = canRegister(host) ? host : null;
  const askAbout = askHost(sections, q, host);
  const picking = !!askAbout && pickFor === askAbout;
  useEffect(() => setPickFor(null), [askAbout]); // a search, another tab (the side panel) or the site saved ends it
  // The remember sheet is for one account on one page: another page (the side panel follows the active tab) or the
  // account gone closes it, so it never offers one page's names on another (nor opens on another: remember() checks the
  // page again once the sheet's code is in, R3-01), and the list's keys and paste, which wait while it is open, never
  // wait on a sheet that is not drawn (AFMATCH-NOTES.md, AF-03).
  useEffect(() => setRemembering(null), [rememberHost]);
  useEffect(() => {
    if (remembering && !entries.some((e) => e.id === remembering.id)) setRemembering(null);
  }, [entries, remembering]);
  const siteNow = useRef(rememberHost);
  siteNow.current = rememberHost;
  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const selected = flat.find((r) => r.entry.id === sel) ?? flat[0] ?? null;

  // Codes in display order, so the first screen is worked out first; accounts the search hides come last.
  const ordered = useMemo(() => {
    const listed = new Set(flat.map((r) => r.entry.id));
    return [...flat.map((r) => r.entry), ...entries.filter((e) => !listed.has(e.id))];
  }, [flat, entries]);
  const { codes, now } = useCodes(ordered);
  // Another period's code for one account (List's arrows; the owner's request of 2026-11-18): `n` periods from the current
  // one, worked out for the period it falls in, again whenever that period changes. Copying that row copies it.
  const [shiftOf, setShiftOf] = useState<{ id: string; n: number } | null>(null);
  const [shiftCode, setShiftCode] = useState<string | undefined>();
  const shiftEntry = shiftOf ? entries.find((e) => e.id === shiftOf.id) : undefined;
  const shiftAt =
    shiftEntry && shiftOf ? (Math.floor(now / 1000 / shiftEntry.period) + shiftOf.n) * shiftEntry.period * 1000 : 0;
  const shiftRef = useRef<{ e: Entry; at: number } | null>(null);
  shiftRef.current = shiftEntry ? { e: shiftEntry, at: shiftAt } : null;
  const shiftId = shiftEntry
    ? `${shiftEntry.id} ${shiftEntry.secret} ${shiftEntry.digits} ${shiftEntry.algorithm}`
    : "";
  useEffect(() => {
    setShiftCode(undefined);
    const e = shiftRef.current?.e;
    if (!e) return;
    let live = true;
    codeAt(e, shiftAt).then(
      (c) => live && setShiftCode(c),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [shiftId, shiftAt]); // the account's code-making fields, not its object: a reload must not blank the code
  const onShift = useCallback((id: string, by: -1 | 1 | 0) => {
    setShiftOf((cur) => {
      const n = by === 0 ? 0 : Math.max(-10, Math.min(10, (cur?.id === id ? cur.n : 0) + by));
      return n === 0 ? null : { id, n };
    });
  }, []);
  // "Same sign-in", once there is a code to show, on a page no account is registered for, when some account has a site
  // (aliases.ts reads only the usable ones); asked again when the page or the accounts change, not on a reload of the same
  // ones. aliases.ts redraws the list when the answer comes within 300 ms and changes something
  const coded = codes.size > 0;
  useEffect(() => {
    const at = Date.now(); // the lookup's start: its 300 ms count the chunk's load too
    if (askAbout && coded && entries.some((e) => e.domains?.length))
      aliasView().then(
        (m) => {
          aliases.current = m;
          return m.ask(entries, askAbout, at, () => setAliasN((n) => n + 1));
        },
        () => undefined,
      );
  }, [askAbout, coded, accounts]);

  /** Show one hidden code for a few seconds. */
  const reveal = useCallback((id: string) => {
    setShownId(id);
    clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => setShownId(null), REVEAL_MS);
  }, []);
  useEffect(() => () => clearTimeout(revealTimer.current), []);

  const say = useCallback((msg: string, icon: IconName = "check", tone = "ok") => {
    setToast({ msg, icon, tone });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const copy = useCallback(
    async (e: Entry) => {
      if (!canGenerate(e)) return;
      // the page looks like this account's site and is not it: the first click warns, a second within 6 s copies
      if (fakeIds.current.has(e.id) && !(armed.current?.id === e.id && Date.now() - armed.current.at < 6000)) {
        armed.current = { id: e.id, at: Date.now() };
        say(t("fakeCopyAgain"), "alert", "bad");
        return;
      }
      armed.current = null;
      const sh = shiftRef.current?.e.id === e.id ? shiftRef.current : null; // shown at another period: that code
      const next = !sh && remaining(e, Date.now()) < 3;
      const code = await codeAt(e, sh ? sh.at : Date.now() + (next ? e.period * 1000 : 0));
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        say(t("copyFailed"), "alert", "bad");
        return;
      }
      countUse(e.id);
      setFlash(e.id);
      window.setTimeout(() => setFlash(null), 450);
      say(next ? t("copiedNext") : t("copiedFor", e.issuer));
      if (await armClipboardClear(code)) setClipUntil(Date.now() + CLEAR_AFTER_MS);
    },
    [say],
  );

  // Clipboard countdown text, and the "cleared" notice when it ends.
  const clipLeft = Math.max(0, Math.ceil((clipUntil - now) / 1000));
  const clipWas = useRef(false);
  useEffect(() => {
    if (clipLeft > 0) clipWas.current = true;
    else if (clipWas.current) {
      clipWas.current = false;
      say(t("clipboardCleared"), "clipboard", "info");
    }
  }, [clipLeft, say]);

  // Keyboard: arrows (and Home / End) move the selection and the focus between the rows' copy buttons, Enter copies,
  // Space shows a hidden code, "/" and Escape work the search (with no search, Escape ends choosing the page's account),
  // and typing anywhere else searches. The handler is added once and reads the latest state through a ref: re-adding it
  // in an effect lags a frame behind each render, so a key pressed straight after another would act on the previous
  // selection.
  const keyState = useRef({ flat, selected, view, editing, remembering, query, copy, hide, reveal, picking });
  keyState.current = { flat, selected, view, editing, remembering, query, copy, hide, reveal, picking };
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const { flat, selected, view, editing, remembering, query, copy, hide, reveal, picking } = keyState.current;
      if (view !== "list" || editing || remembering) return;
      const target = ev.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA";
      const onButton = target.tagName === "BUTTON";
      const rowEl = onButton ? target.closest<HTMLElement>(".row") : null;
      const onCopyButton = !!rowEl && target.classList.contains("copy");
      const step =
        ev.key === "ArrowDown" || ev.key === "ArrowUp" || (!inField && (ev.key === "Home" || ev.key === "End"));
      if (step) {
        if (!flat.length) return;
        const from = rowEl?.dataset.id ?? selected?.entry.id; // from the focused row, if the focus is in the list
        const i = Math.max(
          0,
          flat.findIndex((r) => r.entry.id === from),
        );
        const j =
          ev.key === "ArrowDown"
            ? Math.min(flat.length - 1, i + 1)
            : ev.key === "ArrowUp"
              ? Math.max(0, i - 1)
              : ev.key === "Home"
                ? 0
                : flat.length - 1;
        const id = flat[j]!.entry.id;
        setSel(id);
        const row = document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
        row?.querySelector<HTMLElement>(".copy")?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: "nearest" });
        ev.preventDefault();
      } else if (ev.key === "Enter") {
        if (onButton) return; // the focused button does its own thing (a copy button copies its row)
        if (selected) {
          void copy(selected.entry);
          ev.preventDefault();
        }
      } else if (ev.key === "Escape") {
        if (query) setQuery("");
        else if (picking) {
          // the row buttons go: the focus goes back to the line's button, as the View menu's Escape does to its own
          setPickFor(null);
          document.getElementById("ask-pick")?.focus();
          ev.preventDefault();
        }
      } else if (ev.key === "/" && !inField) {
        searchRef.current?.focus();
        ev.preventDefault();
      } else if (ev.key === " " && hide && !inField && (!onButton || onCopyButton)) {
        // Show, never copy: also stops a focused copy button from being pressed by the Space key. Other buttons keep Space.
        const id = rowEl?.dataset.id ?? selected?.entry.id;
        if (id) reveal(id);
        ev.preventDefault();
      } else if (
        ev.key.length === 1 &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !inField &&
        (!onButton || (rowEl && ev.key !== " "))
      ) {
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Ctrl+V anywhere but a text field (PHASE0X-PLAN B3): on the list and on "Add account" it opens the confirm page; on
  // the confirm page it adds to what is there (the next screenshot of a Google export). Pasting into the search box, or
  // into any other field, stays an ordinary paste. Nothing happens while the edit or "remember" sheet is open.
  const pasteState = useRef({ view, editing, remembering });
  pasteState.current = { view, editing, remembering };
  useEffect(() => {
    function onPaste(ev: ClipboardEvent) {
      const { view, editing, remembering } = pasteState.current;
      const target = ev.target as HTMLElement;
      if (editing || remembering || target.closest?.("input, textarea, select, [contenteditable]")) return;
      const input = inputOf(ev.clipboardData);
      if (!input) return;
      ev.preventDefault();
      if (view === "confirm") setAdding((a) => a && { ...a, inputs: [...a.inputs, input] });
      else openConfirm(input, view);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  function openConfirm(input: AddInput, from: "list" | "add") {
    setToast(null);
    setAdding({ inputs: [input], from, host: siteNow.current });
    setView("confirm");
    confirmPage().then(setConfirmMod, () => {
      setAdding(null);
      setView(from);
      say(t("errorTitle"), "alert", "bad");
    });
  }

  useEffect(() => {
    const e = copyAfter ? entries.find((x) => x.id === copyAfter) : undefined;
    if (!e) return;
    setCopyAfter(null);
    void copy(e);
  }, [copyAfter, entries, copy]);

  async function mutate(fn: Parameters<PopupRuntime["service"]["mutate"]>[0]) {
    await rt.service.mutate(fn);
    await reload();
  }

  // Grouping by name in one click (model.ts autoGroups; the owner's report of 2026-11-18), offered in the footer while
  // there is something to group and no search; undone from the same place while this popup stays open (or in Settings ›
  // Groups). One write each way, touching only the accounts it grouped that are still in the group it gave them.
  const grouping = useMemo(() => (q ? null : autoGroups(entries)), [entries, q]);
  // The accounts whose site this page looks like without being it (core/lookalike.ts), with the site it imitates: said at
  // the top, and copying one of their codes here takes a second click (`armed`) within a few seconds.
  const fakes = useMemo(
    () =>
      host
        ? entries.flatMap((e) => {
            const like = lookalikeOf(e, host);
            return like ? [{ e, like }] : [];
          })
        : [],
    [entries, host],
  );
  const fakeIds = useRef(new Set<string>());
  fakeIds.current = new Set(fakes.map((f) => f.e.id));
  const armed = useRef<{ id: string; at: number } | null>(null);
  const dups = useMemo(() => sameNames(entries), [entries]);
  const [grouped, setGrouped] = useState<Map<string, string> | null>(null);
  async function regroup(plan: Map<string, string>, undo: boolean) {
    try {
      await mutate((v, c) => {
        let next = v;
        for (const e of aliveEntries(v)) {
          const g = plan.get(e.id);
          if (g === undefined) continue;
          if (!undo && !e.group) next = setGroup(next, e.id, g, c);
          if (undo && e.group === g) next = setGroup(next, e.id, undefined, c);
        }
        return next;
      });
      setGrouped(undo ? null : plan);
      if (!undo) say(t("autoGrouped", new Set(plan.values()).size, plan.size));
    } catch {
      say(t("errorTitle"), "alert", "bad");
    }
  }

  /** Drag and drop: put `fromId` where `targetId` is, taking on its group. */
  async function move(fromId: string | null, targetId: string) {
    if (!fromId || fromId === targetId) return;
    const target = entries.find((e) => e.id === targetId);
    const moving = entries.find((e) => e.id === fromId);
    if (!target || !moving) return;
    const others = entries.filter((e) => e.id !== fromId);
    const to = others.findIndex((e) => e.id === targetId);
    await mutate((v, c) => {
      let next = moveEntry(v, fromId, to, c);
      if ((moving.group ?? "") !== (target.group ?? "")) next = setGroup(next, fromId, target.group, c);
      return next;
    });
  }

  function remember(id: string) {
    const h = rememberHost;
    if (!h) return;
    Promise.all([siteRules(), rememberSheet()]).then(
      ([m, sheet]) => {
        if (siteNow.current !== h) return; // the page changed while they loaded (the side panel): not its sheet
        const choices = m.domainChoices(h);
        setRememberMod(sheet);
        setRemembering({ id, choices, pick: m.preferredChoice(choices) ?? "" });
      },
      () => say(t("errorTitle"), "alert", "bad"),
    );
  }

  async function scan(from: "list" | "add") {
    const r = await scanTab();
    if (r.k === "found") openConfirm({ text: r.texts.join("\n") }, from);
    else if (r.k === "none") say(t("scanNone"), "scan", "info");
    else say(t("scanFailed"), "alert", "bad");
  }

  // "Open in side panel" (docs/design/notes/SIDEPANEL-NOTES.md): called in this click, which is the user action
  // sidePanel.open() needs, in this popup's window (known from the active tab read above); then the popup closes. The
  // panel's page is the one the service worker enables for a single-person profile (src/platform/action-mode.ts).
  function openPanel() {
    if (win.current !== undefined)
      chrome.sidePanel.open({ windowId: win.current }).then(
        () => window.close(),
        () => say(t("errorTitle"), "alert", "bad"),
      );
  }

  // The side panel's way back (the panel makes the icon open it, src/sidepanel/main.tsx): the icon opens the popup again,
  // written before the panel closes.
  function toPopup() {
    chrome.storage.local.remove("sk_opener").then(
      () => window.close(),
      () => say(t("errorTitle"), "alert", "bad"),
    );
  }

  async function ack(ev: StorageEvent) {
    await rt.service.ackEvents([ev.id]);
    setEvents(events.filter((x) => x.id !== ev.id));
  }

  const toastEl = toast && (
    <div class={`toast ${toast.tone}`} role="status" key={toast.msg}>
      <span class="tk">
        <Icon name={toast.icon} size={14} />
      </span>
      <span>{toast.msg}</span>
    </div>
  );

  if (view === "confirm" && adding) {
    const back = () => {
      setAdding(null);
      setView(adding.from);
    };
    return (
      <>
        {confirmMod ? (
          <confirmMod.AddConfirm
            inputs={adding.inputs}
            entries={entries}
            host={adding.host}
            tickSite={(issuer) => firmGuess(issuer, adding.host)}
            mutate={mutate}
            openSettings={openOptions}
            onBack={back}
            onDone={(r) => {
              setAdding(null);
              setView("list");
              if (r.copyId) setCopyAfter(r.copyId);
              else if (r.added) say(r.added === 1 && r.name ? t("paAdded", r.name) : t("addedN", r.added));
            }}
          />
        ) : (
          <div class="ph" />
        )}
        {toastEl}
      </>
    );
  }

  if (view === "add") {
    return (
      <>
        {addMod ? (
          <addMod.AddMenu
            onBack={() => setView("list")}
            onScan={() => scan("add")}
            onInput={(input) => openConfirm(input, "add")}
          />
        ) : (
          <div class="ph" />
        )}
        {toastEl}
      </>
    );
  }

  const lastBackupOld = screen.lastBackup === null || Date.now() - screen.lastBackup > BACKUP_REMINDER_MS;
  const count = entries.length === 1 ? t("countOne") : t("count", entries.length);
  const editEntryObj = editing ? entries.find((e) => e.id === editing) : undefined;
  const rememberObj = remembering ? entries.find((e) => e.id === remembering.id) : undefined;

  return (
    <>
      <div class="ph">
        <Brand />
        {(() => {
          const local = (
            <span class="loc" title={t("trustLocal")}>
              <Icon name="device" size={12} />
              {t("localOnly")}
            </span>
          );
          return csbMod ? (
            <csbMod.Pill also={screen.also} mark={screen.mark}>
              {local}
            </csbMod.Pill>
          ) : (
            local
          );
        })()}
        <span class="sp" />
        <LangToggle />
        {screen.protected && (
          // Lock now: the soft lock (a live PIN reopens Sixkey), then the lock screen at once, with the focus in it
          <button
            class="tb"
            id="lock-now"
            aria-label={t("lock")}
            title={lockKey ? `${t("lock")} (${lockKey})` : t("lock")}
            aria-keyshortcuts={lockKey && /^[\w+]+$/.test(lockKey) ? lockKey : undefined}
            onClick={async () => {
              await rt.service.lock();
              await reload();
            }}
          >
            <Icon name="lock" />
          </button>
        )}
        {!surface.panel && typeof chrome.sidePanel?.open == "function" && profileOf(screen.settings) == "solo" && (
          // not in a shared profile, nor where the browser has no side panel (SIDEPANEL-NOTES.md)
          <button class="tb" id="open-panel" aria-label={t("openPanel")} title={t("openPanel")} onClick={openPanel}>
            <Icon name="panel" />
          </button>
        )}
        {surface.panel && (
          <button class="tb" id="to-popup" aria-label={t("toPopup")} title={t("toPopup")} onClick={toPopup}>
            <Icon name="panel" />
          </button>
        )}
        <button class="tb" aria-label={t("settings")} title={t("settings")} onClick={() => openOptions()}>
          <Icon name="sliders" />
        </button>
      </div>

      <div class="search">
        <Icon name="search" />
        <input
          ref={searchRef}
          id="q"
          type="text"
          autocomplete="off"
          spellcheck={false}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          value={query}
          onInput={(e) => {
            setQuery((e.target as HTMLInputElement).value);
            setSel(null);
          }}
        />
        {query ? (
          <button
            class="clear"
            aria-label={t("clearSearch")}
            title={t("clearSearch")}
            onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }}
          >
            <Icon name="x" size={14} />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
        <button
          class="tb"
          id="view-toggle"
          aria-label={t("lookTitle")}
          title={t("lookTitle")}
          aria-haspopup="dialog"
          aria-expanded={!!Menu}
          onClick={() =>
            Menu
              ? setMenu(null)
              : viewMenu().then(
                  (m) => setMenu(() => m.ViewMenu),
                  () => say(t("errorTitle"), "alert", "bad"),
                )
          }
        >
          <Icon name="sun" size={18} />
        </button>
      </div>
      {Menu && <Menu rt={rt} display={display} reload={reload} onClose={() => setMenu(null)} />}

      <Notices events={events} onAck={ack} noPassword={!screen.protected && entries.length > 0} extra={extra} />
      {fakes.length > 0 && (
        <div class="note bad" role="alert" id="site-fake">
          <span class="ni">
            <Icon name="alert" size={16} />
          </span>
          <span class="nt">
            <b>{t("fakeSiteTitle")}</b>
            <span>
              {t("fakeSite", host ?? "", fakes[0]!.e.issuer || fakes[0]!.e.label, fakes[0]!.like)}
              {fakes.length > 1 ? ` ${t("fakeSiteMore", fakes.length - 1)}` : ""}
            </span>
          </span>
        </div>
      )}
      {plainHttp && fakes.length === 0 && (
        <div class="note warn" role="status" id="site-http">
          <span class="ni">
            <Icon name="alert" size={16} />
          </span>
          <span class="nt">
            <b>{t("httpSiteTitle")}</b>
            <span>{t("httpSite", host ?? "")}</span>
          </span>
        </div>
      )}

      {fillMod && site && <fillMod.FillBar host={site.label} rows={site.rows} />}
      {fillMod && (site || resume) && (
        <fillMod.Resume nonce={resume} ready={tabHost !== undefined} rows={site?.rows ?? []} />
      )}

      {tabHost !== undefined ? (
        <List
          sections={sections}
          hasEntries={entries.length > 0}
          selectedId={selected?.entry.id ?? null}
          codes={codes}
          now={now}
          flash={flash}
          canDrag={!q && display.sort === "manual"}
          compact={display.density === "compact"}
          hide={display.hideCodes}
          shownId={shownId}
          dups={dups}
          shift={shiftOf ? { ...shiftOf, ...(shiftCode ? { code: shiftCode } : {}) } : null}
          onShift={onShift}
          onHover={setSel}
          onCopy={copy}
          onEdit={setEditing}
          onMove={move}
          onReveal={reveal}
          rememberHost={rememberHost}
          onRemember={remember}
          ask={askAbout}
          picking={picking}
          onPick={() => setPickFor(picking ? null : askAbout)}
          onPaste={() => {
            setToast(null);
            setView("add");
          }}
          onScan={() => void scan("list")}
          rowExtra={fillMod && ((e, i) => <fillMod.RowFill entry={e} first={i === 0} />)}
          pasteKey={pasteKey()}
        />
      ) : (
        <div class="list" id="list" />
      )}

      <div class="pf">
        {clipLeft > 0 ? (
          <div class="clip" style={`--p:${Math.min(1, clipLeft / (CLEAR_AFTER_MS / 1000))}`}>
            <Icon name="clipboard" size={14} />
            <span>{t("clipboardClears", clipLeft)}</span>
            <i aria-hidden="true" />
          </div>
        ) : (
          entries.length > 0 &&
          (() => {
            const plain = (
              <span class="bk">
                <span class="dot" />
                {count}
              </span>
            );
            const own = lastBackupOld ? (
              <a
                href="#"
                class="bk old"
                onClick={(ev) => {
                  ev.preventDefault();
                  openOptions("#backup");
                }}
              >
                <span class="dot" />
                {count} · <u>{t("backupNow")}</u>
              </a>
            ) : (
              plain
            );
            return csbMod ? (
              // the one click turns the backup in Chrome sync on: in a profile only the person uses, never by this nudge
              // in a shared one, which keeps its local reminder
              <csbMod.Foot
                also={screen.also}
                mark={screen.mark}
                count={count}
                due={lastBackupOld && profileOf(screen.settings) === "solo"}
                open={openOptions}
              >
                {own}
              </csbMod.Foot>
            ) : csbMod === false ? (
              own
            ) : (
              plain
            );
          })()
        )}
        <span class="sp" />
        {grouped ? (
          <button class="btn sm ghost" id="auto-undo" onClick={() => void regroup(grouped, true)}>
            {t("autoGroupUndo")}
          </button>
        ) : (
          grouping &&
          grouping.size > 0 && (
            <button
              class="btn sm ghost"
              id="auto-group"
              title={t("autoGroupTip")}
              onClick={() => void regroup(grouping, false)}
            >
              {t("autoGroup")}
            </button>
          )
        )}
        <button
          class="btn sm add"
          onClick={() => {
            setToast(null);
            setView("add");
          }}
        >
          <Icon name="plus" />
          {t("add")}
        </button>
      </div>

      {toastEl}

      {editEntryObj && editMod && (
        <editMod.EditDialog
          entry={editEntryObj}
          groups={[...new Set(entries.map((e) => e.group).filter((g): g is string => !!g))]}
          host={rememberHost}
          onClose={() => setEditing(null)}
          onSave={async (update) => {
            // only what the user changed on the sheet (EditDialog, edit-save.ts: wave 2b r3)
            if (update) await mutate(update);
            setEditing(null);
          }}
          onDelete={async () => {
            await mutate((v, c) => deleteEntry(v, editEntryObj.id, c));
            setEditing(null);
            say(t("movedToTrash"), "trash", "info");
          }}
        />
      )}

      {remembering && rememberObj && rememberHost && rememberMod && (
        <rememberMod.RememberSheet
          entry={rememberObj}
          host={rememberHost}
          choices={remembering.choices}
          pick={remembering.pick}
          onClose={() => setRemembering(null)}
          onSave={async (domains, chosen) => {
            try {
              await mutate((v, c) => editEntry(v, rememberObj.id, { domains }, c));
              say(t("siteRemembered", chosen));
            } catch {
              say(t("errorTitle"), "alert", "bad");
            }
            setRemembering(null);
          }}
        />
      )}
    </>
  );
}
