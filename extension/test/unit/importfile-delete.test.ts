// Deleting the imported file (IMPORT-FILE-NOTES.md §5), with fake handles: exactly the handle picked, only after the
// read-write permission is granted (asked first, while the click counts), only when the file is as it was read, and
// every failure reported, never thrown. Also the picker and the drop: handles asked for inside the drop event.
import { describe, expect, it } from "vitest";
import {
  deletePicked,
  droppedFiles,
  hasPicker,
  pickFiles,
  sha256Hex,
  type FileHandleLike,
  type Permission,
} from "../../src/platform/file-access";

const SEEN = { size: 1283, lastModified: 1_760_000_000_000 };

function fakeHandle(o: {
  permission?: Permission | "throw";
  file?: { size: number; lastModified: number } | "throw";
  remove?: "ok" | "NotAllowedError" | "NotFoundError" | "NoModificationAllowedError" | "missing";
  noRequest?: boolean;
  kind?: string;
}) {
  const calls: string[] = [];
  const h: FileHandleLike = {
    kind: o.kind ?? "file",
    name: "authenticator-uris.txt",
    async getFile() {
      calls.push("getFile");
      if (o.file === "throw") throw Object.assign(new Error("gone"), { name: "NotFoundError" });
      return o.file ?? SEEN;
    },
  };
  if (!o.noRequest)
    h.requestPermission = async (d) => {
      calls.push(`requestPermission:${d.mode}`);
      if (o.permission === "throw") throw Object.assign(new Error("no activation"), { name: "SecurityError" });
      return o.permission ?? "granted";
    };
  if (o.remove !== "missing")
    h.remove = async () => {
      calls.push("remove");
      if (o.remove && o.remove !== "ok") throw Object.assign(new Error("x"), { name: o.remove });
    };
  return { h, calls };
}

describe("deletePicked", () => {
  it("granted and unchanged: the permission first, then the file is checked, then removed", async () => {
    const { h, calls } = fakeHandle({});
    expect(await deletePicked(h, SEEN)).toBe("deleted");
    expect(calls).toEqual(["requestPermission:readwrite", "getFile", "remove"]);
  });

  it("denied, dismissed or not allowed: nothing is removed", async () => {
    for (const permission of ["denied", "prompt", "throw"] as const) {
      const { h, calls } = fakeHandle({ permission });
      expect(await deletePicked(h, SEEN), permission).toBe("denied");
      expect(calls).not.toContain("remove");
    }
  });

  it("the file changed since it was read (size, time, or gone): it is left alone", async () => {
    for (const file of [
      { ...SEEN, size: SEEN.size + 1 },
      { ...SEEN, lastModified: SEEN.lastModified + 1 },
      "throw",
    ] as const) {
      const { h, calls } = fakeHandle({ file });
      expect(await deletePicked(h, SEEN)).toBe("changed");
      expect(calls).not.toContain("remove");
    }
  });

  it("remove() fails: reported, never thrown", async () => {
    expect(await deletePicked(fakeHandle({ remove: "NotAllowedError" }).h, SEEN)).toBe("denied");
    expect(await deletePicked(fakeHandle({ remove: "NotFoundError" }).h, SEEN)).toBe("changed");
    expect(await deletePicked(fakeHandle({ remove: "NoModificationAllowedError" }).h, SEEN)).toBe("failed");
  });

  it("no handle, a folder, or a browser without remove(): unsupported, and no permission is asked", async () => {
    expect(await deletePicked(null, SEEN)).toBe("unsupported");
    const folder = fakeHandle({ kind: "directory" });
    expect(await deletePicked(folder.h, SEEN)).toBe("unsupported");
    const old = fakeHandle({ remove: "missing" });
    expect(await deletePicked(old.h, SEEN)).toBe("unsupported");
    expect(old.calls).toEqual([]);
  });

  it("a browser without requestPermission still checks the file before removing it", async () => {
    const { h, calls } = fakeHandle({ noRequest: true });
    expect(await deletePicked(h, SEEN)).toBe("deleted");
    expect(calls).toEqual(["getFile", "remove"]);
  });

  it("only the handle given is touched", async () => {
    const picked = fakeHandle({});
    const other = fakeHandle({});
    await deletePicked(picked.h, SEEN);
    expect(other.calls).toEqual([]);
  });
});

