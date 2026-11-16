// A minimal page for the in-page suggestion's unit tests (src/inject/suggest-ui.ts; AUTOFILL2-NOTES.md §13.8): just enough
// of the DOM and of the browser for the content script's own code to run in Node, with a clock, frames, the observers'
// reports and the worker's answers all in the test's hands. Each test mounts a fresh page (its globals set, then removed);
// the module is imported once, with the e2e build's record of decisions on (`__SUGGEST_DBG__`), which the tests read.
//
// What is real: suggest-ui.ts, suggest-arm.ts and suggest-core.ts, unchanged. What is not: layout (each element has a
// fixed rect), the cascade (getComputedStyle answers `direction` only), and event dispatch (the helpers call the listeners
// the code registered, in the browser's order for the events they make).
import { vi } from "vitest";

type Listener = (e: Ev) => void;
export type Ev = {
  type: string;
  isTrusted: boolean;
  target: unknown;
  composedPath: () => unknown[];
  clientX: number;
  clientY: number;
  detail: number;
  key: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};
type Rec = { type: "childList" | "attributes"; addedNodes: Node[]; removedNodes: Node[] };

let env: Env | undefined;
type Env = {
  t: number;
  raf: ((t: number) => void)[];
  sent: { m: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }[];
  ios: FIO[];
  mos: FMO[];
  styleReads: number;
  transition: boolean;
  document: FDocument;
  hit: () => unknown[];
};
const E = () => env!;

