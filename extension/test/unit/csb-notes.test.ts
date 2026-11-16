// The notes of the backup in Chrome's sync storage (docs/design/notes/CSB-NOTES.md) name the code's real keys, records
// and messages, and nothing the code does not have. The doc's own blocks are read as text and held to the code:
//   1. the messages: every sk-csb-* message the settings page may send (sender-policy.ts CSB_MESSAGES), each answered by
//      sw.ts's handler table through a method of the worker (platform/csb-worker.ts createCsbWorker), and the worker's
//      two alarms, which share the prefix; every sk-csb- name in the code is one of them, and so is every one the notes
//      use;
//   2. the records: the notes' record lines (sk_csb_cfg, its link, sk_csb_state, its others; the manifest bk1.<slot>)
//      list exactly the fields each strict reader keeps, an optional one with "?" (a field is optional when the reader
//      keeps the record without it), and the link's against its reader's own field lists too; the chunk keys' range;
//      every sk_csb_ name the notes use is one of the two record keys, and every other sk_ name a key the code writes
//      out as a string;
//   3. the numbers: each row of the notes' table whose first cell is an upper-case name is that constant, at that value,
//      and every constant of the list below has its row;
//   4. the backup's own files the notes name (a path with csb or slot in it) and the docs they name exist.
// The Google Drive backup's files are named in the notes as history and in the record of what its removal took, and are
// not held here; its two records' keys, which no code names any more, are not named there either (item 2).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AREA_MARGIN,
  EMPTY_BELOW,
  ITEM_BYTES,
  ITEM_MARGIN,
  MAX_CHUNKS,
  MAX_MINE,
  QUOTA_BYTES,
  QUOTA_BYTES_PER_ITEM,
  ROOM_BYTES,
} from "../../src/core/cloud/slot-limits";
import { chunkKey, manifestKey, parseKey, parseManifest, planText, type SlotLink } from "../../src/core/cloud/slots";
import { STALE_AFTER_MS } from "../../src/core/cloud/status";
import { NEAR_FULL_FROM, USAGE_FROM } from "../../src/options/csb/model";
import { GO_KEY } from "../../src/platform/cloud-go";
import {
  CSB_CFG_KEY,
  CSB_STATE_KEY,
  NEW_CSB_CONFIG,
  NEW_CSB_STATE,
  parseCsbConfig,
  parseCsbState,
  parseSlotLink,
  type CsbConfig,
  type CsbState,
} from "../../src/platform/csb-config";
import {
  createCsbWorker,
  CSB_RETRY_ALARM,
  CSB_SOON_ALARM,
  DAILY_MS,
  LAST_BACKUP_KEY,
  MAX_WAIT_MS,
  RETRY_MS,
  SOON_MS,
  VAULT_POINTER,
  type CsbWorkerDeps,
} from "../../src/platform/csb-worker";
import { CSB_MESSAGES, MESSAGE_SENDERS } from "../../src/platform/sender-policy";

const EXT = resolve(__dirname, "../..");
const REPO = resolve(EXT, "..");
const NOTES = readFileSync(join(REPO, "docs/design/notes/CSB-NOTES.md"), "utf8");
const read = (p: string) => readFileSync(join(EXT, p), "utf8");

function sources(dir = join(EXT, "src")): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
/** The code without its comments (budget3-rules.test.ts's way). */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const SOURCE = sources().map((p) => code(readFileSync(p, "utf8")));

const names = (re: RegExp, text = NOTES) => [...new Set(text.match(re) ?? [])].sort();

/** The notes' record lines, in their ```text blocks: `name   { a, b?, c }`, by name. */
function recordLines(text = NOTES): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of text.match(/```text\n[\s\S]*?\n```/g) ?? [])
    for (const line of block.split("\n")) {
      const m = /^\s*(\S+)\s+\{ ([^{}]*) \}$/.exec(line);
      if (m) out.set(m[1]!, m[2]!.split(", "));
    }
  return out;
}

/**
 * The fields a strict reader keeps, from a record that has every field: each marked "?" when the reader still takes
 * the record without it. `kept(x)` says whether the reader took `x` as a record of its own (not the fallback).
 */
function fieldsOf(full: Record<string, unknown>, kept: (x: Record<string, unknown>) => boolean): string[] {
  expect(kept(full)).toBe(true);
  return Object.keys(full).map((f) => {
    const { [f]: _gone, ...rest } = full;
    return kept(rest) ? `${f}?` : f;
  });
}

