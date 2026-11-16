// A minimal document for rendering a Preact component in Node (vitest's "node" environment; the project carries no
// jsdom). Only what Preact's diff and the components under test touch: elements and text nodes in a tree, attributes,
// properties for the form fields (value, type, checked, disabled, the selection), listeners, focus. It does not lay
// out, does not bubble, and has no default actions: a test dispatches the events a browser would, in the order it would
// (test/unit/password-groups-dom.test.ts), and the real browser is checked by the e2e tests.

type Listener = (this: MiniNode, e: MiniEvent) => unknown;
export type MiniEvent = {
  type: string;
  target: MiniNode;
  currentTarget: MiniNode;
  defaultPrevented: boolean;
  preventDefault(): void;
  [k: string]: unknown;
};

export class MiniNode {
  childNodes: MiniNode[] = [];
  parentNode: MiniNode | null = null;
  constructor(
    readonly nodeType: number,
    readonly localName: string,
    public data = "",
  ) {}
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): MiniNode | null {
    const s = this.parentNode?.childNodes;
    return s ? (s[s.indexOf(this) + 1] ?? null) : null;
  }
  insertBefore(node: MiniNode, ref: MiniNode | null) {
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node: MiniNode) {
    return this.insertBefore(node, null);
  }
  removeChild(node: MiniNode) {
    this.childNodes.splice(this.childNodes.indexOf(node), 1);
    node.parentNode = null;
    return node;
  }
  get textContent(): string {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join("");
  }
}

export class MiniElement extends MiniNode {
  namespaceURI: string;
  attrs = new Map<string, string>();
  style: Record<string, string> & { setProperty(k: string, v: string): void } = Object.assign(Object.create(null), {
    setProperty(this: Record<string, string>, k: string, v: string) {
      this[k] = v;
    },
  });
  private listeners = new Map<string, Listener[]>();
  // the form fields' properties (`name in dom` makes Preact set these as properties)
  value = "";
  type = "";
  checked = false;
  disabled = false;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  // the on* properties a browser has, so Preact lower-cases these event names as it does there (no oncompositionend:
  // Chrome has none either)
  oninput = null;
  onpaste = null;
  onkeydown = null;
  onclick = null;
  onsubmit = null;
  onchange = null;
  onfocus = null;
  onblur = null;
  onpointerdown = null;
  constructor(
    readonly doc: MiniDocument,
    localName: string,
    ns: string,
  ) {
    super(1, localName);
    this.namespaceURI = ns;
    if (localName === "input" || localName === "textarea") {
      let v = "";
      Object.defineProperty(this, "value", {
        get: () => v,
        set: (x: unknown) => {
          v = String(x ?? "");
          this.selectionStart = this.selectionEnd = v.length; // as a browser does on a programmatic write
        },
      });
    }
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  setAttribute(k: string, v: unknown) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  addEventListener(type: string, f: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
  }
  removeEventListener(type: string, f: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((g) => g !== f),
    );
  }
  /** The event `type` on this element (no bubbling), with `init`'s fields; the event, to read defaultPrevented. */
  dispatch(type: string, init: Record<string, unknown> = {}): MiniEvent {
    const e: MiniEvent = {
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (const f of this.listeners.get(type) ?? []) f.call(this, e);
    return e;
  }
  listenerCount(type: string) {
    return (this.listeners.get(type) ?? []).length;
  }
  focus() {
    this.doc.activeElement = this;
  }
  setSelectionRange(a: number, b: number) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  /** Every element under this one (itself included) matching `test`, in document order. */
  all(test: (e: MiniElement) => boolean): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (n: MiniNode) => {
      if (n instanceof MiniElement && test(n)) out.push(n);
      n.childNodes.forEach(walk);
    };
    walk(this);
    return out;
  }
  byId(id: string): MiniElement | null {
    return this.all((e) => e.id === id)[0] ?? null;
  }
}

export class MiniDocument {
  activeElement: MiniElement | null = null;
  readonly body = new MiniElement(this, "body", "http://www.w3.org/1999/xhtml");
  createElement(name: string) {
    return new MiniElement(this, name, "http://www.w3.org/1999/xhtml");
  }
  createElementNS(ns: string, name: string) {
    return new MiniElement(this, name, ns);
  }
  createTextNode(text: string) {
    return new MiniNode(3, "#text", text);
  }
}

/**
 * A fresh document as `globalThis.document`, with the window's addEventListener (for "pagehide"); the undo. The page's
 * own listeners are kept in `page`, so a test can fire "pagehide".
 */
export function installMiniDom(): { doc: MiniDocument; page: MiniElement; undo: () => void } {
  const doc = new MiniDocument();
  const page = doc.createElement("window");
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, add: g.addEventListener, remove: g.removeEventListener };
  g.document = doc;
  g.addEventListener = page.addEventListener.bind(page);
  g.removeEventListener = page.removeEventListener.bind(page);
  return {
    doc,
    page,
    undo: () => {
      g.document = saved.document;
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
    },
  };
}
