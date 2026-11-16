// What the settings page holds above its leaves (SHORT-SETTINGS-NOTES.md §F1, §F2, §F5, §F6): the master password's
// operations and the recovery code a new one shows (src/options/key-ops.ts), the questions "delete the file you imported
// from?" (import-asks.ts) and the file handed over from Backup (import-handoff.ts). Each outlives the leaf that began it,
// or ends as stated; rendered by Preact into a minimal document (test/helpers/mini-dom.ts).
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "../../src/core/service/service";
import type { Picked } from "../../src/platform/file-access";
import { fullCatalog } from "../../src/ui/catalog-full";
import { loadCatalog, setLangChoice } from "../../src/ui/i18n";
import { setAsks, useAsks, type Ask } from "../../src/options/import-asks";
import { dropHandoffs, handoffEpoch, handToAdd, takeHandoffs } from "../../src/options/import-handoff";
import { useKeyOps, type KeyOps } from "../../src/options/key-ops";
import { installMiniDom, type MiniDocument, type MiniElement } from "../helpers/mini-dom";

let dom: ReturnType<typeof installMiniDom>;
let root: MiniElement;
beforeAll(async () => {
  setLangChoice("en");
  await loadCatalog(fullCatalog);
});
beforeEach(() => {
  dom = installMiniDom();
  root = (dom.doc as MiniDocument).body;
});
afterEach(() => {
  act(() => render(null, root as unknown as Element));
  dom.undo();
});
afterAll(() => vi.restoreAllMocks());

describe("the master password's operations are the page's (key-ops.ts)", () => {
  type Service = {
    enableMasterPassword: (pw: string, d: { onCode: (c: string) => void }) => Promise<void>;
    changePassword: (o: string, n: string) => Promise<void>;
    newRecoveryCode: (pw: string, d: { onCode: (c: string) => void }) => Promise<void>;
    rotateKey: (pw: string, d: { onCode: (c: string) => void }) => Promise<void>;
  };
  let keys: KeyOps;
  let reloads: number;
  const STRONG = "Q7m#Xv9!pL2@rT5$kB8w";
  const mount = (service: Partial<Service>) => {
    reloads = 0;
    function Holder() {
      keys = useKeyOps({ service } as never, async () => void reloads++);
      return null;
    }
    act(() => render(h(Holder, {}), root as unknown as Element));
  };

  it("a new recovery code is held by the page from the moment its change committed, whoever asked is gone", async () => {
    let finish!: () => void;
    mount({
      newRecoveryCode: (_pw, d) => {
        d.onCode("AAAA-BBBB-CCCC"); // committed: the code is out before the cleanup after it ends
        return new Promise<void>((r) => (finish = r));
      },
    });
    let ok: Promise<boolean>;
    act(() => void (ok = keys.newCode("pw")));
    expect(keys.code).toBe("AAAA-BBBB-CCCC");
    expect(keys.busy).toBe(true);
    await act(async () => {
      finish();
      await ok;
    });
    expect(keys.busy).toBe(false);
    expect(keys.code).toBe("AAAA-BBBB-CCCC"); // until the person has saved it
    act(() => keys.codeSaved());
    expect(keys.code).toBeNull();
  });

  it("a code that was committed stays shown when the cleanup after the commit fails (GM2-1): the error is told as well", async () => {
    mount({
      newRecoveryCode: async (_pw, d) => {
        d.onCode("AAAA-BBBB-CCCC"); // the change has committed
        throw new ServiceError("bad_state"); // and what runs after it did not
      },
    });
    await act(async () => void (await keys.newCode("pw")));
    expect(keys.code).toBe("AAAA-BBBB-CCCC");
    expect(keys.error).not.toBeNull();
    expect(reloads).toBe(1); // the page reads what is true
  });

  it("a master password turned on and a key replaced hand their code over the same way", async () => {
    mount({
      enableMasterPassword: async (_pw, d) => d.onCode("ENABLE-CODE"),
      rotateKey: async (_pw, d) => d.onCode("ROTATE-CODE"),
    });
    await act(async () => void (await keys.enable(STRONG, false)));
    expect(keys.code).toBe("ENABLE-CODE");
    act(() => keys.codeSaved());
    await act(async () => void (await keys.rotate("pw")));
    expect(keys.code).toBe("ROTATE-CODE");
  });

  it("a password change's outcome is kept for whoever asks, a refusal too, and the page reads what is true after it", async () => {
    mount({
      changePassword: async (o) => {
        if (o === "wrong") throw new ServiceError("wrong_secret");
      },
    });
    await act(async () => void (await keys.change("right", STRONG, false)));
    expect(keys.info).toBe("Password changed");
    expect(keys.error).toBeNull();
    await act(async () => void (await keys.change("wrong", STRONG, false)));
    expect(keys.error).not.toBeNull();
    expect(keys.info).toBeNull();
    expect(reloads).toBe(1);
    act(() => keys.clear());
    expect(keys.error).toBeNull();
  });

  it("a password too weak for the page's rule is refused before anything is written", async () => {
    const write = vi.fn(async () => undefined);
    mount({ changePassword: write });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await keys.change("old", "short", true); // "Use anyway" never passes the floor
    });
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(keys.error).not.toBeNull();
  });

  it("below 50 bits, past the floor: refused without 'Use anyway', written with it (OWNER-DECISIONS/15)", async () => {
    const OWN = "JennyLovesTea"; // 13 characters, about 34 bits
    const change = vi.fn(async () => undefined);
    const enable = vi.fn(async () => undefined);
    mount({ changePassword: change, enableMasterPassword: enable });
    let ok: boolean[] = [];
    await act(async () => {
      ok = [await keys.change("old", OWN, false), await keys.enable(OWN, false)];
    });
    expect(ok).toEqual([false, false]);
    expect(change).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    await act(async () => {
      ok = [await keys.change("old", OWN, true), await keys.enable(OWN, true)];
    });
    expect(ok).toEqual([true, true]);
    expect(change).toHaveBeenCalledWith("old", OWN);
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("one operation at a time", async () => {
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>((r) => (finish = r)));
    mount({ rotateKey: write });
    let first!: Promise<boolean>;
    act(() => void (first = keys.rotate("pw")));
    let second: boolean | undefined;
    await act(async () => {
      second = await keys.rotate("pw");
    });
    expect(second).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await first;
    });
  });
});

