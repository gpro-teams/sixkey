// TOTP autofill Stage 2, follow-up 4B-FU3 (docs/design/notes/AUTOFILL2-NOTES.md §13.11; the AF-BOUND review's B-S1): the
// popup's binding to a page's request (popup/main/page-fill.ts refresh) reads R with its bound, as every other reader does.
//   - against storage that never answers: refresh() ends at STORE_MS, and the binding goes (no hang of offer());
//   - no file of src/ but platform/fill-request.ts names R's key (whose functions bound every read of it).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORE_MS } from "../../src/platform/bounded";

const EXT = resolve(__dirname, "../..");
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
const never = <T>() => new Promise<T>(() => undefined);
const DOC = "0123456789ABCDEF0123456789ABCDEF";
const URL1 = "https://login.example.com/2fa";

describe("page-fill.ts refresh(): R read with its bound", () => {
  it("R's read never answered: refresh ends at STORE_MS, and the binding goes", async () => {
    vi.useFakeTimers();
    let hang = false;
    const r = {
      v: 2 as const,
      nonce: "a".repeat(32),
      tabId: 7,
      windowId: 3,
      url: URL1,
      host: "login.example.com",
      at: Date.now(),
      epoch: 0,
      why: "page" as const,
      doc: DOC,
    };
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: (k: string) => (hang ? never() : Promise.resolve(k === "sk_fill_req" ? { sk_fill_req: r } : {})),
          set: async () => undefined,
          remove: async () => undefined,
        },
      },
      tabs: { query: async () => [{ id: 7, url: URL1 }] },
    });
    const pf = await import("../../src/popup/main/page-fill");
    pf.bind(r);
    expect(pf.current()).not.toBeNull();
    hang = true;
    let done = false;
    void pf.refresh().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(STORE_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
    expect(pf.current()).toBeNull(); // a lost answer is no R: the binding went, and nothing can be filled for it
  });
});

describe("R is read only through fill-request's bounded functions", () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) files(p, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(p);
    }
    return out;
  };
  it("no file of src/ but platform/fill-request.ts names R's key", () => {
    const naming = files(join(EXT, "src"))
      .filter((f) => /\bFILL_REQ_KEY\b|sk_fill_req/.test(readFileSync(f, "utf8")))
      .map((f) =>
        f
          .slice(EXT.length + 1)
          .split("\\")
          .join("/"),
      );
    expect(naming).toEqual(["src/platform/fill-request.ts"]);
  });
});