describe("pickFiles and droppedFiles", () => {
  const file = (name: string) => new File(["x"], name, { lastModified: 5 });

  it("no picker: null, so the page opens its <input type=file>", async () => {
    expect(hasPicker({})).toBe(false);
    expect(await pickFiles({})).toBeNull();
  });

  it("the picker's files come with their handles; a cancelled picker is an empty choice", async () => {
    const h = { kind: "file", name: "a.txt", getFile: async () => file("a.txt") };
    const dir = { kind: "directory", name: "d", getFile: async () => file("d") };
    const w = { showOpenFilePicker: async () => [h, dir] };
    expect(hasPicker(w)).toBe(true);
    const got = await pickFiles(w);
    expect(got?.map((p) => [p.file.name, p.handle === h])).toEqual([["a.txt", true]]);
    const abort = {
      showOpenFilePicker: async () => Promise.reject(Object.assign(new Error(), { name: "AbortError" })),
    };
    expect(await pickFiles(abort)).toEqual([]);
    const broken = {
      showOpenFilePicker: async () => Promise.reject(Object.assign(new Error(), { name: "SecurityError" })),
    };
    expect(await pickFiles(broken)).toBeNull();
  });

  it("a drop asks every item for its file and its handle at once, before anything is awaited", async () => {
    const asked: string[] = [];
    let open = true; // the drop's data: readable only during the event
    const item = (name: string, handle: boolean) => ({
      kind: "file",
      getAsFile: () => (asked.push(`file:${name}`), open ? file(name) : null),
      ...(handle
        ? {
            getAsFileSystemHandle: () => {
              asked.push(`handle:${name}`);
              return Promise.resolve(open ? { kind: "file", name, getFile: async () => file(name) } : null);
            },
          }
        : {}),
    });
    const p = droppedFiles({
      items: [item("a.txt", true), item("b.png", false), { kind: "string", getAsFile: () => null }],
    });
    open = false; // the event is over
    expect(asked).toEqual(["file:a.txt", "handle:a.txt", "file:b.png"]);
    const got = await p;
    expect(got.map((x) => [x.file.name, x.handle !== null])).toEqual([
      ["a.txt", true],
      ["b.png", false],
    ]);
  });

  it("a dropped folder gives no handle; a drop with files but no items still gives the files", async () => {
    const got = await droppedFiles({
      items: [
        {
          kind: "file",
          getAsFile: () => file("x"),
          getAsFileSystemHandle: async () => ({ kind: "directory", name: "x", getFile: async () => file("x") }),
        },
      ],
    });
    expect(got[0]!.handle).toBeNull();
    expect((await droppedFiles({ files: [file("y")] })).map((x) => x.file.name)).toEqual(["y"]);
    expect(await droppedFiles(null)).toEqual([]);
  });
});

describe("deletePicked: the file's bytes as read (SHA-256)", () => {
  const bytes = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer;
  const handleOf = (content: string, calls: string[]): FileHandleLike => ({
    kind: "file",
    name: "x.txt",
    getFile: async () => ({ size: 5, lastModified: 9, arrayBuffer: async () => bytes(content) }),
    requestPermission: async () => "granted",
    remove: async () => void calls.push("remove"),
  });

  it("the same bytes: deleted; other bytes under the same size and time (cp -p, a sync tool): left alone", async () => {
    const seen = { size: 5, lastModified: 9, sha256: await sha256Hex(bytes("hello")) };
    const same: string[] = [];
    expect(await deletePicked(handleOf("hello", same), seen)).toBe("deleted");
    expect(same).toEqual(["remove"]);
    const other: string[] = [];
    expect(await deletePicked(handleOf("jello", other), seen)).toBe("changed");
    expect(other).toEqual([]);
  });

  it("a hash to compare but no bytes to read: left alone", async () => {
    const calls: string[] = [];
    const h: FileHandleLike = {
      kind: "file",
      name: "x",
      getFile: async () => ({ size: 5, lastModified: 9 }),
      remove: async () => void calls.push("remove"),
    };
    expect(await deletePicked(h, { size: 5, lastModified: 9, sha256: "00" })).toBe("changed");
    expect(calls).toEqual([]);
  });
});
