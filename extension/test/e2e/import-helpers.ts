// File import and camera scan in the e2e suite (IMPORT-FILE-NOTES.md §8). A profile launched with Chromium's fake
// camera (--use-fake-device-for-media-stream, and --use-fake-ui-for-media-stream to answer the permission prompt), and
// optionally a video file for it: a Y4M of QR codes, so the camera path decodes a real code end to end. Every secret is
// made up (test/helpers/import-fixtures.ts).
import { chromium, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import encodeQR from "qr";
import { close, DIST, type Profile } from "./harness";

export const FAKE_CAMERA = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

const reported = new WeakMap<Profile["ctx"], string[]>();

/** launch() with more browser flags: the fake camera, say. Text keys shown without text are checked at closeWith(). */
export async function launchWith(args: string[]): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), "sixkey-e2e-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...args],
    acceptDownloads: true,
  });
  const found: string[] = [];
  reported.set(ctx, found);
  const watch = (page: Page) =>
    page.on("console", (m) => {
      if (m.type() === "error" && m.text().startsWith("sixkey i18n:")) found.push(m.text());
    });
  ctx.pages().forEach(watch);
  ctx.on("page", watch);
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { dir, ctx, id: new URL(sw.url()).host };
}

export async function closeWith(p: Profile): Promise<void> {
  const missing = [...(reported.get(p.ctx) ?? [])];
  await close(p);
  if (missing.length)
    throw new Error(`message keys were shown without their text:\n${[...new Set(missing)].join("\n")}`);
}

/**
 * A Y4M video (the format Chromium's --use-file-for-fake-video-capture reads) showing each text as a QR code for
 * `frames` frames, at 10 frames a second, grey on white, 4:2:0. The fake camera plays it in a loop.
 */
export function qrVideo(texts: string[], o: { size?: number; frames?: number } = {}): Buffer {
  const W = o.size ?? 360;
  const H = W;
  const frames = o.frames ?? 10;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420mpeg2\n`);
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const parts: Buffer[] = [header];
  for (const text of texts) {
    const m = encodeQR(text, "raw");
    const quiet = 4;
    const n = m.length + quiet * 2;
    const scale = Math.floor(W / n);
    const off = Math.floor((W - n * scale) / 2);
    const y = Buffer.alloc(W * H, 235);
    for (let py = 0; py < H; py++)
      for (let px = 0; px < W; px++) {
        const my = Math.floor((py - off) / scale) - quiet;
        const mx = Math.floor((px - off) / scale) - quiet;
        if (my >= 0 && my < m.length && mx >= 0 && mx < m.length && m[my]![mx]) y[py * W + px] = 16;
      }
    for (let f = 0; f < frames; f++) parts.push(Buffer.from("FRAME\n"), y, chroma);
  }
  return Buffer.concat(parts);
}

/**
 * Stands in for the browser's file picker on `page`: showOpenFilePicker answers with real FileSystemFileHandles of the
 * extension's private file system (navigator.storage), holding each text under its name, so a delete goes through a
 * real handle's requestPermission and remove(). `permission: "denied"` replaces requestPermission's answer ("granted"
 * is the real one). One file, or several at once.
 */
export async function stubPicker(
  page: Page,
  files: string | { name: string; text: string }[],
  text = "",
  permission?: "denied",
): Promise<void> {
  const list = typeof files === "string" ? [{ name: files, text }] : files;
  await page.evaluate(
    async ([fs, deny]) => {
      const root = await navigator.storage.getDirectory();
      const handles: unknown[] = [];
      for (const f of fs) {
        const h = await root.getFileHandle(f.name, { create: true });
        const w = await h.createWritable();
        await w.write(f.text);
        await w.close();
        handles.push(
          deny
            ? {
                kind: "file",
                name: h.name,
                getFile: () => h.getFile(),
                remove: () => (h as unknown as { remove(): Promise<void> }).remove(),
                requestPermission: async () => "denied",
              }
            : h,
        );
      }
      (window as unknown as { showOpenFilePicker: () => Promise<unknown[]> }).showOpenFilePicker = async () => handles;
    },
    [list, permission ?? ""] as const,
  );
}

/** Whether the private file system still holds `name`. */
export const opfsHas = (page: Page, name: string) =>
  page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.getFileHandle(n);
      return true;
    } catch {
      return false;
    }
  }, name);

/** Rewrites `name` in the private file system (the file changes after Sixkey read it). */
export const opfsTouch = (page: Page, name: string, text: string) =>
  page.evaluate(
    async ([n, t]) => {
      const root = await navigator.storage.getDirectory();
      const w = await (await root.getFileHandle(n!)).createWritable();
      await w.write(t!);
      await w.close();
    },
    [name, text] as const,
  );

/**
 * Records every camera track the page's getUserMedia hands out (window.__camTracks), so a test can see that each one
 * was stopped. Installed before any page of the profile loads.
 */
export async function recordTracks(p: Profile): Promise<void> {
  await p.ctx.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const real = md.getUserMedia.bind(md);
    const w = window as unknown as { __camTracks: MediaStreamTrack[] };
    w.__camTracks = [];
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const stream = await real(c);
      w.__camTracks.push(...stream.getTracks());
      return stream;
    };
  });
}

/** The states of the camera tracks handed out so far: "live" or "ended". */
export const trackStates = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __camTracks?: MediaStreamTrack[] }).__camTracks?.map((t) => t.readyState) ?? [],
  );
