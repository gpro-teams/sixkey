// The code box finder and filler (TOTP-AUTOFILL §3, §4). With inject/suggest.js, the only code Sixkey ever runs in a web
// page. It is built as the classic script `inject/otp.js` (scripts/build.mjs) and injected with
// chrome.scripting.executeScript({files}) into the ISOLATED world of the tab the user is on, only after the user opened
// Sixkey on a page that matches an account, clicked Fill, or pressed the Fill shortcut; and, on a site the user turned code
// suggestions on for (TOTP autofill Stage 2, docs/design/notes/AUTOFILL2-NOTES.md §9), installed by the registered content
// script into that site's pages, where inject/suggest.js calls inspect() only on a trusted click or key press in a box. It
// leaves one global in that world, `__skOtp` (the page cannot see an isolated world), with three calls (and `b`, the build
// it is: a second install keeps the first copy, "one finder per page" below):
//   inspect(hint?)  looks for the one-time code box(es), reads nothing but the shape of a few inputs, writes nothing. Called
//              with an argument (the three Fill paths: a site rule's hint, or null), it also applies the rule and owns the
//              rule-made entries of its table; called with none (the Stage 2 content script), it leaves them alone (TOTP
//              autofill Stage 3, docs/design/notes/AUTOFILL3-NOTES.md §3);
//   fill(...)  types one code into a box that inspect() found, after checking where it is;
//   of(el)     the token of the box (or group) the element is, as the last inspect() found it, or null; reads nothing.
// The rules this file keeps (test/unit/autofill1-source-rules.test.ts holds the source to them, the e2e tests hold the
// behaviour):
//   - no imports (but the type of the hint, which the build erases), no `chrome` API, no network, no storage, no messages, no timers that outlive a call: the code arrives
//     as an argument of fill() and leaves only in the box's value, and the file never hands anything back to the page;
//   - the code is checked (6 to 8 digits) and is written only into an <input> this file found as a code box, never a
//     password, search, e-mail, phone or card field, and only after the page's own origin, host and top frame are checked
//     against what the extension passed in (the extension decided the match; this is the second look);
//   - it never submits: no form submit, no click, no Enter key, no focus change except into a box it fills;
//   - it never touches the clipboard (the paste strategy is a synthetic event carrying its own DataTransfer).
// It has no state that outlives the document and holds no secret: the table of boxes found by inspect() is element
// references under random one-use tokens.
import type { Hint } from "../core/rules/lookup";