// A link with every field the reader knows, each in its shape (csb-config.ts parseSlotLink).
const LINK: SlotLink = {
  v: 1,
  slot: "abcd1234",
  gen: "0123456789abcdef",
  pending: "fedcba9876543210",
  seq: 7,
  sum: `${"A".repeat(43)}=`,
  vaultId: "vault-0001",
  vkId: "0011223344556677",
  opens: "both",
  wraps: "password:AAAA,recovery:BBBB",
  held: true,
  dirty: true,
  mine: ["abcd1234", "wxyz9876"],
};
const CFG: CsbConfig = { v: 1, on: true, opens: "recovery", declined: true, link: LINK };
const STATE: CsbState = {
  v: 1,
  lastOk: 5,
  err: "busy",
  errSince: 4,
  pendingSince: 3,
  retries: 2,
  lastRun: 6,
  bytes: 100,
  used: 200,
  others: { n: 1, bytes: 50, otherVaults: 1, latest: 9 },
  seen: true,
  unsafe: true,
};

describe("1. the messages and the alarms", () => {
  const ALARMS = [CSB_SOON_ALARM, CSB_RETRY_ALARM];
  it("the settings page alone sends the sk-csb-* messages, to the worker; sw.ts answers each through a method of the worker", () => {
    const rows = Object.entries(MESSAGE_SENDERS).filter(([k]) => k.startsWith("sk-csb-"));
    expect(rows.map(([k]) => k).sort()).toEqual([...CSB_MESSAGES].sort());
    for (const [, row] of rows) expect(row).toEqual({ to: "worker", from: ["options"] });
    const sw = read("src/background/sw.ts");
    const table = /const CSB_HANDLERS\b.*\} = \{\n([\s\S]*?)\n\};/.exec(sw)?.[1] ?? "";
    const handled = [...table.matchAll(/^ {2}"(sk-csb-[a-z]+)": \([^)]*\) => csb\.([a-z]+)\(/gm)];
    expect(handled.map((m) => m[1]).sort()).toEqual([...CSB_MESSAGES].sort());
    const worker = createCsbWorker({
      kv: { get: async () => ({}), set: async () => {}, remove: async () => {}, keys: async () => [] },
      lock: (fn: () => Promise<unknown>) => fn(),
      vaultLock: (fn: () => Promise<unknown>) => fn(),
      load: async () => ({ status: "empty" }),
      alarms: { create: () => {}, clear: async () => true },
      now: () => 0,
      app: "Sixkey 0.0.0",
      access: async () => true,
      note: () => {},
    } as unknown as CsbWorkerDeps) as unknown as Record<string, unknown>;
    for (const [, msg, method] of handled) expect(typeof worker[method!], `${msg}: csb.${method}`).toBe("function");
  });
  it("every sk-csb- name in the code is a message or one of the worker's two alarms", () => {
    const inCode = names(/sk-csb-[a-z]+/g, SOURCE.join("\n"));
    expect(inCode).toEqual([...CSB_MESSAGES, ...ALARMS].sort());
  });
  it("the notes name every message and both alarms, and no other sk-csb- name", () => {
    expect(names(/sk-csb-[a-z]+/g)).toEqual([...CSB_MESSAGES, ...ALARMS].sort());
  });
});

