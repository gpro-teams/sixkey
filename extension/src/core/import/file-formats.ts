// Reading another app's export, recognised by its content (never by its file name): a list of otpauth:// links (any
// mix with otpauth-migration://), the unencrypted JSON exports of Aegis, 2FAS, andOTP, Raivo, Bitwarden, FreeOTP+ and
// Proton Authenticator, any other JSON that carries otpauth:// links or secret-bearing objects, CSV with a link or
// secret column, and plain key lines. Encrypted exports are recognised and named, never opened; a Sixkey backup is
// left to the Backup section. The formats, their sources and what is not supported: IMPORT-FILE-NOTES.md §3.
//
// Every account found becomes one otpauth:// line, checked here by the same parser the paste box uses
// (parseOtpauth, parseMigrationUri): only lines that parse reach the importer, and every other one is reported with a
// position, the account's name and a reason. Nothing is taken with parameters it did not have: a value that is there but
// cannot be read (a JSON `true`, a list, a link cut short) refuses the entry, never falls back to SHA-1, 6 digits, 30 s.
// A secret is never put into a reason, a name or an error, and nothing here logs. Pure and bounded: the entry points
// never throw, and every scan is linear in the text (no regular expression here can backtrack over a long run), which
// the caller has already capped (file-text.ts MAX_TEXT_BYTES), with caps on lines, accounts and JSON depth below.
import { encodeBase32, normalizeBase32 } from "../totp/base32";
import { parseMigrationUri, type MigrationError } from "../totp/migration";
import { issuerPrefixed, parseOtpauth, type OtpauthError } from "../totp/otpauth";
import { fitsLimits, LIMITS } from "../vault/validate";
import { MIN_TEXT_KEY, planImport } from "./importer";

/** Lines of a text file looked at; a file with more is refused. */
export const MAX_LINES = 200_000;
/** Accounts one file may bring: the vault's own limit. */
export const MAX_ACCOUNTS = LIMITS.entries;
/** A line longer than this is skipped unread (a Google export link is at most 256 KiB, migration.ts). */
export const MAX_LINE = 300 * 1024;
/** JSON nested deeper than this is not an export, and is not parsed. */
export const MAX_DEPTH = 64;
/** Values the JSON walker visits at most. */
export const MAX_NODES = 200_000;

export type Format =
  "links" | "aegis" | "2fas" | "andotp" | "raivo" | "bitwarden" | "freeotp" | "proton" | "json" | "csv" | "plain";

/** Why one line or entry was not taken. Each has words on screen (AddAccounts.tsx). */
export type SkipReason = OtpauthError | MigrationError | "too_long" | "not_otpauth";

/** One line or entry not taken: its 1-based position, its name (issuer and account, when the file has them), why. */
export type Skip = { at: number; name: string; reason: SkipReason };

export type FileRead =
  | {
      kind: "accounts";
      format: Format;
      /** otpauth:// and otpauth-migration:// links that parse, one account (or one export code) each, in file order */
      lines: string[];
      skipped: Skip[];
      /** accounts of a kind Sixkey cannot make codes for (Steam, mOTP, Yandex, ...), counted by kind */
      types: { type: string; n: number }[];
    }
  | { kind: "encrypted"; app: string }
  | { kind: "sixkey_backup" }
  | { kind: "html" } // a web page export (Ente's, Raivo's): its codes are pictures, there is no link text in it
  | { kind: "too_large" }
  | { kind: "nothing" };

const NOTHING: FileRead = { kind: "nothing" };
const TOO_LARGE: FileRead = { kind: "too_large" };

// ---- collecting accounts --------------------------------------------------------------------------------------------

/** An account as an export describes it, before it is checked. Every field as written. */
type Cand = {
  type?: unknown;
  issuer?: unknown;
  label?: unknown;
  secret: string;
  algorithm?: unknown;
  digits?: unknown;
  period?: unknown;
  counter?: unknown;
};

/** A link scheme at the start of a text: the ones Sixkey reads, and the ones it counts as kinds it cannot make. */
const SCHEME = /^(?:otpauth(?:-migration)?|steam|motp):\/\//i;

class Found {
  lines: string[] = [];
  skipped: Skip[] = [];
  private kinds = new Map<string, number>();
  over = false;
  constructor(readonly format: Format) {}

  private push(line: string): void {
    if (this.lines.length >= MAX_ACCOUNTS) this.over = true;
    else this.lines.push(line);
  }
  skip(at: number, name: string, reason: SkipReason): void {
    if (this.skipped.length < MAX_ACCOUNTS) this.skipped.push({ at, name, reason });
  }
  kind(type: string): void {
    this.kinds.set(type, (this.kinds.get(type) ?? 0) + 1);
  }