class Node {
  parentNode: Node | null = null;
  childNodes: Node[] = [];
  listeners = new Map<string, Listener[]>();
  get isConnected(): boolean {
    for (let n: Node | null = this; n; n = n instanceof ShadowRoot ? n.host : n.parentNode)
      if (n === E().document) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  append(...nodes: (Node | string)[]): void {
    for (const n of nodes) this.insert(typeof n === "string" ? new Text(n) : n);
  }
  insert(n: Node): void {
    if (n.parentNode) n.parentNode.removeChild(n);
    n.parentNode = this;
    this.childNodes.push(n);
    mutated(this, { type: "childList", addedNodes: [n], removedNodes: [] });
  }
  removeChild(n: Node): void {
    const i = this.childNodes.indexOf(n);
    if (i < 0) return;
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    mutated(this, { type: "childList", addedNodes: [], removedNodes: [n] });
  }
  replaceChildren(...nodes: (Node | string)[]): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type: string, f: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  emit(type: string, e: Ev): void {
    for (const f of this.listeners.get(type) ?? []) f(e);
  }
}
class Text extends Node {
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
}
class Element extends Node {
  id = "";
  popover: string | null = null;
  open = false;
  inert = false;
  modal = false;
  shadow: ShadowRoot | null = null;
  rect = { x: 0, y: 0, width: 0, height: 0 };
  constructor(public tagName: string) {
    super();
    if (tagName === "BUTTON") this.rect = { x: 100, y: 134, width: 240, height: 32 };
  }
  getBoundingClientRect() {
    // the popover's width follows its button's words (8 px a character): a cue of other words is another width; and at
    // least a `#p{min-width:…px}` of its root's adopted sheets (the hold while a cue is up)
    if (this.id === "p") {
      const b = this.childNodes.find((c) => c instanceof Element && c.id === "b");
      const root = this.parentNode instanceof ShadowRoot ? this.parentNode : null;
      const min = Math.max(
        0,
        ...(root?.adoptedStyleSheets ?? []).map((x) =>
          Number(/#p\{min-width:([\d.]+)px/.exec((x as CSSStyleSheet).text)?.[1] ?? 0),
        ),
      );
      return {
        x: 0,
        y: 0,
        width: Math.max(min, 8 * (b?.textContent.length ?? 0) + 30),
        height: 32,
        left: 0,
        top: 0,
        right: 0,
        bottom: 32,
      };
    }
    const r = this.rect;
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
  }
  attachShadow(): ShadowRoot {
    return (this.shadow = new ShadowRoot(this));
  }
  showPopover(): void {
    if (this.popover === null) throw new Error("NotSupportedError: not a popover");
    this.open = true;
  }
  hidePopover(): void {
    this.open = false;
  }
  matches(sel: string): boolean {
    if (sel === ":modal") return this.modal;
    if (sel === ":active-view-transition") return E().transition;
    return false;
  }
}
class ShadowRoot extends Node {
  adoptedStyleSheets: unknown[] = [];
  constructor(public host: Element) {
    super();
  }
  getElementById(id: string): Element | null {
    const walk = (n: Node): Element | null => {
      if (n instanceof Element && n.id === id) return n;
      for (const c of n.childNodes) {
        const f = walk(c);
        if (f) return f;
      }
      return null;
    };
    return walk(this);
  }
}
class HTMLInputElement extends Element {
  type = "text";
  readOnly = false;
  disabled = false;
  form = null;
  dirStyle = "ltr";
  constructor() {
    super("INPUT");
    this.rect = { x: 100, y: 100, width: 200, height: 30 };
  }
}
class HTMLDialogElement extends Element {
  constructor() {
    super("DIALOG");
  }
}
class FDocument extends Node {
  documentElement = new Element("HTML");
  body = new Element("BODY");
  visibilityState = "visible";
  constructor() {
    super();
    this.insert(this.documentElement);
    this.documentElement.insert(this.body);
  }
  createElement(tag: string): Element {
    const t = tag.toUpperCase();
    return t === "INPUT" ? new HTMLInputElement() : t === "DIALOG" ? new HTMLDialogElement() : new Element(t);
  }
  elementsFromPoint(): unknown[] {
    return E().hit();
  }
}
class CSSStyleSheet {
  text = "";
  replaceSync(t: string): void {
    this.text = t;
  }
}
// As IntersectionObserver itself: observing a target it observes already does nothing (no new first report); a target
// observed afresh gets a first report, whatever it was before (`fresh`, `last`: what the test's `report()` goes by).
class FIO {
  pending: unknown[] = [];
  targets: unknown[] = [];
  fresh: unknown[] = [];
  last = new Map<unknown, boolean>();
  constructor(public cb: (entries: unknown[]) => void) {
    E().ios.push(this);
  }
  observe(t: unknown): void {
    if (this.targets.includes(t)) return;
    this.targets.push(t);
    this.fresh.push(t);
    this.last.delete(t);
  }
  unobserve(t: unknown): void {
    this.targets = this.targets.filter((x) => x !== t);
    this.last.delete(t);
  }
  takeRecords(): unknown[] {
    const r = this.pending;
    this.pending = [];
    return r;
  }
}
class FMO {
  watched: { target: Node; o: { attributes?: boolean; childList?: boolean } }[] = [];
  constructor(public cb: (rs: Rec[]) => void) {
    E().mos.push(this);
  }
  observe(target: Node, o: { attributes?: boolean; childList?: boolean }): void {
    this.watched.push({ target, o });
  }
}
function mutated(target: Node, r: Rec): void {
  if (!env) return;
  for (const mo of env.mos)
    if (mo.watched.some((w) => w.target === target && (r.type === "childList" ? w.o.childList : w.o.attributes)))
      queueMicrotask(() => mo.cb([r]));
}

const entry = (whole: boolean) => ({ isVisible: whole, intersectionRatio: whole ? 1 : 0.5 });
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const MSG: Record<string, string> = {
  afSugFill: "Fill code with Sixkey · $1",
  afSugNo: "Not now",
  afSugWait: "One moment, then click again",
  afCanFill: "Sixkey can fill the code here: press $1",
  afCanFillOpen: "Sixkey can fill the code here: open Sixkey",
};

/** A page with one code box, the content script's suggestion started on it; the test drives everything. */
export async function mountSuggestion() {
  const doc = new FDocument();
  const e: Env = {
    t: 1000,
    raf: [],
    sent: [],
    ios: [],
    mos: [],
    styleReads: 0,
    transition: false,
    document: doc,
    hit: () => [],
  };
  env = e;
  const win: Record<string, unknown> = {};
  win.top = win;
  const winListeners = new Map<string, Listener[]>();
  const globals: Record<string, unknown> = {
    __SUGGEST_DBG__: true,
    window: win,
    document: doc,
    location: { href: "https://x.test/otc", hostname: "x.test" },
    innerWidth: 1280,
    innerHeight: 720,
    Element,
    ShadowRoot,
    HTMLInputElement,
    HTMLDialogElement,
    CSSStyleSheet,
    IntersectionObserver: FIO,
    MutationObserver: FMO,
    requestAnimationFrame: (f: (t: number) => void) => void e.raf.push(f),
    getComputedStyle: (el: { dirStyle?: string }) => {
      e.styleReads++;
      return { direction: el.dirStyle ?? "ltr" };
    },
    addEventListener: (type: string, f: Listener) => winListeners.set(type, [...(winListeners.get(type) ?? []), f]),
    chrome: {
      runtime: {
        sendMessage: (m: unknown) =>
          new Promise((resolve, reject) => {
            e.sent.push({ m, resolve, reject });
          }),
      },
      i18n: { getMessage: (k: string, subs?: string[]) => (MSG[k] ?? "").replace("$1", subs?.[0] ?? "") },
    },
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [k, v] of Object.entries(globals)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const clock = vi.spyOn(performance, "now").mockImplementation(() => e.t);

  const box = new HTMLInputElement();
  doc.body.append(box);
  // a second code box of the same page (4B-FU4: the suggestion moved to it while shown), where a test puts it
  const box2 = new HTMLInputElement();
  doc.body.append(box2);
  const finder = {
    inspect: () => ({ c: [{ t: "T", k: 0 as const, n: 6, s: 90, weak: false }], z: 0 as const }),
    of: (el: unknown) => (el === box || el === box2 ? "T" : null),
  };
  const { startSuggestion } = await import("../../src/inject/suggest-ui");
  startSuggestion(() => finder);
  const rec = () =>
    (
      globalThis as unknown as {
        __skSugLog: {
          log: string[];
          asks: string[];
          pill(): Element | null;
          host(): Element | null;
          root(): ShadowRoot | null;
          shown(): boolean;
          armed(): boolean;
        };
      }
    ).__skSugLog;

  const ev = (type: string, o: Partial<Ev> = {}): Ev => ({
    type,
    isTrusted: true,
    target: null,
    composedPath() {
      return [this.target];
    },
    clientX: 220,
    clientY: 150,
    detail: 1,
    key: "",
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...o,
  });
  const d = {
    env: e,
    box,
    box2,
    doc,
    log: () => rec().log.slice(),
    asks: () => rec().asks.slice(),
    shown: () => rec().shown(),
    armed: () => rec().armed(),
    pill: () => rec().pill()!,
    host: () => rec().host()!,
    /** The worker's messages, in order. */
    sent: () => e.sent.map((s) => s.m),
    /** The worker's answer to the i-th message. */
    async reply(i: number, a: unknown) {
      e.sent[i]!.resolve(a);
      await flush();
    },
    /** The clock, moved without a frame (the page held its rendering, or nothing was drawn). */
    advance(ms: number) {
      e.t += ms;
    },
    /** Frames for `ms`, `step` apart, each running what was asked for. */
    frames(ms: number, step = 16) {
      for (let done = 0; done < ms; done += step) {
        e.t += step;
        const q = e.raf;
        e.raf = [];
        q.forEach((f) => f(e.t));
      }
    },
    /** IntersectionObserver v2 reports the suggestion's button: all of it and visible, or not. */
    seen(whole: boolean) {
      const io = e.ios[0]!;
      for (const t of io.targets) io.last.set(t, whole);
      io.cb([entry(whole)]);
    },
    /**
     * What IntersectionObserver itself would report now that the button is `whole` or not: a report only when that
     * changed since its last one, or for a button observed afresh. True when it reported.
     */
    report(whole: boolean): boolean {
      const io = e.ios[0]!;
      const t = io.targets[0];
      if (t === undefined || io.last.get(t) === whole) return false;
      d.seen(whole);
      return true;
    },
    /** The targets observed afresh since the last call (each gets a first report from IntersectionObserver). */
    ioFresh(): unknown[] {
      const io = e.ios[0]!;
      const f = io.fresh;
      io.fresh = [];
      return f;
    },
    /** A report IntersectionObserver has made but not delivered yet (takeRecords has it). */
    pending(whole: boolean) {
      e.ios[0]!.pending.push(entry(whole));
    },
    /** The user's click into the code box (or on `target`): a trusted pointerdown, captured at the document. */
    async press(target: unknown = box) {
      doc.emit("pointerdown", ev("pointerdown", { target }));
      await flush();
    },
    async key(key: string) {
      doc.emit("keydown", ev("keydown", { target: box, key }));
      await flush();
    },
    /** Any event at the document, in the box by default; `isTrusted: false` for one the page made itself. */
    async event(type: string, o: Partial<Ev> = {}) {
      doc.emit(type, ev(type, { target: box, ...o }));
      await flush();
    },
    /** What the live region (a screen reader's) says. */
    live: () => rec().root()!.getElementById("l")!.textContent,
    /** The suggestion's width as drawn now (its words, or the hold while a cue is up). */
    width: () => rec().root()!.getElementById("p")!.getBoundingClientRect().width,
    /** The texts of the stylesheets its shadow root has adopted now. */
    sheets: () => (rec().root()!.adoptedStyleSheets as CSSStyleSheet[]).map((x) => x.text),
    /** The user's click on the suggestion's button: the document sees its host, the button its press, then the click. */
    async clickPill(o: Partial<Ev> = {}) {
      const pill = rec().pill()!;
      e.hit = () => [rec().host()];
      doc.emit("pointerdown", ev("pointerdown", { target: rec().host(), ...o }));
      pill.emit("pointerdown", ev("pointerdown", { target: pill, ...o }));
      pill.emit("click", ev("click", { target: pill, ...o }));
      await flush();
    },
    /** An event of the page at the document (fullscreenchange, toggle...). */
    fire(type: string, target: unknown = doc.body) {
      doc.emit(type, ev(type, { target }));
    },
    /** Shown after the user's click and the worker's `show: true`, then seen whole: the clock running. */
    async showIt() {
      await d.press();
      const i = e.sent.length - 1;
      await d.reply(i, { show: true, key: "Alt+Shift+F" });
      d.seen(true);
    },
    unmount() {
      clock.mockRestore();
      for (const [k, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete (globalThis as Record<string, unknown>)[k];
      }
      delete (globalThis as Record<string, unknown>).__skSugLog;
      env = undefined;
    },
  };
  return d;
}
export type Page = Awaited<ReturnType<typeof mountSuggestion>>;
