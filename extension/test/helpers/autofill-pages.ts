// Synthetic pages for TOTP autofill, Stage 1 (TOTP-AUTOFILL §11.1 fixtures 1 to 8 and 10; docs/design/notes/AUTOFILL1-NOTES.md §8).
// Each is a minimal page written for the test: no saved copy of a real site. They are served from one local server under
// different host names (`app.fix.test`, `auth.fix.test`, `evil.test`, and the IP address), so what differs between "the
// same site", "another site of the same account" and "another site" is the host, as in the browser.
//
// Every page records what happened to it in `window.__ev` (events it saw that a code fill must never cause: a submit, a
// click, a key press) and `window.__log` (what its boxes did), which the tests read back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EVENTS = `
<script>
  window.__ev = [];
  for (const t of ["submit", "click", "keydown", "keyup", "keypress", "pointerdown", "mousedown", "beforeinput"])
    document.addEventListener(t, (e) => window.__ev.push(t + ":" + (e.target && e.target.tagName)), true);
  window.__log = [];
</script>`;
const head = (title: string, extra = "") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${EVENTS}${extra}<body>`;
const box = (attrs: string, label = "", after = "") => `<label>${label}<input ${attrs}></label>${after}`;

/** The page of a web login form with a code step, as the owner reported it (placeholder only, among other fields). */
const OWNER = `${head("Task Admin")}<h1>Task Admin</h1>
<form id="f" onsubmit="window.submitted = true; return false">
  <div class="row"><label>Username</label><input name="username" placeholder="Username"></div>
  <div class="row"><input type="password" name="password" autocomplete="current-password" placeholder="Password"></div>
  <div class="row"><input class="ant-input" placeholder="TOTP code (required after binding)"></div>
  <label><input type="checkbox" name="remember"> Remember me</label>
  <button>Sign in</button>
</form>`;

/** A React-controlled input: React's value tracker, as React installs it (an own `value` property on the element). */
const REACT = `${head("React")}<div id="root"></div><div id="out"></div><script>
  const state = { value: "" };
  const input = document.createElement("input");
  input.setAttribute("aria-label", "Authentication code");
  input.setAttribute("maxlength", "6");
  input.setAttribute("inputmode", "numeric");
  document.getElementById("root").appendChild(input);
  // what React does (inputValueTracking): shadow the element's value property so its own writes are tracked
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  let tracked = "";
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { tracked = "" + v; desc.set.call(this, v); },
  });
  function render() { input.value = state.value; document.getElementById("out").textContent = state.value; }
  // onChange: fires only if the element's real value differs from the tracked one
  input.addEventListener("input", () => {
    const next = desc.get.call(input);
    if (next !== tracked) { tracked = next; state.value = next; window.__log.push("onChange:" + next); render(); }
  });
  render();
  window.__state = state;
</script>`;

const vueLike = (
  lazy: boolean,
) => `${head(lazy ? "Vue lazy" : "Vue")}<div id="app"><input id="v" aria-label="Verification code" maxlength="6" inputmode="numeric"></div><script>
  window.model = { code: "" };
  document.getElementById("v").addEventListener("${lazy ? "change" : "input"}", (e) => { window.model.code = e.target.value; });
</script>`;

const seg = (
  n: number,
  mode: "advance" | "paste" | "reject" | "react" = "advance",
) => `${head(`${n} boxes`, "<style>.s{display:flex;gap:6px}.s input{width:34px;height:42px;text-align:center;font-size:20px}</style>")}
<div>Enter your verification code<div class="s" id="g">${Array.from({ length: n }, (_, i) => `<input maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}" data-i="${i}">`).join("")}</div></div>
<script>
  const boxes = [...document.querySelectorAll("#g input")];
  const mode = ${JSON.stringify(mode)};
  boxes.forEach((b, i) => {
    b.addEventListener("input", () => {
      if (mode === "reject") { b.value = ""; return; }
      if (mode === "paste") { b.value = ""; return; } // only a paste into the first box is understood
      if (b.value && boxes[i + 1]) boxes[i + 1].focus(); // auto-advance
    });
    b.addEventListener("paste", (e) => {
      if (mode !== "paste") return;
      e.preventDefault();
      const t = (e.clipboardData.getData("text/plain") || "").replace(/\\D/g, "");
      boxes.forEach((x, j) => { x.value = t[j] || ""; });
      window.__log.push("pasted:" + t);
    });
  });
