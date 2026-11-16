// The in-page suggestion (TOTP autofill Stage 2, patch 4b; docs/design/notes/AUTOFILL2-NOTES.md §13): the content script's
// part with the release gate open (scripts/suggest-ui.mjs; ./suggest.ts calls it only then, and a build with the gate closed
// has none of it: scripts/suggest-guard.mjs). After the user's own click or key press in a site's code box, on a site they
// turned on, "Fill code with Sixkey · <host>" just below the box; its click opens Sixkey's own popup or side panel (never a
// fill), once in a document.
//
// Hardened as TOTP-AUTOFILL §4.5 items 1–7, revised by the patch 4 plan (r3):
//   1. the top frame only, and only where the worker answered `cand` with `{show: true}` (a site listed and granted, Autofill
//      on; the worker's checks, platform/content-page.ts);
//   2. a `sixkey-suggest` element appended to `document.documentElement` (not body: a hidden body hides what is in it),
//      with a closed shadow root, a `popover="manual"` in the top layer, and a stylesheet whose every declaration is
//      `!important` (the inner context's `!important` wins over the page's): reset `:host`, visible, opaque, unfiltered,
//      untransformed, the generic font families only (a page's @font-face cannot take a generic name), its own cursor;
//   3. armed only when IntersectionObserver v2 has seen all of it for 800 ms without a break (./suggest-arm.ts), at full
//      size (a page's `zoom` cannot shrink it to a speck), and the clock starts again when it moves, when a page top-layer
//      element is toggled over its place, and when the page holds its rendering (its frames stop for more than 250 ms, or
//      a view transition is running): what was on the screen meanwhile was a frozen picture; every showing, at another
//      box while shown included, waits for IntersectionObserver's own first report at its place;
//   4. a click counts only when trusted and armed, with what IntersectionObserver has not reported yet read first
//      (`takeRecords`); from a pointer, after a trusted pointerdown on the same button, with Sixkey's host the first element
//      at the pointer; the button never takes the focus (so a page cannot make a key its click);
//   5. any change to its host's attributes, or its host taken out of the page (moved, removed, a replaced root,
//      document.open()), ends it for the document;
//   6. never shown on the page's own focus or events: only on the user's (./suggest-core.ts boxOf), and never where the box
//      is in a modal dialog or the page's root is inert (it could not be clicked there): the worker is still asked, so
//      its badge says the toolbar icon fills;
//   7. its words name the host (chrome.i18n, the browser's language).
// Esc or × dismisses it for the document; a click elsewhere, or two minutes without the user's input, hides it until the
// next look; a refused click changes nothing but, refused as too early or on a held page, its words: for a few seconds,
// and from the second such click in a row until it arms.
// The worker's answer is waited for ASK_MS at most, and a later one counts as none (asked again at the next look).
import { arming, ASK_MS, CUE_MS, fullSize, IDLE_MS, judge, meet, place, readAnswer, type Answer } from "./suggest-arm";
import { boxOf, qualifies, type Finder } from "./suggest-core";

// The e2e build's record of every decision, for its tests (scripts/build.mjs `__SUGGEST_DBG__`, e2e only; check-dist
// refuses it in every other build). In the content script's own world: the page cannot see it.
declare const __SUGGEST_DBG__: boolean;
const DBG = typeof __SUGGEST_DBG__ === "boolean" && __SUGGEST_DBG__;

/** How often the page may be looked at, at most (as ./suggest-core.ts's). */
const LOOK_MS = 2000;

