// Turning pasted text, scanned codes and files into entries. Nothing here shows secrets back to the user:
// failures are reported by position and reason only.
import {
  collectBatches,
  parseMigrationUri,
  type BatchProgress,
  type MigrationBatch,
  type MigrationEntryError,
  type MigrationError,
} from "../totp/migration";
import { normalizeBase32 } from "../totp/base32";
import { parseOtpauthList, serializeOtpauth, type OtpauthError, type OtpParams } from "../totp/otpauth";
import { aliveEntries, type Entry, type Vault } from "../vault/model";
import { fitsLimits } from "../vault/validate";
import type { Clock } from "../vault/hlc";
import { addEntry } from "../vault/ops";

export type ImportFailure = {
  index: number;
  reason: OtpauthError | MigrationError | MigrationEntryError | "too_long" | "not_key";
};

/**
 * What may be said about one column of the plain text lines: its position, how long its cells are, and in how many
 * lines it reads as a key. Never its content: a column can hold passwords, and those are secrets too.
 */
export type LineColumn = { index: number; minLength: number; maxLength: number; keyLike: number };

/** Plain text lines with two or more columns (`name|key`, `name|key|password`, ...), read as one table. */
export type LineTable = {
  lines: number; // lines with two or more columns
  columns: LineColumn[];
  keyColumn: number | null; // null: no column, or more than one, reads as a key in every line, and none was chosen
  auto: boolean; // keyColumn was found, not chosen
  nameColumn: number | null; // null: the accounts get no name
  pending: number; // lines held back until a key column is chosen
};

export type ImportPlan = {
  add: OtpParams[]; // new accounts, in input order
  duplicates: OtpParams[]; // already in the vault, or repeated in the input
  failed: ImportFailure[];
  incomplete: BatchProgress[]; // Google Authenticator exports with some QR codes still missing
  warnings: { short_secret: number; issuer_mismatch: number; hotp: number };
  fromText: number[]; // positions in `add` that came from plain text lines rather than links
  table: LineTable | null; // present when some line had two or more columns
};

/** Which columns of the plain text lines to use. Out-of-range values are ignored. `nameColumn: null` means no name. */
export type ImportOptions = { keyColumn?: number; nameColumn?: number | null };

/** A key written as plain text must have at least 16 base32 characters (80 bits), so that ordinary words are not taken for one. */
export const MIN_TEXT_KEY = 16;
/** Lines with more columns than this are not read as a table. */
export const MAX_COLUMNS = 16;

const keyOf = (p: { secret: string; issuer: string; label: string }) =>
  `${p.secret}\u0000${p.issuer.toLowerCase()}\u0000${p.label.toLowerCase()}`;
const SEP = /[|｜]/; // "|", and the full-width "｜" that Chinese input methods type

/** The cells of a plain text line. A row framed by separators on both sides ("|name|key|", as in a Markdown table) loses the frame; "name|" keeps its empty last cell. */
function columnsOf(raw: string): string[] {
  let s = raw.trim();
  if (s.length > 1 && SEP.test(s[0]!) && SEP.test(s[s.length - 1]!)) s = s.slice(1, -1);
  return s.split(SEP).map((c) => c.trim());
}

/**
 * The canonical base32 form of a key written on its own, or null when the text is not shaped like a key: one run of
 * base32 characters (hyphens and "=" padding allowed), or groups of four separated by spaces, as sites print them.
 * Anything else ("garbage line", a sentence) is not a key, so words are not mistaken for one. Full-width characters
 * and spaces count as their plain forms.
 */
function keyText(cell: string): string | null {
  const s = cell.normalize("NFKC").trim();
  if (!s) return null;
  if (/\s/.test(s)) {
    const groups = s.split(/\s+/);
    if (!groups.every((g, i) => /^[A-Za-z2-7=]+$/.test(g) && (i < groups.length - 1 ? g.length === 4 : g.length <= 4)))
      return null;
  }
  try {
    const k = normalizeBase32(s);
    return k || null;
  } catch {
    return null;
  }
}

const keyLike = (cell: string) => (keyText(cell)?.length ?? 0) >= MIN_TEXT_KEY;

/** `Issuer:account` splits like an otpauth label; a name without a colon is the issuer, so it can match the site. */
function nameParts(name: string): { issuer: string; label: string } {
  const n = name.trim();
  const colon = n.indexOf(":");
  return colon < 0 ? { issuer: n, label: "" } : { issuer: n.slice(0, colon).trim(), label: n.slice(colon + 1).trim() };
}

const textAccount = (secret: string, name: string): OtpParams => ({
  type: "totp",
  ...nameParts(name),
  secret,
  algorithm: "SHA1",
  digits: 6,
  period: 30,
});

const inRange = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n < max;

function readTable(rows: string[][], opts: ImportOptions): LineTable {
  const width = Math.max(...rows.map((r) => r.length));
  const columns: LineColumn[] = [];
  for (let c = 0; c < width; c++) {
    const lengths = rows.map((r) => r[c]?.length ?? 0);
    columns.push({
      index: c,
      minLength: Math.min(...lengths),
      maxLength: Math.max(...lengths),
      keyLike: rows.filter((r) => keyLike(r[c] ?? "")).length,
    });
  }
  const whole = columns.filter((col) => col.keyLike === rows.length);
  const chosen = inRange(opts.keyColumn, width);
  const keyColumn = chosen ? (opts.keyColumn as number) : whole.length === 1 ? whole[0]!.index : null;
  // The name is column 0, or column 1 when the key is column 0; but a column that holds a key in any line is never
  // used as a name unless chosen, so a second key is not shown or saved as one.
  const byDefault = keyColumn === 0 ? 1 : 0;
  let nameColumn: number | null = columns[byDefault]!.keyLike > 0 ? null : byDefault;
  if (opts.nameColumn === null) nameColumn = null;
  else if (inRange(opts.nameColumn, width) && opts.nameColumn !== keyColumn) nameColumn = opts.nameColumn;
  return {
    lines: rows.length,
    columns,
    keyColumn,
    auto: !chosen && keyColumn !== null,
    nameColumn,
    pending: keyColumn === null ? rows.length : 0,
  };
}