  /** A link as found in a file or a QR code. `name` is used only to report it when it cannot be read. */
  link(raw: string, at: number, name = ""): void {
    const uri = unescapeAmp(wellFormed(raw.trim()));
    if (uri.length > MAX_LINE) return this.skip(at, name, "too_long");
    // an `&amp;` still there after decoding (escaped more than four times): its parameters cannot be read as written
    if (/&(?:amp|#0*38|#x0*26);/i.test(uri)) return this.skip(at, name || nameOfLink(uri), "malformed");
    if (/^steam:\/\//i.test(uri)) return this.kind("Steam");
    if (/^motp:\/\//i.test(uri)) return this.kind("mOTP");
    if (/^otpauth-migration:\/\//i.test(uri)) {
      const m = parseMigrationUri(uri);
      return m.ok ? this.push(uri) : this.skip(at, name, m.error);
    }
    const type = /^otpauth:\/\/([^/?#]*)/i.exec(uri)?.[1];
    if (type === undefined) return this.skip(at, name, "not_otpauth");
    const other = otherKind(type);
    if (other) return this.kind(other);
    if (other === "") return this.skip(at, name || nameOfLink(uri), "unsupported_type");
    // Some apps write Steam as a TOTP link with encoder=steam: its codes are not TOTP digits, so it is never taken as one.
    // The parameter is read as the importer reads it (decoded, so %73team is steam too).
    if (isSteamEncoder(uri)) return this.kind("Steam");
    // a word after the link, glued onto its secret (`secret=K work` would be the key KWORK): never taken as a key
    if (secretRunsOn(uri)) return this.skip(at, name || nameOfLink(uri), "invalid_secret");
    const r = parseOtpauth(uri);
    if (!r.ok) return this.skip(at, name || nameOfLink(uri), r.error);
    if (!fitsLimits(r.value)) return this.skip(at, name || nameOf(r.value.issuer, r.value.label), "too_long");
    this.push(uri);
  }

  /** An account from a JSON or CSV export, written as a link and checked like one. */
  entry(c: Cand, at: number): void {
    const issuer = wellFormed(text(c.issuer));
    const label = wellFormed(text(c.label));
    const name = nameOf(issuer, label);
    const type = param(c.type);
    if (type === null) return this.skip(at, name, "unsupported_type");
    const t = type.toLowerCase() || "totp";
    const other = otherKind(t);
    if (other) return this.kind(other);
    if (other === "") return this.skip(at, name, "unsupported_type");
    const enc = encodeURIComponent;
    const path = issuer ? `${enc(issuer)}:${enc(label)}` : label.includes(":") ? `:${enc(label)}` : enc(label);
    const q = [`secret=${enc(wellFormed(c.secret))}`];
    if (issuer) q.push(`issuer=${enc(issuer)}`);
    for (const [k, v] of [
      ["algorithm", c.algorithm],
      ["digits", c.digits],
      ["period", t === "totp" ? c.period : undefined],
      ["counter", t === "hotp" ? c.counter : undefined],
    ] as const) {
      const s = param(v);
      // there but unreadable (true, [8], an object, an infinite number): refused, never taken as the default
      if (s === null) return this.skip(at, name, "malformed");
      if (s) q.push(`${k}=${enc(wellFormed(s))}`);
    }
    // HOTP needs its counter: an export that leaves it out starts at 0 (2FAS, Aegis's defaults)
    if (t === "hotp" && !param(c.counter)) q.push("counter=0");
    const uri = `otpauth://${t}/${path}?${q.join("&")}`;
    if (uri.length > MAX_LINE) return this.skip(at, name, "too_long");
    const r = parseOtpauth(uri);
    if (!r.ok) return this.skip(at, name, r.error);
    if (!fitsLimits(r.value)) return this.skip(at, name, "too_long");
    this.push(uri);
  }

  result(): FileRead {
    if (this.over) return TOO_LARGE;
    if (!this.lines.length && !this.skipped.length && !this.kinds.size) return NOTHING;
    return {
      kind: "accounts",
      format: this.format,
      lines: this.lines,
      skipped: this.skipped,
      types: [...this.kinds].map(([type, n]) => ({ type, n })),
    };
  }
}

/**
 * A kind of one-time code Sixkey cannot make, by the name an export gives it (counted and named on screen); null for
 * TOTP and HOTP, which Sixkey stores; "" for a kind that does not read as a name (reported as an unsupported type).
 */
function otherKind(type: string): string | null {
  const t = type.trim().toLowerCase();
  if (t === "totp" || t === "hotp") return null;
  if (t === "steam") return "Steam";
  if (t === "motp") return "mOTP";
  if (t === "yandex") return "Yandex";
  // an unknown kind is named as written, if it reads as a short name; anything else is not echoed at all
  return /^[a-z][a-z0-9_-]{0,11}$/.test(t) ? t.toUpperCase() : "";
}

/** A name field as text: strings trimmed, finite numbers written out, anything else empty. */
function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * A parameter as text: "" when it is not there (undefined, null, an empty string: the format's default applies), the
 * text of a string or a finite number, and null when it is there but cannot be read (a boolean, a list, an object, an
 * infinite number): such an entry is refused, never given the default.
 */
function param(v: unknown): string | null {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null;
}

/** A string with every lone surrogate replaced (encodeURIComponent throws on one), in one linear pass. */
function wellFormed(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++; // a whole pair
        continue;
      }
    }
    out += s.slice(from, i) + "\ufffd";
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}

/** `&amp;` and its numeric spellings, as an HTML page or an e-mail writes a link's separators, back to `&`. */
export function unescapeAmp(s: string): string {
  if (!s.includes("&")) return s;
  // decoded until it no longer changes (`&amp;amp;`, as a page that escaped an escaped link writes it), at most 4 times
  let out = s;
  for (let n = 0; n < 4; n++) {
    const next = out.replace(/&(?:amp|#0*38|#x0*26);/gi, "&");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Whether a link's `secret` value, as written (before any decoding), has white space followed by more text: a word
 * after the link (`…?secret=K work`, `…&secret=K MyPassword`), which decoding would glue onto the key as `KWORK`. A real
 * link writes a space in its key as `%20` or `+`, so nothing that is a key is refused. Linear.
 */
export function secretRunsOn(uri: string): boolean {
  const q = uri.indexOf("?");
  if (q < 0) return false;
  const hash = uri.indexOf("#", q);
  const query = uri.slice(q + 1, hash < 0 ? undefined : hash);
  for (const part of query.split("&")) {
    if (!part.startsWith("secret=")) continue;
    return /\s\S/.test(part.slice(7)); // the first `secret`, as URLSearchParams.get reads it
  }
  return false;
}

/** Whether a link's `encoder` parameter, read as the importer reads parameters, says Steam. */
export function isSteamEncoder(uri: string): boolean {
  const q = uri.indexOf("?");
  if (q < 0 || !/encoder/i.test(uri)) return false;
  const hash = uri.indexOf("#", q);
  try {
    const e = new URLSearchParams(uri.slice(q + 1, hash < 0 ? undefined : hash)).get("encoder");
    return e !== null && e.trim().toLowerCase() === "steam";
  } catch {
    return false;
  }
}

/** At most 64 characters, counted and cut by code point, so that the cut never leaves half of a surrogate pair. */
const clip = (s: string) => {
  const cs = [...s];
  return cs.length > 64 ? cs.slice(0, 63).join("") + "…" : s;
};
/** How a skipped account is named on screen: the issuer and the account, never anything else of the entry. */
function nameOf(issuer: string, label: string): string {
  const i = issuer.trim();
  const l = label.trim();
  return clip(i && l && i.toLowerCase() !== l.toLowerCase() ? `${i} (${l})` : i || l);
}

/** The name in a link that cannot be read: its label and issuer, read without the rest of the query. */
function nameOfLink(uri: string): string {
  const m = /^otpauth:\/\/[^/?#]*\/([^?#]*)(?:\?([^#]*))?/i.exec(uri);
  if (!m) return "";
  let label = "";
  try {
    label = decodeURIComponent(m[1] ?? "");
  } catch {
    return "";
  }
  let issuer = "";
  try {
    issuer = new URLSearchParams(m[2] ?? "").get("issuer") ?? "";
  } catch {
    issuer = "";
  }
  const colon = label.indexOf(":");
  if (!issuer && colon >= 0) return nameOf(label.slice(0, colon), label.slice(colon + 1));
  // the issuer's own prefix, cut as otpauth.ts cuts it: just before a ':' (a case that changes the length never matches)
  if (issuer && issuerPrefixed(label, issuer)) return nameOf(issuer, label.slice(issuer.length + 1));
  return nameOf(issuer, label);
}

// ---- text -------------------------------------------------------------------------------------------------------------

/** The file's lines, at most MAX_LINES; null when there are more. CRLF, CR and LF all end a line. */
function linesOf(t: string): string[] | null {
  const out: string[] = [];
  let at = 0;
  while (at <= t.length) {
    if (out.length >= MAX_LINES) return at >= t.length ? out : null;
    let end = at;
    while (end < t.length && t.charCodeAt(end) !== 10 && t.charCodeAt(end) !== 13) end++;
    out.push(t.slice(at, end));
    if (end < t.length && t.charCodeAt(end) === 13 && t.charCodeAt(end + 1) === 10) end++;
    at = end + 1;
  }
  return out;
}

const isComment = (s: string) => s.startsWith("#") || s.startsWith("//");
const QUOTES = new Set(['"', "'", "`"]);
const isSpace = (c: string) => c === " " || c === "\t" || c === " " || c === "　";

/** A line without what frames a link in a list: surrounding quotes, and trailing commas and semicolons. Linear. */
function unwrap(line: string): string {
  let a = 0;
  let b = line.length;
  for (;;) {
    const a0 = a;
    const b0 = b;
    while (a < b && isSpace(line[a]!)) a++;
    while (b > a && (isSpace(line[b - 1]!) || line[b - 1] === "," || line[b - 1] === ";")) b--;
    if (b - a >= 2 && QUOTES.has(line[a]!) && line[b - 1] === line[a]) {
      a++;
      b--;
    }
    if (a === a0 && b === b0) return line.slice(a, b);
  }
}

/** Trailing punctuation a sentence puts after a link: dropped by a loop from the end (a regex would backtrack). */
function trimSentence(s: string): string {
  let b = s.length;
  while (b > 0 && ".,;:)]}!?".includes(s[b - 1]!)) b--;
  return s.slice(0, b);
}

/** Where a link written inside a table row or a sentence ends: white space, a quote, markup, a list or table separator. */
const STOP = new Set([..."\"'`<>,;|｜"]);
const isStop = (c: string) => STOP.has(c) || isSpace(c);
/** A parameter after a cut: `&name=` or `?name=`. Its presence means the cut fell inside the link. */
const PARAM_AFTER = /[&?][A-Za-z_][A-Za-z0-9_.-]*=/g;
/** The start of a link anywhere in a line. */
const ANY_SCHEME = /(?:otpauth(?:-migration)?|steam|motp):\/\//gi;
/** Separators of a table row in a line that is a link: a column after one is cut off unless it carries on the query. */
const TABLE = new Set([",", ";", "|", "｜", "\t"]);
/** A table cell that carries on a link's query: `name=` at its start, or `&name=` in it. */
const CARRIES_ON = /[^,;|｜\t]*?&[A-Za-z_][A-Za-z0-9_.-]*=|\s*[A-Za-z_][A-Za-z0-9_.-]*=/y;

/** After a table separator: any spaces and quotes, then a link. The cell is the next link of a list on one line. */
const NEXT_LINK = /[\s"'`]*(?:otpauth(?:-migration)?|steam|motp):\/\//iy;
const isQuote = (c: string | undefined) => c === '"' || c === "'" || c === "`";

/**
 * A line that is a link (once its quotes and trailing commas are off) is taken whole, as the paste box takes it: an
 * issuer written `Lowe's`, `Acme, Inc` or with a raw space keeps every parameter after it. A separator followed by
 * another link (`linkA,linkB`, `"A", "B"`) starts the next link: every one of them is read. A table cell that does not
 * carry on the query (`…&period=30,MyPassword`) is cut off, and handed back as `rest`, so a link further along the
 * line is still read, never dropped. Run-together links are split.
 */
function wholeLinks(u: string): { links: string[]; rest: string } {
  const pieces: string[] = [];
  let from = 0;
  let rest = "";
  for (let i = 0; i < u.length; i++) {
    if (!TABLE.has(u[i]!)) continue;
    NEXT_LINK.lastIndex = i + 1;
    if (NEXT_LINK.test(u)) {
      let end = i;
      // `"A", "B"`: the quote that closes A goes with it
      let k = i + 1;
      while (k < u.length && (isSpace(u[k]!) || isQuote(u[k]))) k++;
      const opened = isQuote(u[k - 1]) ? u[k - 1] : undefined;
      while (end > from && isSpace(u[end - 1]!)) end--;
      if (opened && u[end - 1] === opened) end--;
      pieces.push(u.slice(from, end));
      from = k;
      i = k - 1;
      continue;
    }
    CARRIES_ON.lastIndex = i + 1;
    if (!CARRIES_ON.test(u)) {
      pieces.push(u.slice(from, i));
      rest = u.slice(i + 1);
      from = -1;
      break;
    }
  }
  if (from >= 0) pieces.push(u.slice(from));
  return {
    links: pieces
      .flatMap((x) => x.split(SPLIT))
      .map((x) => x.trim())
      .filter(Boolean),
    rest,
  };
}
export const SPLIT = /(?=(?:otpauth(?:-migration)?|steam|motp):\/\/)/i;

/**
 * Links written inside a line (a table row, a sentence, markup). Each ends at the first stop; if the line goes on
 * with a parameter (`&digits=8`) before the next link, the cut fell inside the link, and it is refused rather than
 * taken without the rest of its parameters.
 */
function embeddedLinks(line: string, at: number, f: Found): number {
  const starts: number[] = [];
  ANY_SCHEME.lastIndex = 0;
  for (let m = ANY_SCHEME.exec(line); m; m = ANY_SCHEME.exec(line)) starts.push(m.index);
  if (!starts.length) return 0;
  // every parameter's place in the line, found once, so each link's check is a step along it (linear in the line)
  const params: number[] = [];
  PARAM_AFTER.lastIndex = 0;
  for (let m = PARAM_AFTER.exec(line); m; m = PARAM_AFTER.exec(line)) params.push(m.index);
  let p = 0;
  starts.forEach((s, k) => {
    const next = starts[k + 1] ?? line.length;
    let e = s;
    while (e < next && !isStop(line[e]!)) e++;
    const token = line.slice(s, e);
    if (e < next) {
      while (p < params.length && params[p]! < e) p++;
      if (p < params.length && params[p]! < next) return f.skip(at, nameOfLink(token), "malformed");
    }
    f.link(trimSentence(token), at);
  });
  return starts.length;
}

function readLinks(lines: string[], format: Format = "links"): FileRead {
  const f = new Found(format);
  lines.forEach((raw, i) => {
    if (raw.length > MAX_LINE) return f.skip(i + 1, "", "too_long");
    const line = unescapeAmp(raw.trim());
    if (!line || isComment(line)) return;
    const u = unwrap(line);
    if (SCHEME.test(u)) {
      const { links, rest } = wholeLinks(u);
      for (const part of links) f.link(part, i + 1);
      // a link in a cell further along (`linkA,note,linkB`): read as a link inside a line, never dropped
      if (HAS_LINK.test(rest)) embeddedLinks(rest, i + 1, f);
      return;
    }
    if (embeddedLinks(line, i + 1, f)) return;
    // a line of a JSON array or a table frame is no account; anything else is reported
    if (/^[[\]{},;]*$/.test(line)) return;
    f.skip(i + 1, "", "not_otpauth");
  });
  return f.result();
}

/** Plain key lines (a key alone, or name|key): they go through the paste box's own rules, if any line holds a key. */
function readPlain(lines: string[]): FileRead {
  const kept = lines.map((l) => l.trim()).filter((l) => l && !isComment(l));
  if (!kept.length) return NOTHING;
  if (kept.length > MAX_ACCOUNTS) return TOO_LARGE;
  const { plan } = planImport(kept.join("\n"), []);
  if (!plan.add.length && !plan.table) return NOTHING;
  return { kind: "accounts", format: "plain", lines: kept, skipped: [], types: [] };
}

// ---- CSV --------------------------------------------------------------------------------------------------------------

/**
 * Columns that hold a 2FA key, by their name (normalised: lower case, spaces and hyphens as underscores), in the order
 * they are tried: a link or a bare key. A website column (`url`, `uri`) is never one of them: password managers put the
 * site there, before the TOTP column (KeePassXC, LastPass, Proton Pass, Dashlane, 1Password).
 */
const KEY_COLS = [
  "totp",
  "login_totp",
  "otpauth",
  "otp_auth",
  "otpauth_uri",
  "otpauth_url",
  "otp_uri",
  "otp_url",
  "otpurl",
  "otpuri",
  "otp",
  "otpsecret",
  "otp_secret",
  "totp_secret",
  "two_factor_secret",
  "secret",
  "secret_key",
  "seed",
  "key",
];
const ISSUER_COLS = ["issuer", "issuer_name", "service", "name", "title"];
const LABEL_COLS = ["account", "account_name", "label", "username", "login_username", "login", "user", "email"];

/** One CSV record (RFC 4180 quoting), from `lines` at `i`; a quoted field may span lines. */
function csvRecord(lines: string[], i: number, sep: string): { cells: string[]; next: number } {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  let row = i;
  let line = lines[row] ?? "";
  for (let p = 0; ; p++) {
    if (p >= line.length) {
      if (quoted && row + 1 < lines.length && row - i < 64) {
        cell += "\n";
        line = lines[++row]!;
        p = -1;
        continue;
      }
      cells.push(cell);
      return { cells, next: row + 1 };
    }
    const c = line[p]!;
    if (quoted) {
      if (c === '"' && line[p + 1] === '"') {
        cell += '"';
        p++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === sep) {
      cells.push(cell);
      cell = "";
    } else cell += c;
  }
}

const colName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
const isLinkText = (v: string) => SCHEME.test(v);

/**
 * A CSV file with a header, read only through the columns that hold a 2FA key: a column named for one (KEY_COLS), or
 * one whose cells are links. null when the first line is no such header. The rows are read by column name, so the
 * order of columns does not matter, and no other column (a password, a note, a website) is ever looked at.
 */
function readCsv(lines: string[]): FileRead | null {
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return null;
  const head = lines[first]!;
  if (/otpauth(?:-migration)?:\/\//i.test(head)) return null; // a link on the first line: a list of links
  const sep = [",", ";", "\t"].find((x) => head.includes(x));
  if (!sep) return null;
  const names = csvRecord(lines, first, sep).cells.map(colName);
  if (names.length < 2 || names.some((n) => n.length > 64)) return null;
  const rows: { at: number; cells: string[] }[] = [];
  for (let i = csvRecord(lines, first, sep).next; i < lines.length;) {
    if (!lines[i]!.trim()) {
      i++;
      continue;
    }
    const r = csvRecord(lines, i, sep);
    rows.push({ at: i + 1, cells: r.cells });
    i = r.next;
  }
  const named = KEY_COLS.map((n) => names.indexOf(n)).filter((c) => c >= 0);
  // a column of links, whatever its name (a CSV of the user's own making): found by its cells
  const byValue = names.findIndex((_, c) => rows.some((r) => isLinkText((r.cells[c] ?? "").trim())));
  if (!named.length && byValue < 0) return null;
  const candidates = [...new Set(byValue >= 0 ? [byValue, ...named] : named)];
  const col = (list: readonly string[]) => list.map((n) => names.indexOf(n)).filter((c) => c >= 0);
  const issuerCols = col(ISSUER_COLS);
  const labelCols = col(LABEL_COLS);
  const algCol = col(["algorithm", "algo", "otp_algorithm"])[0] ?? -1;
  const digitsCol = col(["digits", "otp_digits"])[0] ?? -1;
  const periodCol = col(["period", "interval", "timer", "step", "time_step", "otp_period"])[0] ?? -1;
  const typeCol = col(["otp_type", "token_type", "kind", "type"])[0] ?? -1;
  const counterCol = col(["counter"])[0] ?? -1;
  const f = new Found("csv");
  for (const r of rows) {
    const cell = (c: number) => (c >= 0 ? (r.cells[c] ?? "").trim() : "");
    const firstOf = (cols: number[]) => cols.map(cell).find((v) => v !== "") ?? "";
    const issuer = firstOf(issuerCols);
    const label = firstOf(labelCols);
    const name = nameOf(issuer, label);
    // the first key cell of the row with something in it: a link, or (in a column named for a key) a bare key; a row
    // with no key anywhere is a login without 2FA, and there is nothing to say about it
    for (const c of candidates) {
      const v = cell(c);
      if (!v) continue;
      if (isLinkText(v)) f.link(v, r.at, name);
      else if (named.includes(c)) {
        // "type" is an OTP kind only when it reads as one (Bitwarden's "type" column says login or note)
        const kind = cell(typeCol).toLowerCase();
        f.entry(
          {
            type: /^(?:totp|hotp|steam|motp|yandex)$/.test(kind) ? kind : "",
            issuer,
            label,
            secret: v,
            algorithm: cell(algCol),
            digits: cell(digitsCol),
            period: cell(periodCol),
            counter: cell(counterCol),
          },
          r.at,
        );
      } else continue; // a link column's other cell (a note): the row's named key column decides
      break;
    }
  }
  return f.result();
}

// ---- JSON -------------------------------------------------------------------------------------------------------------

/** Whether the JSON text nests deeper than MAX_DEPTH, counted outside strings in one pass, before anything parses it. */
function tooDeep(t: string): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) {
      if (++depth > MAX_DEPTH) return true;
    } else if (c === 125 || c === 93) depth--;
  }
  return false;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const objs = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A key written as bytes (FreeOTP+ writes Java's signed bytes), as base32; null when it is no byte list. */
function bytesSecret(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.secret) return null;
  if (!v.every((b) => Number.isInteger(b) && b >= -128 && b <= 255)) return null;
  return encodeBase32(Uint8Array.from(v as number[], (b) => b & 0xff));
}

function readAegis(db: Obj): FileRead {
  const f = new Found("aegis");
  objs(db.entries).forEach((e, i) => {
    const info = isObj(e.info) ? e.info : {};
    f.entry(
      {
        type: e.type,
        issuer: e.issuer,
        label: e.name,
        secret: str(info.secret),
        algorithm: info.algo,
        digits: info.digits,
        period: info.period,
        counter: info.counter,
      },
      i + 1,
    );
  });
  return f.result();
}

function read2fas(o: Obj): FileRead {
  const f = new Found("2fas");
  objs(o.services).forEach((s, i) => {
    const otp = isObj(s.otp) ? s.otp : {};
    f.entry(
      {
        type: otp.tokenType,
        issuer: str(s.name).trim() || otp.issuer,
        label: otp.account,
        secret: str(s.secret),
        algorithm: otp.algorithm,
        digits: otp.digits,
        period: otp.period,
        counter: otp.counter,
      },
      i + 1,
    );
  });
  return f.result();
}

function readBitwarden(o: Obj): FileRead {
  const f = new Found("bitwarden");
  objs(o.items).forEach((item, i) => {
    const login = isObj(item.login) ? item.login : {};
    const totp = str(login.totp).trim();
    if (!totp) return; // a login without a 2FA key; its password is never read
    const name = nameOf(str(item.name), str(login.username));
    if (/^(?:otpauth(?:-migration)?|steam):\/\//i.test(totp)) return f.link(totp, i + 1, name);
    f.entry({ issuer: str(item.name), label: str(login.username), secret: totp }, i + 1); // a bare key: SHA1, 6, 30
  });
  return f.result();
}

function readFreeOtp(o: Obj): FileRead {
  const f = new Found("freeotp");
  objs(o.tokens).forEach((t, i) => {
    const issuer = str(t.issuerExt) || str(t.issuerInt);
    // FreeOTP+ marks Steam by its issuer and shows 5 characters: never a TOTP here
    if (issuer.trim().toLowerCase() === "steam") return f.kind("Steam");
    const secret = bytesSecret(t.secret);
    if (secret === null) return f.skip(i + 1, nameOf(issuer, str(t.label)), "missing_secret");
    f.entry(
      {
        type: t.type,
        issuer,
        label: t.label,
        secret,
        algorithm: t.algo,
        digits: t.digits,
        period: t.period,
        counter: t.counter,
      },
      i + 1,
    );
  });
  return f.result();
}

function readProton(o: Obj): FileRead {
  const f = new Found("proton");
  objs(o.entries).forEach((e, i) => {
    const c = isObj(e.content) ? e.content : {};
    if (str(c.entry_type).toLowerCase() === "steam") return f.kind("Steam");
    const uri = str(c.uri);
    if (uri) f.link(uri, i + 1, nameOf(str(c.name), ""));
    else f.skip(i + 1, nameOf(str(c.name), ""), "missing_secret");
  });
  return f.result();
}

/** An array of account objects (andOTP, Raivo, and alike): the usual field names, in either spelling. */
function readArray(list: Obj[], format: Format): FileRead {
  const f = new Found(format);
  const budget = { nodes: MAX_NODES };
  list.forEach((e, i) => {
    const c = candOf(e) ?? { secret: "" };
    // the same rule for sub-objects as any other JSON's (nestedCand); the period these apps let users set is kept
    const n = nestedCand(e, c, budget, false);
    if (n) f.entry(n, i + 1);
    else f.skip(i + 1, nameOf(text(c.issuer), text(c.label)), "malformed");
  });
  return f.result();
}

const PARAMS: Record<"type" | "algorithm" | "digits" | "period" | "counter", readonly string[]> = {
  type: ["type", "kind", "tokenType", "otpType", "otp_type"],
  algorithm: ["algorithm", "algo"],
  digits: ["digits"],
  period: ["period", "timer", "timeStep", "interval", "step"],
  counter: ["counter"],
};
const PARAM_KEYS = new Set(Object.values(PARAMS).flat());
const ISSUER_KEYS = ["issuer", "issuerName", "issuerExt", "service", "serviceName"];
const LABEL_KEYS = ["label", "account", "accountName", "name", "username", "userName", "email"];

/** The first of `keys` that `e` has (a value that is there, readable or not). */
const firstOf = (e: Obj, keys: readonly string[]) =>
  keys.map((k) => e[k]).find((v) => v !== undefined && v !== null && v !== "");

/** An object as an account, read by the usual field names; null without a string or byte-list `secret`. */
function candOf(e: Obj): Cand | null {
  const secret = typeof e.secret === "string" ? e.secret : bytesSecret(e.secret);
  if (secret === null) return null;
  return {
    type: firstOf(e, PARAMS.type),
    issuer: firstOf(e, ISSUER_KEYS),
    label: firstOf(e, LABEL_KEYS),
    secret,
    algorithm: firstOf(e, PARAMS.algorithm),
    digits: firstOf(e, PARAMS.digits),
    period: firstOf(e, PARAMS.period),
    counter: firstOf(e, PARAMS.counter),
  };
}

/** Names a sub-object of an account carries its OTP parameters under (2FAS `otp`, Aegis `info`, and alike). */
const PARAM_HOMES = new Set([
  "otp",
  "totp",
  "hotp",
  "info",
  "token",
  "params",
  "parameters",
  "otpParams",
  "otp_params",
  "otpParameters",
]);
/** Keys that set the codes (not the kind, which a wrong value only refuses): in any other sub-object they refuse it. */
const CODE_KEYS = new Set([...PARAMS.algorithm, ...PARAMS.digits, ...PARAMS.period, ...PARAMS.counter]);
/** A period an unknown file may give: what services use, give or take; anything else is no TOTP period. */
const SANE_PERIOD = { min: 10, max: 300 };

/**
 * An account object of an unknown file, with the parameters it keeps in a sub-object named for them (`otp`, `info`,
 * `params`, …: `{secret, otp: {digits, period}}`, as 2FAS and Aegis do) taken from there; null when they cannot be read
 * without guessing: a code-setting key (digits, period, interval, step, algorithm, counter) in any other sub-object or
 * deeper down (`{secret, sync: {interval: 300}}` is a sync interval, not a period), parameters in two places that
 * differ, two such sub-objects, or (in a file of no known format: `sane`) a period outside 10 to 300 seconds. Such an
 * object is refused, never given the defaults or a timer of something else.
 */
function nestedCand(v: Obj, c: Cand, budget: { nodes: number }, sane = true): Cand | null {
  let child: Obj | null = null;
  const stack: { o: unknown; depth: number; home: boolean }[] = Object.entries(v).map(([k, o]) => ({
    o,
    depth: 1,
    home: PARAM_HOMES.has(k),
  }));
  while (stack.length) {
    if (--budget.nodes < 0) return null;
    const { o, depth, home } = stack.pop()!;
    if (Array.isArray(o)) {
      for (const x of o) stack.push({ o: x, depth: depth + 1, home: false });
      continue;
    }
    if (!isObj(o)) continue;
    const keys = Object.keys(o);
    if (home && depth === 1) {
      if (child) return null;
      child = o;
    } else if (keys.some((k) => CODE_KEYS.has(k))) return null;
    for (const x of Object.values(o)) stack.push({ o: x, depth: depth + 1, home: false }); // a home deeper down is none
  }
  let out: Cand = c;
  if (child) {
    out = { ...c };
    for (const k of ["type", "algorithm", "digits", "period", "counter"] as const) {
      const inner = firstOf(child, PARAMS[k]);
      if (inner === undefined) continue;
      if (out[k] !== undefined && out[k] !== inner) return null;
      out[k] = inner;
    }
    out.issuer ??= firstOf(child, ISSUER_KEYS);
    out.label ??= firstOf(child, LABEL_KEYS);
  }
  const period = param(out.period);
  if (sane && period) {
    const n = Number(period);
    if (!(n >= SANE_PERIOD.min && n <= SANE_PERIOD.max)) return null;
  }
  return out;
}

/** Any other JSON: every otpauth:// string, and every object with a key-shaped `secret`, wherever they are. */
function readAnyJson(root: unknown): FileRead {
  const f = new Found("json");
  const stack: unknown[] = [root];
  const budget = { nodes: MAX_NODES };
  let at = 0;
  while (stack.length) {
    if (--budget.nodes < 0) return TOO_LARGE;
    const v = stack.pop();
    if (typeof v === "string") {
      if (SCHEME.test(v.trim())) f.link(v, ++at);
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isObj(v)) {
      const c = candOf(v);
      // an unknown file's "secret" counts only when it is shaped like a 2FA key (16 base32 characters or more), so a
      // password or a token of some other program is not taken for one; a link inside the object is enough as well
      if (c && keyShaped(c.secret)) {
        const n = nestedCand(v, c, budget);
        if (budget.nodes < 0) return TOO_LARGE;
        if (n) f.entry(n, ++at);
        else f.skip(++at, nameOf(text(c.issuer), text(c.label)), "malformed");
        continue; // the object is the account: its other fields are not looked into
      }
      const vals = Object.values(v);
      for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
    }
  }
  return f.result();
}

function keyShaped(s: string): boolean {
  try {
    return normalizeBase32(s).length >= MIN_TEXT_KEY;
  } catch {
    return false;
  }
}

function readJson(v: unknown): FileRead {
  if (isObj(v)) {
    const o = v;
    if (o.format === "sixkey-backup") return { kind: "sixkey_backup" };
    // Aegis: {version, header: {slots, params}, db}; db is a base64 string when the vault is encrypted
    if (isObj(o.header) && "slots" in o.header && "db" in o) {
      if (typeof o.db === "string" || Array.isArray(o.header.slots)) return { kind: "encrypted", app: "Aegis" };
      return isObj(o.db) ? readAegis(o.db) : NOTHING;
    }
    // 2FAS: {services, servicesEncrypted, reference, schemaVersion, ...}
    if (
      Array.isArray(o.services) &&
      ("schemaVersion" in o ||
        "servicesEncrypted" in o ||
        "appVersionCode" in o ||
        objs(o.services).some((x) => isObj(x.otp) && "secret" in x))
    ) {
      if (typeof o.servicesEncrypted === "string" && o.servicesEncrypted !== "")
        return { kind: "encrypted", app: "2FAS" };
      return read2fas(o);
    }
    // Bitwarden: {encrypted, items | data, ...}
    if (typeof o.encrypted === "boolean" && ("items" in o || "data" in o || "encKeyValidation_DO_NOT_EDIT" in o)) {
      if (o.encrypted) return { kind: "encrypted", app: "Bitwarden" };
      return readBitwarden(o);
    }
    // Ente Auth's encrypted export: {kdfParams, encryptedData, encryptionNonce}
    if ("kdfParams" in o && "encryptedData" in o) return { kind: "encrypted", app: "Ente Auth" };
    // Proton Authenticator: {version, entries: [{content: {uri, entry_type, name}}]}; encrypted: {version, salt, content}
    if (Array.isArray(o.entries) && objs(o.entries).some((e) => isObj(e.content))) return readProton(o);
    if ("salt" in o && typeof o.content === "string" && !("entries" in o))
      return { kind: "encrypted", app: "Proton Authenticator" };
    // FreeOTP+: {tokenOrder, tokens: [{secret: [bytes], issuerExt, label, ...}]}
    if (Array.isArray(o.tokens) && objs(o.tokens).some((t) => Array.isArray(t.secret))) return readFreeOtp(o);
  }
  if (Array.isArray(v)) {
    const list = objs(v);
    // andOTP and Raivo: a bare array of account objects
    if (list.length && list.length === v.length && list.every((e) => "secret" in e)) {
      const raivo = list.some((e) => "kind" in e || "timer" in e);
      return readArray(list, raivo ? "raivo" : "andotp");
    }
  }
  return readAnyJson(v);
}

// ---- the entry points -------------------------------------------------------------------------------------------------

/** A link anywhere in a text. */
const HAS_LINK = /(?:otpauth(?:-migration)?|steam|motp):\/\//i;

/** What a text file holds. `text` is the decoded file (file-text.ts decodeText), at most MAX_TEXT_BYTES of it. */
export function readImportText(text: string): FileRead {
  try {
    return readText(text);
  } catch {
    return NOTHING; // a backstop: every path above returns a reason rather than throwing
  }
}

function readText(text: string): FileRead {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = t.trim();
  if (!trimmed) return NOTHING;
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    if (tooDeep(trimmed)) return NOTHING;
    let v: unknown;
    let parsed = true;
    try {
      v = JSON.parse(trimmed); // its error message can quote the file: it is never shown or kept
    } catch {
      parsed = false;
    }
    if (parsed) return readJson(v);
  }
  if (/^-----BEGIN PGP MESSAGE-----/m.test(trimmed)) return { kind: "encrypted", app: "andOTP (OpenPGP)" };
  const linked = HAS_LINK.test(t);
  // a web page export (Ente's, Raivo's) holds its codes as pictures only: say so, rather than "no accounts"
  if (
    !linked &&
    trimmed[0] === "<" &&
    /<(?:!doctype\s+html|html|head|body|img|table)[\s>]/i.test(trimmed.slice(0, 4096))
  )
    return { kind: "html" };
  const lines = linesOf(t);
  if (!lines) return TOO_LARGE;
  const csv = readCsv(lines);
  if (csv) return csv;
  if (linked) return readLinks(lines);
  return readPlain(lines);
}

/** What the QR codes read from an image or the camera hold: each text is one code. */
export function readQrTexts(texts: readonly string[]): FileRead {
  const f = new Found("links");
  try {
    texts.forEach((x, i) => {
      const s = x.trim();
      if (SCHEME.test(s)) f.link(s, i + 1);
      else f.skip(i + 1, "", "not_otpauth");
    });
  } catch {
    return NOTHING; // a backstop, as above
  }
  return f.result();
}

/**
 * The name of a file that is not text: an encrypted andOTP backup (otp_accounts.json.aes) has no marker in its bytes,
 * so only its name tells it from any other binary file. Used for the message only, never to read the file.
 */
export const encryptedByName = (name: string): string | null => (/\.aes$/i.test(name.trim()) ? "andOTP" : null);