const IMP = "!important";
const CSS = [
  `:host{all:initial${IMP};display:block${IMP};position:static${IMP};visibility:visible${IMP}}`,
  `#p{all:initial${IMP};position:fixed${IMP};margin:0${IMP};padding:0${IMP};border:0${IMP};display:flex${IMP};gap:2px${IMP};` +
    `visibility:visible${IMP};opacity:1${IMP};filter:none${IMP};transform:none${IMP};clip-path:none${IMP};` +
    `overflow:visible${IMP};cursor:default${IMP};direction:ltr${IMP}}`,
  `#p:not(:popover-open){display:none${IMP}}`,
  `button{all:initial${IMP};box-sizing:border-box${IMP};min-height:32px${IMP};display:inline-flex${IMP};` +
    `align-items:center${IMP};padding:6px 10px${IMP};border-radius:8px${IMP};background:#1d5fbf${IMP};color:#fff${IMP};` +
    `font:600 13px/1.3 system-ui,sans-serif${IMP};cursor:pointer${IMP};visibility:visible${IMP};opacity:1${IMP};` +
    `max-width:min(420px,calc(100vw - 16px))${IMP};user-select:none${IMP}}`,
  // nothing of its own drawn over the button, a shadow included: IntersectionObserver v2 counts that as covering it
  `#b{box-shadow:0 2px 8px #0005${IMP}}`,
  `#x{min-width:24px${IMP};padding:0 6px${IMP};justify-content:center${IMP}}`,
  `#l{position:absolute${IMP};left:0${IMP};top:100%${IMP};width:1px${IMP};height:1px${IMP};overflow:hidden${IMP};` +
    `clip-path:inset(50%)${IMP}}`,
  `@media (forced-colors:active){button{background:ButtonFace${IMP};color:ButtonText${IMP};border:1px solid ButtonText${IMP}}}`,
].join("");
/** Not armed yet: the same words, drawn quieter, with no pointer cursor (no opacity: IntersectionObserver v2 would not see it). */
const IDLE = `#b{background:#7d97c4${IMP};cursor:default${IMP}}`;