describe("2. the records, the manifest and the keys", () => {
  const lines = recordLines();
  it("the notes' record lines are the two records, the link, the others, and the manifest; no other", () => {
    expect([...lines.keys()].sort()).toEqual(["bk1.<slot>", "link", "others", "sk_csb_cfg", "sk_csb_state"]);
    expect(names(/sk_csb_[a-z_]+/g)).toEqual([CSB_CFG_KEY, CSB_STATE_KEY].sort());
  });
  it("sk_csb_cfg: its fields as parseCsbConfig keeps them", () => {
    expect(Object.keys(CFG)).toEqual(Object.keys(NEW_CSB_CONFIG));
    expect(parseCsbConfig(CFG)).toEqual(CFG);
    expect(lines.get(CSB_CFG_KEY)).toEqual(fieldsOf(CFG, (x) => parseCsbConfig(x).on));
  });
  it("its link: the fields parseSlotLink keeps, those it keeps a link without marked optional; its own field lists", () => {
    expect(parseSlotLink(LINK)).toEqual(LINK);
    const kept = fieldsOf(LINK, (x) => parseSlotLink(x) !== null);
    expect(lines.get("link")).toEqual(kept);
    // the reader's lists, in csb-config.ts, name no field the link above lacks
    const src = read("src/platform/csb-config.ts");
    const list = (name: string) =>
      JSON.parse(new RegExp(`^const ${name} = (\\[[^\\]]*\\]);$`, "m").exec(src)?.[1] ?? "null") as string[] | null;
    const need = list("LINK_FIELDS");
    const may = list("LINK_OPTIONAL");
    expect(need, "LINK_FIELDS in csb-config.ts").not.toBeNull();
    expect(may, "LINK_OPTIONAL in csb-config.ts").not.toBeNull();
    expect([...need!, ...may!.map((f) => `${f}?`)].sort()).toEqual([...kept].sort());
  });
  it("sk_csb_state and its others: the fields parseCsbState keeps, those it keeps a state without marked optional", () => {
    expect(Object.keys(STATE)).toEqual(Object.keys(NEW_CSB_STATE));
    expect(Object.keys(STATE.others)).toEqual(Object.keys(NEW_CSB_STATE.others));
    expect(parseCsbState(STATE)).toEqual(STATE);
    const isOwn = (x: Record<string, unknown>) => parseCsbState(x).lastOk === STATE.lastOk;
    expect(lines.get(CSB_STATE_KEY)).toEqual(fieldsOf(STATE, isOwn));
    expect(lines.get("others")).toEqual(
      fieldsOf(STATE.others, (o) => isOwn({ ...STATE, others: o } as unknown as Record<string, unknown>)),
    );
  });
  it("the manifest bk1.<slot>: the fields planText writes and parseManifest requires; the chunks' range", async () => {
    const plan = await planText("a text", "abcd1234", "0123456789abcdef", 1_793_379_341_960);
    if (plan.kind !== "plan") throw new Error("a short text is planned");
    const m = plan.manifest as unknown as Record<string, unknown>;
    expect(parseManifest(m)).toEqual(m);
    expect(lines.get(manifestKey("<slot>"))).toEqual(fieldsOf(m, (x) => parseManifest(x) !== null));
    const chunk = new RegExp(
      `^${chunkKey("<slot>", 0).replace(/0$/, "<i>").replace(/\./g, "\\.")}\\s+.*, i = 0 to (\\d+)$`,
      "m",
    );
    expect(Number(chunk.exec(NOTES)?.[1])).toBe(MAX_CHUNKS - 1);
    expect(parseKey(chunkKey("abcd1234", MAX_CHUNKS - 1))).toEqual({ slot: "abcd1234", chunk: MAX_CHUNKS - 1 });
    expect(parseKey(`bk1.abcd1234.${MAX_CHUNKS}`)).toBeNull();
    expect(parseKey(manifestKey("abcd1234"))).toEqual({ slot: "abcd1234", chunk: null });
  });
  it("the other keys the backup reads or writes are named, and every sk_ name in the notes is a key the code writes out", () => {
    for (const k of [LAST_BACKUP_KEY, GO_KEY, VAULT_POINTER]) expect(NOTES, k).toContain(`\`${k}\``);
    const all = SOURCE.join("\n");
    for (const k of names(/\bsk_[a-z_]+/g))
      expect(
        ["'", '"', "`"].some((q) => all.includes(`${q}${k}${q}`)),
        k,
      ).toBe(true);
  });
});

describe("3. the numbers", () => {
  const CONSTANTS: Record<string, number | readonly number[]> = {
    QUOTA_BYTES,
    QUOTA_BYTES_PER_ITEM,
    ITEM_MARGIN,
    ITEM_BYTES,
    AREA_MARGIN,
    ROOM_BYTES,
    MAX_CHUNKS,
    EMPTY_BELOW,
    MAX_MINE,
    SOON_MS,
    MAX_WAIT_MS,
    RETRY_MS,
    DAILY_MS,
    STALE_AFTER_MS,
    USAGE_FROM,
    NEAR_FULL_FROM,
  };
  const UNIT: Record<string, number> = {
    "": 1,
    B: 1,
    s: 1_000,
    min: 60_000,
    h: 3_600_000,
    days: 86_400_000,
    "%": 0.01,
  };
  /** A cell such as "102,400 B", "13", "30 s", "1, 5, 30 min" or "60 %": its number, or numbers, in the code's unit. */
  function valueOf(cell: string): number | number[] {
    const m = /^(\d[\d,]*(?:, \d[\d,]*)*)(?: (B|s|min|h|days|%))?$/.exec(cell.trim());
    if (!m) throw new Error(`not a value: ${cell}`);
    const ns = m[1]!.split(", ").map((n) => Math.round(Number(n.replace(/,/g, "")) * UNIT[m[2] ?? ""]! * 1e6) / 1e6);
    return ns.length === 1 ? ns[0]! : ns;
  }
  const rows = [...NOTES.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| ([^|]+) \|/gm)].map((m) => [m[1]!, m[2]!] as const);
  it("each row names a constant of the code, once, at its value", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const [name, cell] of rows) {
      expect(Object.keys(CONSTANTS), name).toContain(name);
      expect(valueOf(cell), name).toEqual(CONSTANTS[name]);
    }
    expect(new Set(rows.map(([n]) => n)).size).toBe(rows.length);
  });
  it("every constant has its row", () => {
    expect(rows.map(([n]) => n).sort()).toEqual(Object.keys(CONSTANTS).sort());
  });
});

describe("4. the files", () => {
  it("the backup's own files and the docs the notes name exist", () => {
    const paths = names(/(?<=`)(?:src|test|scripts|catalogs|docs)\/[^`\s]+(?=`)/g);
    const own = paths.filter((p) => p.startsWith("docs/") || /csb|slot/.test(p));
    expect(own.length).toBeGreaterThan(20);
    for (const p of own) expect(existsSync(join(p.startsWith("docs/") ? REPO : EXT, p)), p).toBe(true);
  });
});
