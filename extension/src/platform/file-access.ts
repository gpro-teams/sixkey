// Files the user picks or drops on Settings > Add account, and deleting one of them afterwards when the user asks
// (docs/design/notes/IMPORT-FILE-NOTES.md §5). The File System Access API gives a handle for a picked file
// (showOpenFilePicker, Chrome 86) or a dropped one (DataTransferItem.getAsFileSystemHandle, Chrome 86); with a handle,
// FileSystemHandle.remove() (Chrome 110, non-standard) can delete the file after a read-write permission prompt. Without
// a handle (the <input type=file> fallback, a pasted image, a file handed over from the Backup section) nothing can be
// deleted and the page says how to do it by hand. Everything is feature-detected; the interfaces below are the parts
// used, so tests can hand in fakes. Nothing here reads a file's content or logs anything.

export type Permission = "granted" | "denied" | "prompt";

/** The part of a File used to tell whether it changed. */
export type FileLike = { size: number; lastModified: number; arrayBuffer?(): Promise<ArrayBuffer> };

/** The part of a FileSystemFileHandle used here. */
export interface FileHandleLike {
  readonly kind: string;
  readonly name: string;
  getFile(): Promise<FileLike>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<Permission>;
  remove?(): Promise<void>;
}

/** A chosen file, with its handle when the browser gave one. */
export type Picked = { file: File; handle: FileHandleLike | null };

/**
 * What the file looked like when it was read: a delete is refused once it no longer looks like that. `sha256`: the hex
 * SHA-256 of its bytes as read (a file replaced with the same size and time, by `cp -p` or a sync tool, differs there);
 * it stays in the page's memory with the delete prompt and goes with it.
 */
export type Seen = { size: number; lastModified: number; sha256?: string };

/** The hex SHA-256 of some bytes (WebCrypto). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A handle as the picker gives it: its file is a File. */
type PickerHandle = Omit<FileHandleLike, "getFile"> & { getFile(): Promise<File> };
type PickerWindow = { showOpenFilePicker?: (o: { multiple?: boolean }) => Promise<PickerHandle[]> };

/** Whether the browser has a file picker that gives handles. Without one the page uses its <input type=file>. */
export const hasPicker = (w: unknown = globalThis): boolean =>
  typeof (w as PickerWindow).showOpenFilePicker === "function";

/**
 * Files picked with the browser's picker, each with its handle; [] when the picker was closed without a choice; null
 * when there is no picker or it could not open (the caller then opens the <input type=file>). Every file type is
 * offered: what a file is, is read from its content.
 */
export async function pickFiles(w: unknown = globalThis): Promise<Picked[] | null> {
  const pick = (w as PickerWindow).showOpenFilePicker;
  if (typeof pick !== "function") return null;
  let handles: PickerHandle[];
  try {
    handles = await pick.call(w, { multiple: true });
  } catch (e) {
    return (e as { name?: unknown })?.name === "AbortError" ? [] : null;
  }
  const out: Picked[] = [];
  for (const h of handles) {
    if (h.kind !== "file") continue;
    try {
      out.push({ file: await h.getFile(), handle: h });
    } catch {
      /* gone or unreadable since it was picked: left out */
    }
  }
  return out;
}

type DropItem = {
  kind: string;
  getAsFile(): File | null;
  getAsFileSystemHandle?: () => Promise<FileHandleLike | null>;
};

/**
 * The files of a drop, each with its handle when the browser gives one. It must be called inside the drop event,
 * before anything is awaited: the drop's data is readable only then, so every item is asked for its file and its
 * handle at once, and only the answers are awaited. A folder is left out.
 */
export function droppedFiles(dt: { items?: ArrayLike<DropItem>; files?: ArrayLike<File> } | null): Promise<Picked[]> {
  if (!dt) return Promise.resolve([]);
  const items = dt.items ? Array.from(dt.items).filter((i) => i.kind === "file") : [];
  if (!items.length) return Promise.resolve(Array.from(dt.files ?? [], (file) => ({ file, handle: null })));
  const asked = items.map((i) => {
    const file = i.getAsFile();
    let handle: Promise<FileHandleLike | null> = Promise.resolve(null);
    try {
      if (typeof i.getAsFileSystemHandle === "function") handle = i.getAsFileSystemHandle().catch(() => null);
    } catch {
      /* no handle for this item */
    }
    return { file, handle };
  });
  return Promise.all(
    asked.map(async ({ file, handle }) => {
      const h = await handle;
      return { file, handle: h && h.kind === "file" ? h : null };
    }),
  ).then((all) => all.filter((p): p is Picked => p.file !== null));
}

/**
 * The outcome of deleting a file the user picked:
 *   deleted      the file is gone (moved nowhere: removed; whether its bytes can still be recovered is up to the disk)
 *   unsupported  no handle, or this browser cannot delete through one: the page says how to delete it by hand
 *   denied       the user did not allow Sixkey to change the file, or the browser refused
 *   changed      the file is not as Sixkey read it (written again, replaced, moved or deleted since; its size, time
 *                or SHA-256 differ): left alone
 *   failed       the browser could not delete it (locked by another program, say)
 */
export type DeleteOutcome = "deleted" | "unsupported" | "denied" | "changed" | "failed";

/**
 * Deletes exactly the file behind `handle`, the one the user picked or dropped, and only if it still is as it was
 * when it was read (`seen`: size, time, and the SHA-256 of its bytes). Called from the click on "Delete file" only. The read-write permission is asked first,
 * while the click still counts as the user's (Chrome shows its own prompt, which needs that); then the file is looked
 * at; then it is removed. Never throws.
 */
export async function deletePicked(handle: FileHandleLike | null, seen: Seen): Promise<DeleteOutcome> {
  if (!handle || handle.kind !== "file" || typeof handle.remove !== "function") return "unsupported";
  if (typeof handle.requestPermission === "function") {
    let state: Permission;
    try {
      state = await handle.requestPermission({ mode: "readwrite" });
    } catch {
      return "denied"; // no user activation, or not allowed here
    }
    if (state !== "granted") return "denied";
  }
  let now: FileLike;
  try {
    now = await handle.getFile();
  } catch {
    return "changed"; // moved or deleted since it was read
  }
  if (now.size !== seen.size || now.lastModified !== seen.lastModified) return "changed";
  if (seen.sha256 !== undefined) {
    try {
      if (!now.arrayBuffer || (await sha256Hex(await now.arrayBuffer())) !== seen.sha256) return "changed";
    } catch {
      return "changed"; // cannot be read again: not the file Sixkey read, as far as it can tell
    }
  }
  try {
    await handle.remove();
    return "deleted";
  } catch (e) {
    const name = (e as { name?: unknown })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (name === "NotFoundError") return "changed";
    return "failed";
  }
}