export function startSuggestion(finder: () => Finder | undefined): void {
  if (window !== window.top) return; // the top frame only
  const now = () => performance.now();
  const log: string[] = [];
  const note = (d: string) => void (DBG && log.push(d));
  const asks: string[] = []; // the e2e build's record of `cand` and its answers
  const ask = (d: string) => void (DBG && asks.push(d));
  const answers = new Map<string, Answer>(); // per page address (its hash aside)
  const asked = new Map<string, { n: number; at: number }>(); // asked, the answer not in yet: which ask, and when
  let askN = 0;
  let seenBox: HTMLInputElement | null = null; // the last box the finder named: looked at again without a new look
  let lastInput = -Infinity; // the user's own last click or key press
  let cueUntil = 0; // the button says "a moment" until then (Infinity: the shortcut's line, until it arms or hides)
  let inRow = 0; // clicks refused as too early or held in a row, in this showing
  const page = () => location.href.split("#")[0]!;
  let looked = -Infinity;
  let ended = false; // dismissed, used or tampered with: nothing more in this document
  // `width`: the suggestion's own, with its words (not the cue's): its place on a right-to-left page is taken from it
  let shown: { box: HTMLInputElement; page: string; rtl: boolean; width: number } | null = null;
  let line = ""; // what the live region says while it is shown (put back after a cue)
  let downHere = false; // the last trusted pointerdown went down on the suggestion's button
  let ui: ReturnType<typeof build> | null = null;
  const arm = arming(now);

  function build() {
    const host = document.createElement("sixkey-suggest");
    const root = host.attachShadow({ mode: "closed" });
    const base = new CSSStyleSheet();
    base.replaceSync(CSS);
    const idle = new CSSStyleSheet();
    idle.replaceSync(IDLE);
    const pos = new CSSStyleSheet();
    const hold = new CSSStyleSheet(); // while a cue is up: at least as wide as with its own words (cue, uncue)
    root.adoptedStyleSheets = [base, idle, pos, hold];
    const pop = document.createElement("div");
    pop.id = "p";
    pop.popover = "manual";
    pop.dir = "ltr";
    const pill = document.createElement("button");
    pill.id = "b";
    pill.type = "button";
    pill.tabIndex = -1;
    const [a = "Fill code with Sixkey · ", b = ""] = (chrome.i18n.getMessage("afSugFill", ["\u0001"]) || "").split(
      "\u0001",
    );
    const bdi = document.createElement("bdi");
    bdi.append(location.hostname);
    const label = [a, bdi, b];
    pill.append(...label);
    const x = document.createElement("button");
    x.id = "x";
    x.type = "button";
    x.tabIndex = -1;
    x.ariaLabel = x.title = chrome.i18n.getMessage("afSugNo") || "Not now";
    x.append("×");
    const live = document.createElement("div");
    live.id = "l";
    live.role = "status";
    live.ariaLive = "polite";
    pop.append(pill, x, live);
    root.append(pop);
    document.documentElement.append(host);
    const io = new IntersectionObserver((rs) => rs.forEach((r) => arm.seen(whole(r))), {
      threshold: [1],
      trackVisibility: true,
      delay: 100,
    } as IntersectionObserverInit);
    io.observe(pill);
    // 5: its host's attributes changed, or the host out of the page (removed, a replaced root, document.open())
    new MutationObserver(() => void (ended || end("tamper"))).observe(host, { attributes: true });
    const gone = new MutationObserver((rs) => {
      const out = rs.some((r) => Array.prototype.includes.call(r.removedNodes, host));
      if (!ended && (out || host.parentNode !== document.documentElement)) end("tamper");
    });
    gone.observe(document, { childList: true, subtree: false });
    gone.observe(document.documentElement, { childList: true });
    pill.addEventListener("pointerdown", (e) => {
      if (e.isTrusted) downHere = true;
      e.preventDefault(); // the focus stays in the code box
    });
    pill.addEventListener("mousedown", (e) => e.preventDefault());
    x.addEventListener("pointerdown", (e) => e.preventDefault());
    x.addEventListener("mousedown", (e) => e.preventDefault());
    pill.addEventListener("click", (e) => clicked(e));
    x.addEventListener("click", (e) => e.isTrusted && end("x"));
    return { host, root, pop, pill, live, idle, pos, hold, io, label };
  }

  /** IntersectionObserver v2's "all of it, and visible". */
  const whole = (r: IntersectionObserverEntry) =>
    (r as IntersectionObserverEntry & { isVisible?: boolean }).isVisible === true && r.intersectionRatio >= 0.99;

  /** Drawn at full size now (a page's `zoom`, or anything else that shrinks it, makes it too small to count). */
  const big = (pill: HTMLElement) =>
    fullSize(
      (pill as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1,
      pill.getBoundingClientRect().height,
    );
  /** A view transition holds the page: what is on the screen is its pictures, not the page (S-7). */
  const transition = () => document.documentElement?.matches(":active-view-transition") ?? false;
  /** Armed, at full size and drawn now: drawn as clickable (and, in the e2e build, what its record calls armed). */
  const ready = () => !!ui && arm.armed() && arm.fresh() && !transition() && big(ui.pill);

  function clicked(e: MouseEvent): void {
    if (!ui) return;
    const at = now();
    const pending = ui.io.takeRecords();
    pending.forEach((r) => arm.seen(whole(r), at));
    const v = judge({
      trusted: e.isTrusted,
      detail: e.detail,
      used: ended,
      pendingHidden: pending.some((p) => !whole(p)),
      visible: arm.visible(),
      armed: arm.armed(at),
      fresh: arm.fresh(at) && !transition(),
      fullSize: big(ui.pill),
      downHere,
      topIsHost: document.elementsFromPoint(e.clientX, e.clientY)[0] === ui.host,
    });
    downHere = false;
    if (v === "early" || v === "stale") cue(at);
    else inRow = 0; // another reason (or the open) breaks the row
    if (v !== "open") return note(`refused:${v}`);
    // the one message of a click, sent in the click itself (the side panel needs its gesture); never answered
    ended = true;
    hide();
    note("open");
    try {
      void chrome.runtime.sendMessage({ type: "sk-af-open" }).catch(() => undefined);
    } catch {
      /* no extension context any more */
    }
  }

  /**
   * A dead click explains itself. The first such refusal says to wait, for CUE_MS. The second in a row (4B-FU3, the 4B-FU2
   * review: a busy page can keep it from arming) says what works instead, the shortcut's line (its tooltip's words: the
   * shortcut, or "open Sixkey"), and keeps saying it until it arms, or is hidden. The frame loop puts the words back.
   *
   * Meanwhile the suggestion is held at least at the width it has with its own words (4B-FU3-r2, the review's C-N2): its
   * button stretches to it. So giving its words back can keep or shrink it, never widen it into an area that was not seen
   * for 800 ms, whether that happens in the frame it arms or later. Its place, and so its clock, does not change with it.
   */
  function cue(at: number): void {
    if (!ui) return;
    const words = ++inRow >= 2 ? line : chrome.i18n.getMessage("afSugWait") || "One moment, then click again";
    cueUntil = inRow >= 2 ? Infinity : at + CUE_MS;
    ui.pill.replaceChildren(words);
    ui.live.replaceChildren(words);
    if (shown && shown.width > 0) ui.hold.replaceSync(`#p{min-width:${shown.width}px${IMP}}#b{flex-grow:1${IMP}}`);
  }
  function uncue(): void {
    if (!ui || !cueUntil) return;
    cueUntil = 0;
    ui.pill.replaceChildren(...ui.label);
    ui.live.replaceChildren(line);
    ui.hold.replaceSync("");
  }

  function hide(): void {
    if (!ui || !shown) return;
    shown = null;
    uncue();
    inRow = 0;
    arm.seen(false);
    try {
      ui.pop.hidePopover();
    } catch {
      /* already hidden */
    }
  }
  function end(why: string): void {
    ended = true;
    hide();
    note(`end:${why}`);
  }

  /** The box, or its group (6 or 8 boxes with one token): what the suggestion goes under. */
  function anchor(box: HTMLInputElement) {
    const f = finder();
    const t = f?.of(box);
    const group = t && box.form ? [...box.form.querySelectorAll("input")].filter((i) => f!.of(i) === t) : [box];
    const rs = (group.length ? group : [box]).map((i) => i.getBoundingClientRect());
    return {
      left: Math.min(...rs.map((r) => r.left)),
      top: Math.min(...rs.map((r) => r.top)),
      right: Math.max(...rs.map((r) => r.right)),
      bottom: Math.max(...rs.map((r) => r.bottom)),
    };
  }

  let at = "";
  let armedDrawn = false;
  let loop = 0; // the frame loop's generation: each showing starts its own, and an older one stops at its next frame
  /** While shown, once a frame: follow the box, end at a new address or a box gone, and draw armed or not. */
  function frame(g = loop): void {
    if (g !== loop || !ui || !shown || ended) return;
    arm.frame();
    if (transition()) arm.restart();
    const s = shown;
    if (page() !== s.page || !s.box.isConnected) return hide();
    // two minutes without the user's own input: hidden, and the frames stop (the next look shows it again)
    if (now() - lastInput > IDLE_MS) return (note("idle"), hide());
    if (cueUntil && now() >= cueUntil) uncue();
    const box = anchor(s.box);
    const w = innerWidth;
    const h = innerHeight;
    if (box.bottom <= 0 || box.top >= h || box.right <= 0 || box.left >= w || box.bottom - box.top <= 0) return hide();
    const p = ui.pop.getBoundingClientRect();
    // its width with its own words: a cue's other width would move it on a right-to-left page, and restart its clock
    if (!cueUntil || s.width < 0) s.width = p.width;
    const { left, top } = place(box, { width: s.width, height: p.height }, { width: w, height: h }, s.rtl);
    const next = `#p{left:${left}px${IMP};top:${top}px${IMP}}`;
    if (next !== at) {
      if (at) arm.restart(); // moved: the 800 ms again (a box moved under the pointer is not a click aimed at Sixkey)
      at = next;
      ui.pos.replaceSync(next);
    }
    const armed = ready();
    // armed: the row of refusals is over, and the shortcut's line gives the button its words back
    if (armed) {
      inRow = 0;
      if (cueUntil === Infinity) uncue();
    }
    if (armed !== armedDrawn) {
      armedDrawn = armed;
      ui.root.adoptedStyleSheets = armed
        ? [ui.root.adoptedStyleSheets[0]!, ui.pos, ui.hold]
        : [ui.root.adoptedStyleSheets[0]!, ui.idle, ui.pos, ui.hold];
    }
    requestAnimationFrame(() => frame(g));
  }

  function show(box: HTMLInputElement, a: Extract<Answer, { show: true }>): void {
    if (ended || shown?.box === box) return;
    if (blocked(box)) return note("blocked"); // the worker's badge only (it answered: the toolbar icon fills)
    ui ??= build();
    line = a.key ? chrome.i18n.getMessage("afCanFill", [a.key]) : chrome.i18n.getMessage("afCanFillOpen");
    ui.pill.title = line;
    ui.live.replaceChildren(line);
    // its direction, read once (not a style read in every frame: S-2)
    shown = { box, page: page(), rtl: getComputedStyle(box).direction === "rtl", width: -1 };
    at = "";
    armedDrawn = true; // drawn idle at the first frame
    // Every showing is a new one (4B-FU4, the review's P-M1), also at another box while shown (a key there) and when
    // hidden and shown again in one task (a click there): its own words, a row of refusals of its own, and its clock from
    // IntersectionObserver's first report at this place. Observed afresh, as the same target observed again would get no
    // report (and when nothing changed between a hide and a show in one task, IntersectionObserver reports nothing).
    inRow = 0;
    uncue();
    arm.seen(false);
    try {
      ui.pop.showPopover();
    } catch {
      return void (shown = null);
    }
    ui.io.unobserve(ui.pill);
    ui.io.observe(ui.pill);
    note("show");
    loop++;
    frame();
  }

  /** The box is in an open modal dialog (through shadow roots), or the page's root is inert: nothing could be clicked there. */
  function blocked(el: Element): boolean {
    if (document.documentElement.inert) return true;
    for (let n: Node | null = el; n; n = n instanceof ShadowRoot ? n.host : n.parentNode)
      if (n instanceof HTMLDialogElement && n.matches(":modal")) return true;
    return false;
  }

  function lookAt(e: Event): void {
    const el = boxOf(e as Event & { isTrusted: boolean; target: unknown });
    if (!el || ended) return;
    const p = page();
    const known = answers.get(p);
    // the box the finder named before, its page answered: no new look, nor the 2 s between looks (N-2)
    if (known && el === seenBox) return void (known.show && show(el, known));
    const f = finder();
    if (!f || now() - looked < LOOK_MS) return;
    looked = now();
    if (!qualifies(f, el)) return;
    seenBox = el;
    if (known) return void (known.show && show(el, known));
    const pending = asked.get(p);
    if (pending && now() - pending.at < ASK_MS) return; // asked, and its answer not overdue yet
    const mine = { n: ++askN, at: now() };
    asked.set(p, mine);
    let sent: Promise<unknown>;
    try {
      sent = chrome.runtime.sendMessage({ type: "sk-af-cand" });
    } catch {
      return void asked.delete(p); // no extension context any more
    }
    ask("cand");
    // an answer after ASK_MS, or to an ask made again since, counts as none, and is not kept
    const current = () => asked.get(p) === mine && now() - mine.at <= ASK_MS;
    sent.then(
      (r) => {
        if (!current()) return void (ask("late"), asked.get(p) === mine && asked.delete(p));
        asked.delete(p);
        const a = readAnswer(r);
        ask(a ? (a.show ? "show" : "no") : "bad");
        if (!a) return; // no answer (a worker restarted): asked again at the next look
        answers.set(p, a);
        if (a.show && page() === p) show(el, a);
      },
      () => {
        ask("error");
        if (asked.get(p) === mine) asked.delete(p);
      },
    );
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isTrusted) return;
      lastInput = now();
      downHere = false; // the button's own listener, after this one, says when it went down there
      // a click outside the box and the suggestion hides it until the next look (not a dismissal)
      if (shown && e.target !== ui?.host && e.target !== shown.box) hide();
      lookAt(e);
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      lastInput = now();
      // Esc dismisses it for the document, and is consumed only while it is shown
      if (shown && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return end("esc");
      }
      lookAt(e);
    },
    true,
  );
  // a page top-layer element (a popover, a dialog) toggled over its place, or a fullscreen element: the 800 ms again (S-7).
  // The page's own shadow roots send none of these to the document; IntersectionObserver is what covers those (§14)
  const near = (e: Event) => {
    if (!shown || !ui || !(e.target instanceof Element)) return;
    if (meet(e.target.getBoundingClientRect(), ui.pill.getBoundingClientRect())) arm.restart();
  };
  document.addEventListener("beforetoggle", near, true);
  document.addEventListener("toggle", near, true);
  document.addEventListener("fullscreenchange", () => arm.restart(), true);
  addEventListener("pagehide", () => hide());
  document.addEventListener("visibilitychange", () => document.visibilityState !== "visible" && hide());
  if (DBG)
    (globalThis as { __skSugLog?: unknown }).__skSugLog = {
      log,
      asks,
      pill: () => ui?.pill ?? null,
      root: () => ui?.root ?? null,
      host: () => ui?.host ?? null,
      shown: () => shown !== null,
      armed: () => ready(),
      seen: () => arm.visible(), // IntersectionObserver has reported it whole, its clock running
    };
}