// ---- data: words ------------------------------------------------------------------------------------------------
// Text is compared folded (NFKD, accents and marks removed, lower case). Latin words match on word boundaries, CJK as
// substrings. A word list is data for the scoring below, not UI text; native speakers review it (TOTP-AUTOFILL §3.2).
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const re = (latin: string, cjk: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${fold(latin)})(?![\\p{L}\\p{N}])${cjk ? `|(?:${fold(cjk)})` : ""}`, "u");

/** A code from an authenticator app: the words that say so (worth the most). */
const STRONG = re(
  "totp|otp|2fa|mfa|tfa|2-?step|two.?step|two.?factor|multi.?factor|authenticator|authentication app|one.?time|" +
    "zwei.?faktor|authentificateur|double authentification|autenticador|dos pasos|duas etapas|dois fatores|due fattori|" +
    "двухфакторн[а-я]*|аутентификатор[а-я]*|одноразов[а-я]*",
  "动态口令|动态码|动态验证码|两步验证|二次验证|双重验证|身份验证器|验证器|令牌|谷歌验证|動態密碼|動態碼|兩步驟|驗證器|雙重驗證|" +
    "ワンタイム|二段階認証|2段階認証|認証アプリ|일회용|2단계|인증 ?앱",
);
/** A verification code in general: the words that say a code is wanted (worth less: SMS and e-mail codes use them too). */
const CODE = re(
  "verification code|security code|authentication code|auth(?:orization)? code|passcode|6.?digit|code de verification|" +
    "code de securite|code d'authentification|code a usage unique|codigo de verificacion|codigo de seguridad|" +
    "codigo de autenticacion|codigo de verificacao|codigo de seguranca|codigo de autenticacao|" +
    "bestatigungscode|sicherheitscode|authentifizierungscode|einmalcode|prufcode|verifizierungscode|" +
    "codice di verifica|codice di sicurezza|код подтверждения|код проверки|код безопасности",
  "验证码|校验码|安全码|认证码|驗證碼|安全碼|確認コード|認証コード|セキュリティコード|인증 ?코드|인증번호|보안 ?코드|인증 ?번호",
);
/** The code was sent to the person (SMS, e-mail, a call): the page may not want an authenticator code (a soft negative). */
const SENT = re(
  "text message|sms|sent to your (?:phone|mobile|email|e-?mail)|e-?mail(?:ed)?|phone call|mensaje de texto|correo|" +
    "per e-?mail|par e-?mail|mensagem de texto|смс|по почте|sms|codice inviato",
  "短信|手机验证码|邮箱|邮件|发送至|已发送|簡訊|手機驗證碼|ショートメッセージ|メール|문자|이메일",
);
/** Not a code box at all, said in words (a hard negative: captcha, search, phone and card numbers). */
const NOT_CODE = re(
  "captcha|recaptcha|hcaptcha|not a robot|search|query|phone number|mobile number|telephone|card number|credit card|" +
    "cvv|cvc|postal|zip code|coupon|promo|voucher|buscar|suche|rechercher|телефон|поиск|numero de telefono|" +
    "telefonnummer|numero de telephone",
  "图形验证码|图片验证码|看不清|换一张|滑块|人机验证|搜索|搜尋|搜寻|手机号|电话号码|電話番号|電話號碼|银行卡|卡号|信用卡|検索|" +
    "圖形驗證碼|휴대폰 ?번호",
);
// name, id, class and data-* tokens (split at non-letters and camel-case humps)
const ID_STRONG = new Set(["otp", "totp", "2fa", "mfa", "tfa", "authcode", "onetimecode", "mfacode", "twofactor"]);
const ID_CODE = new Set(["passcode", "verification", "verify", "verifycode", "securitycode", "authenticator", "token"]);
const ID_NOT = new Set([
  "search", "query", "q", "phone", "mobile", "tel", "zip", "postal", "card", "cc", "cvv", "cvc", "csc", "amount", "price",
  "quantity", "coupon", "promo", "captcha", "recaptcha", "email", "username",
]); // prettier-ignore
const ID_PASSWORD = new Set(["password", "passwd", "pwd", "pass", "pin"]);
const AC_NOT =
  /\b(?:current-password|new-password|username|email|tel\S*|cc-\S+|name|street-address|postal-code|search)\b/;
const URL_HINT =
  /(?:^|[/_.-])(?:2fa|mfa|otp|totp|verify|challenge|two-factor|second-factor|twofactor|2-step)(?:$|[/_.?-])/i;

// ---- scoring ----------------------------------------------------------------------------------------------------
/** What the finder reads of one box. Everything the score depends on, so the score is a pure function of it. */
export type Feat = {
  type: string;
  autocomplete: string;
  inputmode: string;
  pattern: string;
  /** The longest value the box takes, or 0 when it has no limit. */
  max: number;
  /** Text from name, id, class and data-* attributes. */
  ids: string;
  /** Text from the label, aria-label, aria-labelledby, placeholder, title and the words next to the box. */
  label: string;
  /** 0 for a single box; N for a group of N one-character boxes (the first box's features stand for the group). */
  segments: number;
  urlHint: boolean;
  /** The only candidate on the page, and the page has no visible password field. */
  alone: boolean;
};
/** `neg`: a hard negative (search, phone, card, coupon, ... in the box's names or words): no site rule may promote it. */
export type Scored = { score: number; sent: boolean; veto: boolean; neg: boolean };

const tokens = (s: string) =>
  fold(s.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** TOTP-AUTOFILL §3.1: the confidence that a box takes an authenticator code. `veto`: never a code box, whatever else it says. */
export function score(f: Feat): Scored {
  const ac = f.autocomplete.toLowerCase();
  const idTokens = tokens(f.ids);
  const idText = idTokens.join("");
  const label = fold(f.label);
  const veto =
    ["search", "email", "url", "hidden", "checkbox", "radio", "file", "submit", "button", "image", "reset"].includes(
      f.type,
    ) ||
    AC_NOT.test(ac) ||
    idTokens.some((x) => ID_PASSWORD.has(x)) ||
    /captcha|图形验证码|图片验证码|看不清|换一张|滑块/.test(label + idText);
  let s = 0;
  if (/\bone-time-code\b/.test(ac)) s += 50;
  if (idTokens.some((x) => ID_STRONG.has(x)) || /one.?time|two.?factor/.test(f.ids.toLowerCase())) s += 25;
  else if (idTokens.some((x) => ID_CODE.has(x))) s += 15;
  else if (idTokens.includes("code")) s += 10;
  if (STRONG.test(label)) s += 45;
  else if (CODE.test(label)) s += 25;
  else if (/(?:^|[^\p{L}])code(?![\p{L}])/u.test(label)) s += 10;
  if (f.segments >= 4 || (f.max >= 6 && f.max <= 8)) s += 15;
  if (/\bnumeric\b/.test(f.inputmode) || /^\[?0-9\]|\\d/.test(f.pattern) || f.type === "tel" || f.type === "number")
    s += 10;
  if (f.urlHint) s += 10;
  if (f.alone) s += 5;
  const idNot = idTokens.some((x) => ID_NOT.has(x));
  const neg = idNot || NOT_CODE.test(label);
  if (neg) s -= 60;
  const sent = SENT.test(label);
  if (sent) s -= 20;
  return { score: veto ? -100 : s, sent, veto, neg };
}

/** The qualifying score: the popup's Fill button is offered at this and above (§3.1). */
export const THRESHOLD = 40;
/** The lead the best candidate needs over the next one to be chosen without asking (§3.7). */
export const LEAD = 20;
/** What a site rule adds to the score of a box it names (§3.1). */
export const RULE_BOOST = 100;
/** A box a site rule may promote: no veto, no hard negative, not a password box (the Stage 3 plan's S1). */
export const boostable = (type: string, sc: Scored) => !sc.veto && !sc.neg && type !== "password";

// ---- reading the page -------------------------------------------------------------------------------------------
const TYPES = ["text", "tel", "number", "password", ""];
const MAX_NODES = 40000;
const MAX_DEPTH = 8;
/** The most inputs one look reads, and the time it may take: a page past either is "too complex" (an honest answer, `z`). */
const MAX_INPUTS = 600;
const BUDGET_MS = 60;
/** The most qualifying boxes the deep look test is run for: a page with more has no single code box to pick (too complex). */
const MAX_DEEP = 16;
/**
 * The clock counts only after this much work (an input looked at, a box looked at closely, 256 nodes walked): a small page is
 * never "too complex" because of a pause that is not its own (a garbage collection, a busy machine), only a big one.
 */
const FLOOR = 48;
let deadline = 0;
let work = 0;
const over = () => ++work > FLOOR && performance.now() > deadline;

/**
 * Every <input> of the document, in document order, open shadow roots included (depth 8). Closed roots are not walked.
 * Stops at MAX_NODES elements (counted over the whole walk, shadow roots included) or MAX_INPUTS inputs, and says so.
 */
function inputsOf(
  root: Document | ShadowRoot | Element,
  st = { nodes: 0, capped: false },
  depth = 0,
): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  for (const el of root.querySelectorAll("*")) {
    if (++st.nodes > MAX_NODES || out.length > MAX_INPUTS || ((st.nodes & 255) === 0 && over())) {
      st.capped = true;
      break;
    }
    if (el instanceof HTMLInputElement) out.push(el);
    else if (el.shadowRoot && depth < MAX_DEPTH) {
      out.push(...inputsOf(el.shadowRoot, st, depth + 1));
      if (st.capped) break;
    }
  }
  return out;
}

/**
 * The cheap test of what the user can see (§3.1; the review's m-4), run for every input: a box of at least 8 by 8 px that is
 * not display:none, hidden, transparent (itself or an ancestor), inert or aria-hidden, not clipped away (clip, clip-path), and
 * not placed outside the document's area. The deep test is `look`, below.
 */
const shown = (el: Element) => {
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
    return false;
  if (el.closest("[inert],[aria-hidden=true]")) return false;
  const de = document.documentElement;
  if (r.right <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= Math.max(de.scrollWidth, innerWidth)) return false;
  const cs = getComputedStyle(el);
  return cs.clipPath === "none" && !/^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(cs.clip);
};
const usable = (el: HTMLInputElement) => TYPES.includes(el.type) && !el.disabled && !el.readOnly && shown(el);

// ---- is it really seen (the second review's F2) ----------------------------------------------------------------------
// `shown` reads the box itself and is cheap (every input goes through it). `look` is the deep test, run only for the few boxes
// that qualify and again at the fill: the ancestors (a filter, a mask, a clip by an overflow), the ink (a box whose typed
// digits cannot be seen is accepted only as the real input of an OTP widget, laid over the slots that draw the digits) and
// a hit test (what is on top at the middle of the visible part of the box). It is a heuristic about what a person sees, not a
// proof: a page can still fool it (docs/design/notes/AUTOFILL1-NOTES.md D20); what it cannot do is get the code anywhere
// but into a box of a page that is registered for the account.
const MAX_UP = 40;
const MAX_SLOTS = 80;
/** The alpha of a computed colour ("rgba(0, 0, 0, 0)", "rgb(0 0 0 / 0)", "color(srgb 0 0 0 / 50%)"); 1 when it is not told. */
const alphaOf = (c: string) => {
  const m = /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(c) ?? /^rgba\((?:[^,]+,){3}\s*([\d.]+)()\s*\)\s*$/.exec(c);
  if (!m) return 1;
  const a = parseFloat(m[1]!);
  return m[2] ? a / 100 : a;
};
const parentOf = (n: Element): Element | null => {
  if (n.parentElement) return n.parentElement;
  const r = n.getRootNode();
  return r instanceof ShadowRoot ? r.host : null;
};
/** Something drawn: a border, a background, or a short text of its own (the slot of an OTP widget). */
function painted(e: Element, cs: CSSStyleDeclaration) {
  if (cs.visibility !== "visible") return false;
  for (const side of ["top", "right", "bottom", "left"])
    if (
      parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 &&
      cs.getPropertyValue(`border-${side}-style`) !== "none" &&
      alphaOf(cs.getPropertyValue(`border-${side}-color`)) > 0
    )
      return true;
  return (
    alphaOf(cs.backgroundColor) > 0 ||
    cs.backgroundImage !== "none" ||
    (e.childElementCount === 0 && textOf(e, 4) !== "")
  );
}
/** The element (one or two levels above the box) that holds at least four drawn slots within the box's area, or null. */
function slotsOf(el: HTMLInputElement, r: DOMRect): Element | null {
  let seen = 0;
  for (let up = el.parentElement, i = 0; up && i < 2; up = up.parentElement, i++) {
    let n = 0;
    for (const e of up.querySelectorAll("*")) {
      if (++seen > MAX_SLOTS) return null;
      if (e === el) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 8 || b.height < 8 || b.left < r.left - 4 || b.right > r.right + 4) continue;
      if (b.top < r.top - 4 || b.bottom > r.bottom + 4) continue;
      if (painted(e, getComputedStyle(e)) && ++n >= 4) return up;
    }
  }
  return null;
}
/** The element on top at a point of the viewport, looking into open shadow roots. */
function topAt(x: number, y: number): Element | null {
  let t = document.elementFromPoint(x, y);
  for (let i = 0; t?.shadowRoot && i < MAX_DEPTH; i++) {
    const inner = t.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === t) break;
    t = inner;
  }
  return t;
}
/** 0: the user cannot see this box; 1: its digits are invisible but it lies over drawn slots (an OTP widget); 2: seen. */
function look(el: HTMLInputElement): 0 | 1 | 2 {
  if (!shown(el)) return 0;
  const r = el.getBoundingClientRect();
  for (let n: Element | null = el, i = 0; n && i < MAX_UP; n = parentOf(n), i++) {
    const cs = getComputedStyle(n);
    if (/opacity\(\s*0(?:\.0+)?%?\s*\)/.test(cs.filter)) return 0;
    for (const m of ["mask-image", "-webkit-mask-image"]) {
      const v = cs.getPropertyValue(m);
      if (v !== "" && v !== "none") return 0;
    }
    if (n !== el && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
      const a = n.getBoundingClientRect(); // clipped by an ancestor that has no room for the box
      if (a.width < 1 || a.height < 1 || a.right <= r.left || a.left >= r.right) return 0;
      if (a.bottom <= r.top || a.top >= r.bottom) return 0;
    }
  }
  const cs = getComputedStyle(el);
  const ink = alphaOf(cs.color) > 0 && alphaOf(cs.webkitTextFillColor) > 0 && parseFloat(cs.fontSize) >= 1;
  const slots = ink ? null : slotsOf(el, r);
  if (!ink && !slots) return 0;
  const x0 = Math.max(r.left, 0);
  const x1 = Math.min(r.right, innerWidth);
  const y0 = Math.max(r.top, 0);
  const y1 = Math.min(r.bottom, innerHeight);
  if (x1 - x0 >= 1 && y1 - y0 >= 1) {
    const t = topAt((x0 + x1) / 2, (y0 + y1) / 2);
    const ok =
      t === el ||
      (!!t && [...(el.labels ?? [])].some((l) => l === t || l.contains(t))) ||
      (!!t && !!slots && slots.contains(t));
    if (!ok) return 0;
  }
  return ink ? 2 : 1;
}

/**
 * Text this long is no label (a block of the page): its spaces are not collapsed and it is not used (R3-VERIFY §4, the soft
 * budget). The ends are trimmed first, which costs only the padding, so a label padded with spaces is still a label (the FU
 * verify's NIT: collapsing all the text first would bring back the cost the limit takes away).
 */
const TEXT_MAX = 4096;
const textOf = (el: Element | null | undefined, cap = 140) => {
  const raw = (el?.textContent ?? "").trim();
  if (raw.length > TEXT_MAX) return "";
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length <= cap ? t : "";
};
/** The most labels and `aria-labelledby` targets read for one box, and the most of an attribute's text read (a label is short). */
const MAX_REFS = 8;
const ATTR_MAX = 256;

/** The words that name a box: its labels, ARIA names, placeholder, title, and short text next to it (exported for its unit test). */
export function labelOf(el: HTMLInputElement, rows: Map<Element, number>): string {
  const parts: string[] = [];
  for (const l of [...(el.labels ?? [])].slice(0, MAX_REFS)) parts.push(textOf(l));
  parts.push(...[el.getAttribute("aria-label") ?? "", el.placeholder, el.title].map((x) => x.slice(0, ATTR_MAX)));
  // each element named once, and a few at most: a page that names one big block 200 times would hold its own look up (R3-VERIFY)
  const ids = new Set(
    (el.getAttribute("aria-labelledby") ?? "")
      .slice(0, ATTR_MAX * 4)
      .split(/\s+/)
      .filter(Boolean),
  );
  for (const id of [...ids].slice(0, MAX_REFS))
    parts.push(textOf((el.getRootNode() as Document | ShadowRoot).getElementById?.(id)));
  parts.push(textOf(el.previousElementSibling, 80));
  // the box's own wrapper, when it holds little besides the box (a form row), and one level above that
  for (let up: Element | null = el.parentElement, n = 0; up && n < 2; up = up.parentElement, n++)
    if ((rows.get(up) ?? 0) <= 1) parts.push(textOf(up, 120));
  return parts.join(" ");
}

const idsOf = (el: HTMLInputElement) =>
  [el.name, el.id, el.className && typeof el.className === "string" ? el.className : "",
    ...[...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `${a.name.slice(5)} ${a.value.slice(0, 40)}`),
  ].join(" "); // prettier-ignore

const featOf = (el: HTMLInputElement, segments: number, alone: boolean, rows: Map<Element, number>): Feat => ({
  type: el.type,
  autocomplete: el.getAttribute("autocomplete") ?? "",
  inputmode: el.getAttribute("inputmode") ?? "",
  pattern: el.getAttribute("pattern") ?? "",
  max: el.maxLength > 0 ? el.maxLength : 0,
  ids: idsOf(el),
  label: labelOf(el, rows),
  segments,
  urlHint: URL_HINT.test(location.pathname),
  alone,
});

/** Boxes of about one width on one line (§3.3): what makes separate boxes one code's group. */
function oneRow(g: HTMLInputElement[]): boolean {
  const w = g.map((b) => b.getBoundingClientRect().width);
  const y = g.map((b) => Math.round(b.getBoundingClientRect().top / 8));
  return Math.max(...w) <= Math.min(...w) * 1.3 && new Set(y).size === 1;
}

/**
 * What is read of a box or a group for its score: its first box's features, and for a group the words around it (two levels
 * up): the group's own name, which none of its boxes carries ("Enter the code", or "Card number").
 */
const groupFeat = (els: HTMLInputElement[], alone: boolean): Feat => {
  const f = featOf(els[0]!, els.length > 1 ? els.length : 0, alone, rowsOf);
  if (els.length > 1) f.label += " " + textOf(els[0]!.parentElement?.parentElement, 120);
  return f;
};

/** Groups of 4 to 8 one-character boxes under one parent (up to three levels up), of about one size (§3.3). */
function groupsOf(boxes: HTMLInputElement[]): HTMLInputElement[][] {
  const ones = boxes.filter((b) => b.maxLength === 1 && usable(b));
  const out: HTMLInputElement[][] = [];
  const taken = new Set<HTMLInputElement>();
  for (let level = 1; level <= 3; level++) {
    const by = new Map<Element, HTMLInputElement[]>();
    for (const b of ones) {
      if (taken.has(b)) continue;
      let up: Element | null = b;
      for (let i = 0; i < level && up; i++) up = up.parentElement;
      if (up) by.set(up, [...(by.get(up) ?? []), b]);
    }
    for (const g of by.values()) {
      if (g.length < 4 || g.length > 8 || !oneRow(g)) continue;
      out.push(g);
      for (const b of g) taken.add(b);
    }
  }
  return out;
}

// ---- inspect ----------------------------------------------------------------------------------------------------
/** What inspect() says of one box or group. `t`: the one-use token fill() takes. */
export type Found = {
  t: string;
  /** 0 a single box, 1 a group of one-character boxes. */
  k: 0 | 1;
  /** The group's size, or a single box's longest value (0: no limit). */
  n: number;
  s: number;
  /** The label says the code was sent by SMS, e-mail or a call. */
  sent: boolean;
  /** Below the threshold: only the box that has focus, offered as an explicit choice. */
  weak: boolean;
  /** A few words from the page naming the box, for choosing between boxes; text only, never trusted. */
  lab: string;
  /** 1: a site rule named this box or group; absent for the heuristics' own. Never sent anywhere: the Fill paths' only. */
  r?: 1;
};
export type Inspected = {
  /** This frame's origin and the origins of all its ancestors, nearest first (location.ancestorOrigins). */
  o: string;
  a: string[];
  top: boolean;
  /** The found boxes, best first (at most 4). */
  c: Found[];
  /** How many visible frames of another site this document holds: the browser does not let activeTab into them. */
  x: number;
  /** 1: the page has more inputs than one look reads, or the look ran out of time: "too complex", no boxes reported. */
  z: 0 | 1;
};

/**
 * What a token stands for: its boxes, who made it, and a rule's strategy for them. `h`: the heuristics' (every look makes
 * these); `r`: a site rule's (only a look with an argument makes, replaces or drops these: R3-1). A token belongs to its
 * first box and its kind and is the same at every look, so a second look (the side panel's, while the shortcut is filling;
 * the content script's, while the popup waits for the next code) does not take the first one's tokens away, and an `h`
 * entry and an `r` entry of one box never share a token (M2); a fill spends its token until the next look.
 */
type Entry = { els: HTMLInputElement[]; kind: "h" | "r"; how: 0 | 1 | 2 };
const live = new Map<string, Entry>();
const ids = new WeakMap<Element, { h?: string; r?: string }>();
const token = (first: Element, kind: "h" | "r") => {
  let m = ids.get(first);
  if (!m) ids.set(first, (m = {}));
  let t = m[kind];
  if (!t) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    t = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    m[kind] = t;
  }
  return t;
};
const cleanLabel = (s: string) =>
  s
    .replace(/[\p{C}\p{Z}]+/gu, " ")
    .trim()
    .slice(0, 32);

/** How many inputs sit under each element up to four levels above an input: a wrapper holding one box is that box's row. */
let rowsOf = new Map<Element, number>();
const rowCounts = (raw: HTMLInputElement[]) => {
  const m = new Map<Element, number>();
  for (const b of raw) {
    if (b.type === "hidden" || b.type === "checkbox") continue;
    let up = b.parentElement;
    for (let i = 0; i < 4 && up; i++, up = up.parentElement) m.set(up, (m.get(up) ?? 0) + 1);
  }
  return m;
};

// ---- a site rule's hint (TOTP autofill Stage 3, AF3-2) ------------------------------------------------------------
// `Hint` is what src/core/rules/lookup.ts hintOf makes of the rule found for the top page's host: that host, its pages
// (path prefix, selector, segments, strategy), its "sent" flag.
// The selector grammar as src/core/rules/format.ts selectorOk has it (test/unit/rules-engine.test.ts holds the two to the same
// samples): the extension checked the rule already, and this copy does not take its caller's word for it.
const SEL =
  /([a-z][a-z0-9-]*)|(#-?[A-Za-z_][A-Za-z0-9_-]*)|(\.-?[A-Za-z_][A-Za-z0-9_-]*)|(\[[a-z][a-z0-9_-]*(?:\^?="[ !#-\x5b\x5d-~]*"|~="[!#-\x5b\x5d-~]+")?\])|( > | )/y;
export function selOk(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 200) return false;
  let compounds = 1;
  let simple = 0;
  let idn = 0;
  SEL.lastIndex = 0;
  while (SEL.lastIndex < s.length) {
    const at = SEL.lastIndex;
    const m = SEL.exec(s);
    if (!m || m.index !== at) return false;
    if (m[5] !== undefined) {
      if (simple === 0 || ++compounds > 8) return false;
      simple = idn = 0;
      continue;
    }
    if ((m[1] !== undefined && simple > 0) || (m[2] !== undefined && ++idn > 1)) return false;
    simple++;
  }
  return simple > 0;
}
const PATH_OK = /^\/[!$-)+-;=@-\[\]_a-z|~]*$/;
const keysAre = (o: object, k: string) => Object.keys(o).sort().join() === k;
/** The hint if it has the shape and bounds of one (the checker's: format.ts), else null: then the heuristics alone. */
export function readHint(h: unknown): Hint | null {
  if (!h || typeof h !== "object" || Array.isArray(h) || !keysAre(h, "d,p,sent")) return null;
  const { d, p, sent } = h as Hint;
  if (!Array.isArray(d) || !d.length || d.length > 16 || !d.every((x) => typeof x === "string" && x.length <= 253))
    return null;
  if (!Array.isArray(p) || !p.length || p.length > 8 || typeof sent !== "boolean") return null;
  for (const e of p) {
    if (!e || typeof e !== "object" || !keysAre(e, "at,how,n,sel")) return null;
    if (typeof e.at !== "string" || e.at.length > 128 || !PATH_OK.test(e.at) || !selOk(e.sel)) return null;
    if (!(e.n === 0 || (Number.isInteger(e.n) && e.n >= 4 && e.n <= 8))) return null;
    if (![0, 1, 2].includes(e.how) || (e.n === 0 && e.how !== 0)) return null;
  }
  return h as Hint;
}

/** A box or group of the look: its boxes, what was read of them, its score, who made it, and a rule's strategy. */
type Cand = { els: HTMLInputElement[]; f: Feat; sc: Scored; kind: "h" | "r"; how: 0 | 1 | 2 };
/**
 * The boxes the hint names here: only where location.hostname is its host and location.pathname starts with an entry's
 * path. An entry counts its usable matches only, and is void if any of them may not be promoted (boostable: S1), if they
 * are not exactly one box (n 0; and not a box of a heuristic group) or exactly n boxes on one line of about one size, if
 * one of them is an earlier entry's, or if its selector throws (R4-2: that entry is skipped, nothing else). What it names
 * gets RULE_BOOST, and the rule's "sent" flag.
 */
function ruleCands(hint: Hint, all: HTMLInputElement[], inGroup: Set<HTMLInputElement>, alone: boolean): Cand[] {
  if (!hint.d.includes(location.hostname.replace(/\.$/, ""))) return [];
  const out: Cand[] = [];
  const used = new Set<HTMLInputElement>();
  for (const e of hint.p) {
    if (over()) break;
    if (!location.pathname.startsWith(e.at)) continue;
    let els: HTMLInputElement[];
    try {
      els = all.filter((el) => el.matches(e.sel)).filter(usable);
    } catch {
      continue;
    }
    if (e.n === 0 ? els.length !== 1 || inGroup.has(els[0]!) : els.length !== e.n || !oneRow(els)) continue;
    if (els.some((el) => used.has(el))) continue;
    if (!els.every((el) => boostable(el.type, score(featOf(el, e.n, alone, rowsOf))))) continue;
    const f = groupFeat(els, alone);
    const sc = score(f);
    // and the group as the page names it: boxes under "Card number" or "Phone number" are no code (the review of AF3-2, S1)
    if (!boostable(els[0]!.type, sc)) continue;
    out.push({
      els,
      f,
      sc: { ...sc, score: sc.score + RULE_BOOST, sent: sc.sent || hint.sent },
      kind: "r",
      how: e.how,
    });
    for (const el of els) used.add(el);
  }
  return out;
}

/**
 * Null for a document the finder does not work in: no http(s) address (a blob:, an about: page) or no host name. With an
 * argument (a hint, or null), the look owns the `r` entries: it drops every one it does not make again this time (R3-1).
 */
function inspect(hintArg?: unknown): Inspected | null {
  const hinted = arguments.length > 0;
  // boxes that left the page; and, for a look with an argument, the rule-made entries of the last such look
  for (const [t, e] of live) if (!e.els.every((x) => x.isConnected) || (hinted && e.kind === "r")) live.delete(t);
  deadline = performance.now() + BUDGET_MS;
  work = 0;
  if (!/^https?:$/.test(location.protocol) || !location.hostname) return null;
  const done = (c: Found[], z: 0 | 1): Inspected => ({
    o: location.origin,
    a: location.ancestorOrigins ? [...location.ancestorOrigins] : window === window.top ? [] : ["?"],
    top: window === window.top,
    c,
    x: Math.min(
      99,
      [...document.querySelectorAll("iframe")].slice(0, 200).filter((f) => shown(f) && f.contentDocument === null)
        .length,
    ),
    z,
  });
  const st = { nodes: 0, capped: false };
  const raw = inputsOf(document, st);
  if (st.capped || raw.length > MAX_INPUTS) return done([], 1); // too many to look through in the time a click may take
  rowsOf = rowCounts(raw);
  const all = raw.filter((el) => TYPES.includes(el.type) || el.type === "search" || el.type === "email");
  const visiblePassword = all.some((b) => b.type === "password" && usable(b) && !/otp|code|token/i.test(b.name + b.id));
  const groups = groupsOf(all);
  const inGroup = new Set(groups.flat());
  const single = all.filter((b) => !inGroup.has(b) && usable(b) && b.type !== "search" && b.type !== "email");
  const alone = !visiblePassword && single.length + groups.length === 1;
  const hint = hinted ? readHint(hintArg) : null;
  const pool: Cand[] = hint ? ruleCands(hint, all, inGroup, alone) : [];
  const taken = new Set(pool.flatMap((c) => c.els)); // the boxes a rule's entry stands for
  for (const els of groups) {
    if (els.some((e) => taken.has(e))) continue;
    const f = groupFeat(els, alone);
    const sc = score(f);
    // every box of the group, not only the first: one that is no code box makes the group none (S1)
    const veto = els.slice(1).some((e) => score(featOf(e, els.length, alone, rowsOf)).veto);
    pool.push({ els, f, sc: veto ? { ...sc, score: -100, veto } : sc, kind: "h", how: 0 });
  }
  for (const el of single) {
    if (over()) return done([], 1);
    if (taken.has(el)) continue;
    const f = featOf(el, 0, alone, rowsOf);
    pool.push({ els: [el], f, sc: score(f), kind: "h", how: 0 });
  }
  pool.sort((x, y) => y.sc.score - x.sc.score);
  // the qualifying boxes the user can see (the deep test, F2); a page with more than a few of them has no one box to pick
  const ranked = pool.filter((p) => p.sc.score >= THRESHOLD);
  if (ranked.length > MAX_DEEP) return done([], 1);
  const seen: { p: (typeof pool)[number]; k: 1 | 2 }[] = [];
  for (const p of ranked) {
    if (over()) return done([], 1);
    const ks = p.els.map(look);
    if (!ks.includes(0)) seen.push({ p, k: ks.includes(1) ? 1 : 2 });
  }
  // a plainly visible box is preferred to a widget's (a page offering both gets the visible one)
  const plain = seen.some((x) => x.k === 2);
  const picked = seen
    .filter((x) => !plain || x.k === 2)
    .map((x) => x.p)
    .slice(0, 4);
  // a box with the focus that is below the threshold: offered only as an explicit choice (§3.1), never when it is vetoed
  const focus = document.activeElement;
  if (focus instanceof HTMLInputElement && usable(focus) && !picked.some((p) => p.els.includes(focus))) {
    const own = pool.find((p) => p.els[0] === focus);
    if (own && !own.sc.veto && own.sc.score >= 0 && focus.type !== "password" && look(focus) > 0) picked.push(own);
  }
  const c: Found[] = picked.map((p) => {
    const t = token(p.els[0]!, p.kind);
    live.set(t, { els: p.els, kind: p.kind, how: p.how });
    const ml = p.els[0]!.maxLength;
    return {
      t,
      k: p.els.length > 1 ? 1 : 0,
      n: p.els.length > 1 ? p.els.length : ml > 0 ? ml : 0,
      s: Math.round(p.sc.score),
      sent: p.sc.sent,
      weak: p.sc.score < THRESHOLD,
      lab: cleanLabel(p.f.label),
      ...(p.kind === "r" ? { r: 1 as const } : {}),
    };
  });
  return done(c, 0);
}

/** The heuristics' token of the box or group `el` is one of, as the last look found it; null for anything else (suggest.js, which
 * looks without a hint: it never sees a rule's entry). */
function of(el: unknown): string | null {
  for (const [t, e] of live) if (e.kind === "h" && e.els.includes(el as HTMLInputElement)) return t;
  return null;
}

// ---- fill -------------------------------------------------------------------------------------------------------
/** `moved`: the box kept the code and then the page hid or removed it (a page that moves on at the last digit). */
export type Failed = "args" | "origin" | "frame" | "gone" | "digits" | "refused" | "moved";
export type Filled = { ok: true; how: "single" | "chars" | "paste" } | { ok: false; r: Failed };

const isIp = (h: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
/** match.ts coveredBy: the host is the domain or a subdomain of it, on label boundaries; an IP address only equals. */
export const covered = (host: string, domain: string) => {
  const h = host.replace(/\.$/, ""); // "app.example.com." is the same host
  return h === domain || (!isIp(h) && !isIp(domain) && h.endsWith("." + domain));
};
const hostOfOrigin = (o: string) => {
  try {
    return new URL(o).hostname;
  } catch {
    return "";
  }
};

const nativeSetter = () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
function put(el: HTMLInputElement, v: string, data: string | null) {
  // the native setter, not `el.value =`: a framework (React) that wraps the property on the element would otherwise see
  // its own write and ignore the event that follows
  const set = nativeSetter();
  if (set) set.call(el, v);
  else el.value = v;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const readBack = (els: HTMLInputElement[]) => els.map((e) => e.value).join("");

/**
 * Type `code` into the box `t` that inspect() found in this document. Checks, in this order, and writes nothing unless
 * all pass: the arguments (a 6 to 8 digit code; an http(s) origin; a host name), this document's own origin and host
 * against what the extension matched (`origin`, `domain`), the frame rule (§3.5: a frame fills only if every ancestor,
 * and the top page, are covered by the same domain, and the top page is the `top` the extension looked at), that the
 * document is on screen (`visibilityState`: not a tab in the background, a minimised window or a page in the
 * back-forward cache; AUTOFILL2-PLAN-REVIEW m2, checked here because this runs in the page in one go, right at the
 * write), that the box is still there and still a code box, and that the code fits (a group of the code's length; a
 * single box that takes at least that many characters). Then it types and reads the value back; a box that does not
 * keep the code is a failure.
 */
async function fill(code: string, origin: string, domain: string, top: string, t: string): Promise<Filled> {
  if (
    typeof code !== "string" ||
    !/^\d{6,8}$/.test(code) ||
    typeof origin !== "string" ||
    !/^https?:\/\//.test(origin) ||
    typeof top !== "string" ||
    typeof t !== "string" ||
    typeof domain !== "string" ||
    !/^[a-z0-9._[\]:-]{1,253}$/.test(domain)
  )
    // prettier-ignore
    return { ok: false, r: "args" };
  if (location.origin !== origin || !covered(location.hostname, domain)) return { ok: false, r: "origin" };
  if (window === window.top) {
    if (top !== location.origin) return { ok: false, r: "frame" };
  } else {
    const a = location.ancestorOrigins;
    if (!a || !a.length || a[a.length - 1] !== top) return { ok: false, r: "frame" };
    for (const x of a) if (!covered(hostOfOrigin(x), domain)) return { ok: false, r: "frame" };
  }
  if (document.visibilityState !== "visible") return { ok: false, r: "gone" };
  const entry = live.get(t);
  const els = entry?.els ?? [];
  if (!entry || !els.length || !els.every((e) => e.isConnected && usable(e) && look(e) > 0))
    return { ok: false, r: "gone" };
  // every box, not only the first: no veto; for a rule's entry, none it may not promote either (S1)
  const scs = els.map((e) => score(featOf(e, els.length > 1 ? els.length : 0, false, rowsOf)));
  if (scs.some((x, i) => x.veto || (entry.kind === "r" && !boostable(els[i]!.type, x))))
    return { ok: false, r: "gone" };
  // a rule's group as the page names it now, as the look judged it (S1)
  if (entry.kind === "r" && !boostable(els[0]!.type, score(groupFeat(els, false)))) return { ok: false, r: "gone" };
  // a box a rule groups with others is never filled alone, under the heuristics' token (M2)
  if (entry.kind === "h")
    for (const o of live.values())
      if (o.kind === "r" && o.els.length > 1 && els.some((e) => o.els.includes(e))) return { ok: false, r: "gone" };
  if (els.length > 1 ? els.length !== code.length : els[0]!.maxLength > 0 && els[0]!.maxLength < code.length)
    return { ok: false, r: "digits" };
  live.delete(t);
  if (els.length === 1) {
    const el = els[0]!;
    put(el, code, code);
    await sleep(40);
    if (el.value !== code) return { ok: false, r: "refused" };
    return look(el) > 0 ? { ok: true, how: "single" } : { ok: false, r: "moved" };
  }
  // each box is set directly: no focus call (a page's focus handler runs synchronously and could hold the fill up)
  const chars = async () => {
    [...code].forEach((ch, i) => put(els[i]!, ch, ch));
    await sleep(40);
    return readBack(els) === code;
  };
  // a group whose boxes the page rewrites: one paste on the first box, which many components split across the rest
  const paste = async () => {
    for (const el of els) put(el, "", null);
    const dt = new DataTransfer();
    dt.setData("text/plain", code);
    els[0]!.focus({ preventScroll: true });
    els[0]!.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true, composed: true }),
    );
    await sleep(40);
    return readBack(els) === code;
  };
  // the strategy: the heuristics' order (chars, then paste); a rule's "chars" (no paste), or "paste" first (then chars)
  const ways: ["chars" | "paste", () => Promise<boolean>][] =
    entry.how === 1
      ? [["chars", chars]]
      : entry.how === 2
        ? [
            ["paste", paste],
            ["chars", chars],
          ]
        : [
            ["chars", chars],
            ["paste", paste],
          ];
  for (const [how, way] of ways)
    if (await way()) return els.every((e) => look(e) > 0) ? { ok: true, how } : { ok: false, r: "moved" };
  return { ok: false, r: "refused" };
}

// ---- one finder per page ----------------------------------------------------------------------------------------
// Every look installs this file again (the install is a call of its own and cannot ask first), and two looks can overlap: the
// side panel looks again when the tab changes or the icon is clicked, while the shortcut is between its own look and its fill.
// A fresh copy would start with an empty table of boxes, and that fill would find its box gone (found by the https shortcut
// test, which failed now and then). So a copy of the same build that finds one already in this world hands every call to
// it: the table, and the tokens, are the first copy's. The world is Sixkey's own isolated world; the page cannot reach it.
// A copy of another build (Sixkey was updated while the page stayed open, and the browser kept the world) starts afresh.
declare const __SK_ENGINE__: string | undefined;
const BUILD = typeof __SK_ENGINE__ === "string" ? __SK_ENGINE__ : "";
type One = { b: string; inspect: typeof inspect; fill: typeof fill; of: typeof of };
const was = (globalThis as { __skOtp?: Partial<One> }).__skOtp;
const one: One =
  BUILD !== "" &&
  was?.b === BUILD &&
  typeof was.inspect === "function" &&
  typeof was.fill === "function" &&
  typeof was.of === "function"
    ? (was as One)
    : { b: BUILD, inspect, fill, of };
const b = one.b;
const inspectOne = one.inspect;
const fillOne = one.fill;
const ofOne = one.of;
export { b, inspectOne as inspect, fillOne as fill, ofOne as of };