</script>`;

const NEGATIVES = `${head("Account")}<h1>Account</h1><form onsubmit="return false">
  ${box('type="search" name="q" maxlength="6" placeholder="Search"', "")}
  ${box('type="tel" name="phone" maxlength="11" inputmode="numeric" placeholder="Phone number"', "")}
  ${box('name="card_cvc" autocomplete="cc-csc" maxlength="3" inputmode="numeric"', "CVC")}
  ${box('name="zip" maxlength="6" inputmode="numeric"', "ZIP code")}
  ${box('name="coupon" maxlength="6"', "Coupon code")}
  ${box('type="email" name="email" placeholder="Email"', "")}
  <img alt="captcha" width="80" height="30" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> ${box('name="captcha" maxlength="4"', "图形验证码")}
  ${box('type="password" name="password" autocomplete="current-password" aria-label="Authenticator code or password" maxlength="6"', "")}
</form>`;

const q = (u: URL, k: string, d = "") => u.searchParams.get(k) ?? d;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export type Ctx = { port: number };
/** The pages, by path. A page may read its query string (`label`: the same box with different words). */
export const PAGES: Record<string, (u: URL, c: Ctx) => string> = {
  "/owner": () => OWNER,
  "/otc": () =>
    `${head("Verify")}<h1>Verify</h1>${box('autocomplete="one-time-code" inputmode="numeric" maxlength="6" name="code"', "")}`,
  "/label": (u) => {
    const text = esc(q(u, "text", "Verification code"));
    const mode = q(u, "mode", "label");
    const len = q(u, "len", "6");
    const attrs = `maxlength="${len}" inputmode="numeric"`;
    return `${head("Label")}<h1>Sign in</h1>${
      mode === "placeholder"
        ? `<input ${attrs} placeholder="${text}">`
        : mode === "aria"
          ? `<input ${attrs} aria-label="${text}">`
          : box(attrs, text)
    }`;
  },
  "/seg6": () => seg(6),
  "/seg8": () => seg(8),
  "/seg6-paste": () => seg(6, "paste"),
  "/seg6-reject": () => seg(6, "reject"),
  "/seg4": () => seg(4),
  "/react": () => REACT,
  "/vue": () => vueLike(false),
  "/vue-lazy": () => vueLike(true),
  "/negatives": () => NEGATIVES,
  "/sms": () =>
    `${head("SMS")}<h1>Check your phone</h1><p>We sent a text message to your phone.</p>${box('maxlength="6" inputmode="numeric"', "短信验证码")}`,
  "/nofield": () =>
    `${head("Sign in")}<h1>Sign in</h1><form onsubmit="return false"><input name="username" placeholder="Username"><input type="password" name="password" autocomplete="current-password" placeholder="Password"><button>Sign in</button></form>`,
  "/two": () =>
    `${head("Two")}<h1>Verify</h1>${box('maxlength="6" inputmode="numeric" name="a"', "Verification code (work)")}<br>${box('maxlength="6" inputmode="numeric" name="b"', "Verification code (personal)")}`,
  "/maxlen4": () => `${head("Short")}${box('maxlength="4" inputmode="numeric" autocomplete="one-time-code"', "")}`,
  "/refuse":
    () => `${head("Refuse")}<input autocomplete="one-time-code" inputmode="numeric" maxlength="6" id="r"><script>
    document.getElementById("r").addEventListener("input", (e) => { e.target.value = ""; });</script>`,
  "/late": () => `${head("Late")}<h1>Loading...</h1><div id="slot"></div><script>
    setTimeout(() => { document.getElementById("slot").innerHTML = '<input autocomplete="one-time-code" inputmode="numeric" maxlength="6">'; }, 1500);</script>`,
  "/shadow-open": () => `${head("Shadow")}<div id="host"></div><script>
    const r = document.getElementById("host").attachShadow({ mode: "open" });
    r.innerHTML = '<label>Verification code <input autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>';</script>`,
  "/shadow-closed": () => `${head("Closed")}<div id="host"></div><script>
    const r = document.getElementById("host").attachShadow({ mode: "closed" });
    r.innerHTML = '<label>Verification code <input autocomplete="one-time-code" inputmode="numeric" maxlength="6"></label>';</script>`,
  "/hidden-box": () =>
    `${head("Hidden")}<input autocomplete="one-time-code" maxlength="6" style="display:none"><input autocomplete="one-time-code" maxlength="6" style="opacity:0;position:absolute"><input autocomplete="one-time-code" maxlength="6" disabled><input autocomplete="one-time-code" maxlength="6" readonly>`,
  "/frame": (u) =>
    `${head("Frame")}<h1>Top</h1><iframe id="f" src="${esc(q(u, "src"))}" width="400" height="200"></iframe>`,
  // "verify your phone": a code box that says "Verification code" and is named for a phone: only the name keeps it out
  "/phone-verify": () =>
    `${head("Phone")}<h1>Verify your phone</h1><input type="tel" name="phone_verify" maxlength="6" inputmode="numeric" aria-label="Verification code">`,
  // a password-type box with no password word in it, focused: never offered as "the box that has focus"
  "/pw-plain": () => `${head("Secret")}<input type="password" name="secret_field" id="p" maxlength="12">`,
  // two and ten one-character boxes are no code group (4 to 8 are), whatever their label says
  "/seg2": () =>
    `${head("Two")}<div>Authenticator code <input maxlength="1" name="a1"><input maxlength="1" name="a2"></div>`,
  "/seg10": () =>
    `${head("Ten")}<div>Authenticator code ${Array.from({ length: 10 }, (_, i) => `<input maxlength="1" name="d${i}">`).join("")}</div>`,
  // boxes the user cannot see (the review's m-4): each is the page's only code box, and none may be offered or filled
  "/hp": (u) => {
    const box = 'autocomplete="one-time-code" inputmode="numeric" maxlength="6"';
    const kind = q(u, "kind");
    const html: Record<string, string> = {
      offscreen: `<input ${box} style="position:absolute;left:-9999px;top:0;width:200px;height:30px">`,
      above: `<input ${box} style="position:absolute;left:10px;top:-5000px;width:200px;height:30px">`,
      clippath: `<input ${box} style="clip-path:inset(50%);width:200px;height:30px">`,
      clip: `<input ${box} style="position:absolute;clip:rect(0 0 0 0);width:200px;height:30px">`,
      inert: `<div inert><input ${box}></div>`,
      ariahidden: `<div aria-hidden="true"><input ${box}></div>`,
      zero: `<input ${box} style="width:0;height:0;padding:0;border:0">`,
      tiny: `<input ${box} style="width:6px;height:6px;padding:0;border:0">`,
      visibility: `<input ${box} style="visibility:hidden">`,
      display: `<input ${box} style="display:none">`,
      opacity: `<input ${box} style="opacity:0">`,
      closed: `<details><summary>More</summary><input ${box}></details>`,
      // hidden by an ANCESTOR (the second review's F2): the box itself looks fine
      parentclip: `<div style="clip-path:inset(50%)"><input ${box} style="width:200px;height:30px"></div>`,
      parentoverflow: `<div style="width:0;height:0;overflow:hidden"><input ${box} style="width:200px;height:30px"></div>`,
      parentfilter: `<div style="filter:opacity(0)"><input ${box} style="width:200px;height:30px"></div>`,
      parentmask: `<div style="-webkit-mask-image:linear-gradient(transparent,transparent);mask-image:linear-gradient(transparent,transparent)"><input ${box} style="width:200px;height:30px"></div>`,
      parentopacity: `<div style="opacity:0"><input ${box} style="width:200px;height:30px"></div>`,
      parentclipped: `<div style="width:200px;height:30px;overflow:hidden"><div style="height:60px"></div><input ${box} style="width:200px;height:30px"></div>`,
      // clipped away by an ancestor, but far below the first screen (no hit test is possible there: the ancestor's room is checked)
      belowclip: `<div style="height:4000px"></div><div style="width:0;height:0;overflow:hidden"><input ${box} style="width:200px;height:30px"></div>`,
      // clipped away by its own clip-path, far below the first screen (the hit test cannot see it there: the box's own style is read)
      belowclippath: `<div style="height:4000px"></div><input ${box} style="clip-path:inset(50%);width:200px;height:30px">`,
      // drawn over: an opaque element lies on top of the box
      covered: `<div style="position:relative;width:200px;height:30px"><input ${box} style="width:200px;height:30px"><div style="position:absolute;inset:0;background:#fff">Loading…</div></div>`,
      // a box whose typed digits cannot be seen and that has no slots under it: a transparent decoy, not a widget
      transparent: `<input ${box} style="width:200px;height:30px;color:transparent;background:transparent;border:0;caret-color:transparent">`,
      fillcolor: `<input ${box} style="width:200px;height:30px;-webkit-text-fill-color:transparent">`,
      // hidden by an ancestor that is the host of the box's shadow root (the walk up goes through it), or by any ancestor
      shadowfilter: `<div style="filter:opacity(0)"><template shadowrootmode="open"><input ${box} style="width:200px;height:30px"></template></div>`,
      parentvisibility: `<div style="visibility:hidden"><input ${box} style="width:200px;height:30px"></div>`,
      parentdisplay: `<div style="display:none"><input ${box} style="width:200px;height:30px"></div>`,
      transparentunder: `<div style="position:relative;width:200px;height:30px"><input ${box} style="position:absolute;inset:0;width:200px;height:30px;color:transparent;background:transparent;border:0"><div style="position:absolute;inset:0;background:#eee"></div></div>`,
    };
    return `${head("Hidden " + kind)}<h1>Verify</h1>${html[kind] ?? ""}`;
  },
  // an OTP widget as input-otp draws it: the real box is transparent and lies over the slots that show the digits
  "/overlay-widget": () => `${head("Widget")}<div style="position:relative;width:260px;height:44px">
    <input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Verification code" style="position:absolute;inset:0;width:100%;height:100%;color:transparent;caret-color:transparent;background:transparent;border:0">
    <div style="display:flex;gap:6px;pointer-events:none">${Array.from({ length: 6 }, () => '<span style="width:36px;height:44px;border:1px solid #888"></span>').join("")}</div></div>`,
  // a box under its own label until it is focused (a floating label): what is on top of it is its label, so it is seen
  "/floating-label": () =>
    `${head("Floating")}<div style="position:relative;width:200px;height:30px"><input id="f" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="width:200px;height:30px"><label for="f" style="position:absolute;inset:0;line-height:30px;background:#fff">Authenticator code</label></div>`,
  // a visible real box and, apart from it, a box whose digits are invisible (and that has no slots): the real one is filled
  "/real-and-honey":
    () => `${head("Real and honey")}<label>Authenticator code <input id="real" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="width:200px;height:30px"></label>
    <div style="margin-top:20px"><input id="honey" autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Verification code" style="width:200px;height:30px;color:transparent;background:transparent;border:0;caret-color:transparent"></div>`,
  // the usual widget AND a plain visible box: the visible one is preferred
  "/widget-and-real": () => `${head("Widget and real")}<div style="position:relative;width:260px;height:44px">
    <input id="widget" autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Verification code" style="position:absolute;inset:0;width:100%;height:100%;color:transparent;caret-color:transparent;background:transparent;border:0">
    <div style="display:flex;gap:6px;pointer-events:none">${Array.from({ length: 6 }, () => '<span style="width:36px;height:44px;border:1px solid #888"></span>').join("")}</div></div>
    <label style="display:block;margin-top:20px">Authenticator code <input id="real" autocomplete="one-time-code" inputmode="numeric" maxlength="6" style="width:200px;height:30px"></label>`,
  // n visible boxes that all say they take a one-time code: there is no one code box here, and the finder does not pick among them
  // (`pad`: that many plain text inputs before them, which the finder looks at and passes over)
  "/otcs": (u) =>
    `${head("Many codes")}${'<input name="pad">'.repeat(Number(q(u, "pad", "0")))}${Array.from({ length: Number(q(u, "n", "30")) }, (_, i) => `<div><input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code ${i}" style="width:200px;height:24px"></div>`).join("")}`,
  // the second review's soft-budget page (R3-VERIFY §4): a box whose aria-labelledby names a 1 MB block of text n times
  "/bigref": (u) =>
    `${head("Big label")}<input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-labelledby="${Array(
      Number(q(u, "n", "200")),
    )
      .fill("big")
      .join(" ")}"><div id="big">${"lorem ipsum ".repeat(90_000)}</div>`,
  // a page whose input handler holds the fill up for 15 s (the code is in the box before the handler runs)
  "/hang-input":
    () => `${head("Hang")}<input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code"><script>
    document.querySelector("input").addEventListener("input", () => { const t = Date.now(); while (Date.now() - t < 15000); });</script>`,
  // many inputs: n flat ones, each in its own div under one parent, and one code box among them
  "/many": (u) => {
    const n = Number(q(u, "n", "100"));
    const rows = Array.from({ length: n }, (_, i) => `<div><input name="f${i}"></div>`);
    rows.splice(
      Math.floor(n / 2),
      0,
      `<div><input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code"></div>`,
    );
    return `${head("Many")}<form onsubmit="return false">${rows.join("")}</form>`;
  },
  // six one-character boxes that all go away once the sixth is filled (a page that moves on at the last digit)
  "/seg6-hide": () =>
    `${head("Seg hide")}<div>Verification code <span id="g">${Array.from({ length: 6 }, (_, i) => `<input maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join("")}</span></div>
    <script>document.querySelectorAll("#g input").forEach((b) => b.addEventListener("input", () => { if ([...document.querySelectorAll("#g input")].every((x) => x.value)) document.getElementById("g").style.display = "none"; }));</script>`,
  // a box that is covered by an opaque element the moment it is written to (it is still "shown" to the cheap test)
  "/cover-on-input": () =>
    `${head("Cover")}<div style="position:relative;width:200px;height:30px"><input id="c" autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code" style="width:200px;height:30px"></div><script>
    document.getElementById("c").addEventListener("input", () => { const d = document.createElement("div"); d.style.cssText = "position:fixed;inset:0;background:#fff"; document.body.append(d); });</script>`,
  // six boxes without auto-advance, and a focus counter: filling must not move the focus about
  "/seg6-focus":
    () => `${head("Focus")}<div>Verification code <span id="g">${Array.from({ length: 6 }, (_, i) => `<input maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join("")}</span></div>
    <script>window.__focus = 0; document.querySelectorAll("#g input").forEach((b) => b.addEventListener("focus", () => window.__focus++));</script>`,
  // spans and a code box at the end: past the node cap, so not found, and said so
  "/nodes": (u) =>
    `${head("Nodes")}${"<span></span>".repeat(Number(q(u, "n", "1000")))}<input autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code">`,
  // a box that hides itself the moment it is written to (after it kept the code): the fill may not claim success ("moved")
  "/hide-on-input":
    () => `${head("Hide")}<input id="h" autocomplete="one-time-code" inputmode="numeric" maxlength="6" aria-label="Authenticator code"><script>
    document.getElementById("h").addEventListener("input", (e) => { e.target.style.display = "none"; });</script>`,
  "/plain": () => `${head("Plain")}<h1>Nothing here</h1>`,
};

/**
 * The e2e build's test rules' pages (TOTP autofill Stage 3, AF3-3b; test/fixtures/rules/fixtures/<id>/*.html), each at the
 * path its `<meta name="sixkey-path">` names, served like the pages above on every host (the rules are for
 * rules.fix.test and rules2.fix.test only: the same page elsewhere is a page without a rule).
 */
export const RULE_PAGES: Record<string, string> = (() => {
  const dir = resolve(import.meta.dirname, "../fixtures/rules/fixtures");
  const out: Record<string, string> = {};
  for (const id of readdirSync(dir).filter((n) => !n.startsWith(".")))
    for (const f of readdirSync(join(dir, id)).filter((n) => n.endsWith(".html"))) {
      const html = readFileSync(join(dir, id, f), "utf8");
      const at = /<meta name="sixkey-path" content="([^"]+)"/.exec(html)?.[1];
      if (!at || out[at]) throw new Error(`fixtures/${id}/${f}: no sixkey-path, or one another page has`);
      out[at] = html;
    }
  return out;
})();

