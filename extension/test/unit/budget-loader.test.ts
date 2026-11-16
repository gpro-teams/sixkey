// The settings page's part loader (src/options/parts.tsx loadParts, partsReady), against catalog chunks that fail or
// arrive late (the JSON modules mocked): a part never counts as loaded before t() has its text, a part whose chunk
// cannot be loaded in the page's language comes in English, and one that cannot be loaded at all leaves key names and
// never rejects (docs/design/notes/BUDGET-NOTES.md §2). One file of its own: the mocks and the loader's state are per file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const late = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return { gate, open: () => open() };
});
// backup: not in Chinese (its English must be used)
vi.mock("../../catalogs/settings-backup-zh_CN.json", () => {
  throw new Error("the chunk cannot be loaded");
});
// firstrun: in neither language
vi.mock("../../catalogs/settings-firstrun-zh_CN.json", () => {
  throw new Error("the chunk cannot be loaded");
});
vi.mock("../../catalogs/settings-firstrun-en.json", () => {
  throw new Error("the chunk cannot be loaded");
});
// misc: in Chinese, but only once the test opens the gate
vi.mock("../../catalogs/settings-misc-zh_CN.json", async () => {
  await late.gate;
  return vi.importActual("../../catalogs/settings-misc-zh_CN.json");
});
// The page's catalog is applied a few milliseconds after the loader asks for it (the real loadCatalog, delayed): a part
// counted as loaded before its text is in would then be visible for that long, where a single microtask is too short a
// window to watch.
vi.mock("../../src/ui/i18n", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/ui/i18n")>();
  return {
    ...real,
    loadCatalog: async (source: Parameters<typeof real.loadCatalog>[0]) => {
      await new Promise((r) => setTimeout(r, 5));
      await real.loadCatalog(source);
    },
  };
});

const { loadParts, partsReady } = await import("../../src/options/parts");
const { setLangChoice, t } = await import("../../src/ui/i18n");
type Cat = Record<string, { message: string }>;
const json = (n: string) => JSON.parse(readFileSync(join(__dirname, "../../catalogs", n), "utf8")) as Cat;
const first = (n: string) => Object.keys(json(n))[0]!;
setLangChoice("zh_CN");

/** Runs `p` to the end, checking `invariant` at every step of the way (each microtask, and each macrotask after it). */
async function watch(p: Promise<void>, invariant: () => void) {
  let done = false;
  void p.then(() => (done = true));
  for (let i = 0; i < 2000 && !done; i++) {
    invariant();
    await (i % 50 === 49 ? new Promise((r) => setTimeout(r, 0)) : Promise.resolve());
  }
  invariant();
  expect(done).toBe(true);
}

describe("the settings page's part loader", () => {
  it("a part counts as loaded only once t() has its text: before, during and after its chunk arrives late", async () => {
    await loadParts(["core"]);
    const key = first("settings-misc-zh_CN.json");
    const text = json("settings-misc-zh_CN.json")[key]!.message;
    const loading = loadParts(["misc", "general"]);
    // the chunk is held back: misc is not loaded, and its key shows itself
    for (let i = 0; i < 100; i++) {
      expect(partsReady(["misc"])).toBe(false);
      expect(t(key)).toBe(key);
      await Promise.resolve();
    }
    late.open();
    await watch(loading, () => {
      if (partsReady(["misc"])) expect(t(key)).toBe(text);
      const g = first("settings-general-zh_CN.json");
      if (partsReady(["general"])) expect(t(g)).toBe(json("settings-general-zh_CN.json")[g]!.message);
    });
    expect(partsReady(["misc", "general"])).toBe(true);
    expect(t(key)).toBe(text);
  });

  it("the same for a part that arrives at once: never loaded before its text is merged", async () => {
    const key = first("settings-accounts-zh_CN.json");
    await watch(loadParts(["accounts"]), () => {
      if (partsReady(["accounts"])) expect(t(key)).toBe(json("settings-accounts-zh_CN.json")[key]!.message);
    });
    expect(partsReady(["accounts"])).toBe(true);
  });

  it("a part whose chunk cannot be loaded in the page's language comes in English; the others stay Chinese", async () => {
    await loadParts(["backup", "security"]);
    const key = first("settings-backup-en.json");
    expect(t(key)).toBe(json("settings-backup-en.json")[key]!.message);
    expect(t(key)).not.toBe(json("settings-backup-zh_CN.json")[key]!.message);
    const sec = first("settings-security-zh_CN.json");
    expect(t(sec)).toBe(json("settings-security-zh_CN.json")[sec]!.message);
  });

  it("a part that cannot be loaded at all: loadParts still resolves, t() shows key names, and the rest is kept", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(loadParts(["firstrun"])).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 0));
      const key = first("settings-firstrun-en.json");
      expect(t(key)).toBe(key);
      expect(partsReady(["firstrun"])).toBe(true); // loaded, with no text: the page draws key names, never a blank
      const core = first("settings-core-zh_CN.json");
      expect(t(core)).toBe(json("settings-core-zh_CN.json")[core]!.message);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