describe("the questions about deleting an imported file are kept until answered (import-asks.ts)", () => {
  const ask = (id: number): Ask => ({
    id,
    name: `f${id}.txt`,
    handle: null,
    seen: {} as never,
    left: 0,
    hotp: 0,
    state: "ask",
  });
  let seen: Ask[];
  const mount = () => {
    function Holder() {
      seen = useAsks();
      return null;
    }
    act(() => render(h(Holder, {}), root as unknown as Element));
  };

  it("what a leaf added is still there when another component asks, and after the first is gone", () => {
    setAsks(() => [ask(1)]);
    act(() => render(null, root as unknown as Element)); // the leaf that added it is unmounted
    mount();
    expect(seen.map((a) => a.id)).toEqual([1]);
    act(() => setAsks((cur) => [...cur, ask(2)]));
    expect(seen.map((a) => a.id)).toEqual([1, 2]);
    act(() => setAsks((cur) => cur.filter((a) => a.id !== 1)));
    expect(seen.map((a) => a.id)).toEqual([2]);
    act(() => setAsks(() => []));
    expect(seen).toEqual([]);
  });
});

describe("a file handed over from Backup (import-handoff.ts)", () => {
  const file = (name: string): Picked => ({ file: new File(["x"], name), handle: null });
  afterEach(() => dropHandoffs());

  it("waits only until Add account takes it, and is not read again on the next visit", () => {
    const got: string[][] = [];
    handToAdd([file("a.txt")]);
    let stop = takeHandoffs((f) => got.push(f.map((x) => x.file.name)));
    expect(got).toEqual([["a.txt"]]);
    stop();
    stop = takeHandoffs((f) => got.push(f.map((x) => x.file.name))); // the next visit
    expect(got).toEqual([["a.txt"]]);
    stop();
  });

  it("goes straight to Add account when it is on the page", () => {
    const got: string[] = [];
    const stop = takeHandoffs((f) => got.push(...f.map((x) => x.file.name)));
    handToAdd([file("b.txt")]);
    expect(got).toEqual(["b.txt"]);
    stop();
  });

  it("a lock drops what waits, and refuses a hand-over begun before it", () => {
    const since = handoffEpoch(); // the file is being read...
    dropHandoffs(); // ...Sixkey locks
    expect(handToAdd([file("late.txt")], since)).toBe(false);
    const got: string[] = [];
    const stop = takeHandoffs((f) => got.push(...f.map((x) => x.file.name)));
    expect(got).toEqual([]);
    stop();
    handToAdd([file("waits.txt")]);
    dropHandoffs();
    const stop2 = takeHandoffs((f) => got.push(...f.map((x) => x.file.name)));
    expect(got).toEqual([]);
    stop2();
  });
});