export type Site = { server: Server; port: number; tlsPort: number; close(): Promise<void> };

/**
 * A server for the pages on a free port of the loopback address, and with `tls` a second one speaking https with a
 * throw-away self-signed certificate for `tls.fix.test` (made with openssl; the browser is started with
 * --ignore-certificate-errors): the https scheme end to end.
 */
export async function servePages(tls = false): Promise<Site> {
  const serve = (get: () => Server) => (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const page = PAGES[u.pathname];
    const rulePage = RULE_PAGES[u.pathname];
    if (!page && rulePage === undefined) {
      res.statusCode = 404;
      return void res.end("not found");
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page ? page(u, { port: (get().address() as { port: number }).port }) : rulePage);
  };
  const plain: Server = createServer(serve(() => plain));
  await new Promise<void>((ok) => plain.listen(0, "127.0.0.1", () => ok()));
  const port = (plain.address() as { port: number }).port;
  let secure: Server | undefined;
  let dir = "";
  if (tls) {
    dir = mkdtempSync(join(tmpdir(), "sixkey-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=tls.fix.test",
        "-addext",
        "subjectAltName=DNS:tls.fix.test",
      ],
      { stdio: "ignore" },
    );
    secure = createTlsServer(
      { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) },
      serve(() => secure as unknown as Server),
    );
    await new Promise<void>((ok) => secure!.listen(0, "127.0.0.1", () => ok()));
  }
  const tlsPort = secure ? (secure.address() as { port: number }).port : 0;
  return {
    server: plain,
    port,
    tlsPort,
    close: async () => {
      await new Promise<void>((ok) => plain.close(() => ok()));
      await new Promise<void>((ok) => (secure ? secure.close(() => ok()) : ok()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
