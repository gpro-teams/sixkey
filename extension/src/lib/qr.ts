// QR reading. BarcodeDetector (macOS and ChromeOS only) is a fast first try; the pure-JS decoder is the fallback everywhere.
// Images and screenshots stay in memory: nothing here writes a pixel to disk or sends it anywhere.
import decodeQR from "qr/decode.js";

const MAX_SIDE = 1800;
const SCALES = [1, 0.6, 0.35];

type Detector = { detect(img: ImageBitmapSource): Promise<{ rawValue: string }[]> };

async function nativeDetect(bitmap: ImageBitmap): Promise<string[]> {
  const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (!BD) return [];
  try {
    const found = await new BD({ formats: ["qr_code"] }).detect(bitmap);
    return found.map((f) => f.rawValue).filter(Boolean);
  } catch {
    return [];
  }
}

function pixels(bitmap: ImageBitmap, scale: number): { width: number; height: number; data: Uint8ClampedArray } {
  const longest = Math.max(bitmap.width, bitmap.height);
  const k = Math.min(1, MAX_SIDE / longest) * scale;
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#fff"; // transparent PNGs would otherwise decode as black
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  canvas.width = canvas.height = 0; // release the buffer
  return { width, height, data };
}

/**
 * The texts of the QR codes in the image, each once, in the order found. BarcodeDetector finds every code; the
 * fallback decoder reads at most one, so where there is no BarcodeDetector this is the first code or nothing.
 */
export async function decodeAllQrFromBitmap(bitmap: ImageBitmap): Promise<string[]> {
  const native = await nativeDetect(bitmap);
  if (native.length) return [...new Set(native)];
  for (const scale of SCALES) {
    try {
      return [decodeQR(pixels(bitmap, scale), { timeLimit: 400 })];
    } catch {
      /* not found at this scale: try the next */
    }
  }
  return [];
}

/** Every QR code in an image file or pasted screenshot (see decodeAllQrFromBitmap); none when it cannot be read. */
export async function decodeAllQrFromBlob(blob: Blob): Promise<string[]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return [];
  }
  try {
    return await decodeAllQrFromBitmap(bitmap);
  } finally {
    bitmap.close();
  }
}

/** The first QR code in an image, or null. */
export async function decodeQrFromBlob(blob: Blob): Promise<string | null> {
  return (await decodeAllQrFromBlob(blob))[0] ?? null;
}

/** Decode a data: URL (what captureVisibleTab returns) without fetch(), which the page's CSP forbids. Every code in it. */
export async function decodeAllQrFromDataUrl(url: string): Promise<string[]> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return [];
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decodeAllQrFromBlob(new Blob([bytes], { type: m[1]! }));
}