/**
 * Accepts otpauth:// lines, otpauth-migration:// links and plain text key lines mixed together. `carry` holds export
 * batches scanned earlier. A plain text line is a key on its own, or columns split by "|"; of those only the key
 * column and the name column are read, and every other column (a password, an email, a note) is dropped here and
 * never reaches the plan.
 */
export function planImport(
  text: string,
  existing: Entry[],
  carry: MigrationBatch[] = [],
  opts: ImportOptions = {},
): { plan: ImportPlan; batches: MigrationBatch[] } {
  const found: OtpParams[] = [];
  const foundFromText: boolean[] = [];
  const failed: ImportFailure[] = [];
  const batches = [...carry];
  const warnings = { short_secret: 0, issuer_mismatch: 0, hotp: 0 };

  const items = parseOtpauthList(text);
  // A line that is not a link is plain text: split it into columns first, so the key column is chosen over all lines.
  const cells = items.map((item) =>
    item.result.ok || item.result.error !== "not_otpauth" ? null : columnsOf(item.raw),
  );
  const isRow = (r: string[] | null): r is string[] =>
    r !== null && r.length > 1 && r.length <= MAX_COLUMNS && r.some((c) => c !== "");
  const rows = cells.filter(isRow);
  const table = rows.length ? readTable(rows, opts) : null;

  const take = (index: number, p: OtpParams, fromText: boolean) => {
    if (!fitsLimits(p)) return void failed.push({ index, reason: "too_long" });
    found.push(p);
    foundFromText.push(fromText);
  };

  items.forEach((item, index) => {
    const r = item.result;
    const row = cells[index];
    if (r.ok) {
      if (!fitsLimits(r.value)) return void failed.push({ index, reason: "too_long" });
      found.push(r.value);
      foundFromText.push(false);
      for (const w of r.warnings) warnings[w]++;
    } else if (r.error === "migration_uri") {
      const m = parseMigrationUri(item.raw);
      if (m.ok) batches.push(m.batch);
      else failed.push({ index, reason: m.error });
    } else if (!row) failed.push({ index, reason: r.error });
    else if (row.length === 1) {
      // A key on its own. Text that is not shaped like a key stays "not a link or key".
      const k = keyText(row[0]!);
      if (k === null) failed.push({ index, reason: "not_otpauth" });
      else if (k.length < MIN_TEXT_KEY) failed.push({ index, reason: "not_key" });
      else take(index, textAccount(k, ""), true);
    } else if (row.every((c) => c === ""))
      failed.push({ index, reason: "not_otpauth" }); // only separators
    else if (row.length > MAX_COLUMNS) failed.push({ index, reason: "malformed" });
    else if (table && table.keyColumn !== null) {
      const cell = row[table.keyColumn] ?? "";
      const k = keyText(cell);
      if (!cell) failed.push({ index, reason: "missing_secret" });
      else if (k === null) failed.push({ index, reason: "invalid_secret" });
      else if (k.length < MIN_TEXT_KEY) failed.push({ index, reason: "not_key" });
      else take(index, textAccount(k, table.nameColumn === null ? "" : (row[table.nameColumn] ?? "")), true);
    } // else: held back until the key column is chosen (table.pending)
  });

  const progress = collectBatches(batches);
  for (const b of progress) {
    b.entries.forEach((e, i) => {
      if (e.ok && !fitsLimits(e.value)) failed.push({ index: i, reason: "too_long" });
      else if (e.ok) {
        found.push(e.value);
        foundFromText.push(false);
      } else failed.push({ index: i, reason: e.error });
    });
  }
  for (const p of found) if (p.type === "hotp") warnings.hotp++;

  const seen = new Set(existing.map(keyOf));
  const add: OtpParams[] = [];
  const duplicates: OtpParams[] = [];
  const fromText: number[] = [];
  found.forEach((p, i) => {
    const k = keyOf(p);
    if (seen.has(k)) duplicates.push(p);
    else {
      seen.add(k);
      if (foundFromText[i]) fromText.push(add.length);
      add.push(p);
    }
  });
  return {
    plan: { add, duplicates, failed, incomplete: progress.filter((b) => !b.complete), warnings, fromText, table },
    batches,
  };
}

export function applyImport(vault: Vault, add: OtpParams[], clock: Clock, opts: { group?: string } = {}): Vault {
  let v = vault;
  for (const p of add) {
    v = addEntry(
      v,
      {
        type: p.type,
        issuer: p.issuer,
        label: p.label,
        secret: p.secret,
        algorithm: p.algorithm,
        digits: p.digits,
        period: p.period,
        ...(p.counter !== undefined ? { counter: p.counter } : {}),
        ...(opts.group ? { group: opts.group } : {}),
      },
      clock,
    ).vault;
  }
  return v;
}

/** Plain-text export: one otpauth:// link per line, live entries only. The caller must warn that this is not encrypted. */
export function exportOtpauthList(vault: Vault): string {
  return (
    aliveEntries(vault)
      .map((e) =>
        serializeOtpauth({
          type: e.type,
          issuer: e.issuer,
          label: e.label,
          secret: e.secret,
          algorithm: e.algorithm,
          digits: e.digits,
          period: e.period,
          ...(e.counter !== undefined ? { counter: e.counter } : {}),
        }),
      )
      .join("\n") + "\n"
  );
}
