export type ScanResult = { k: "found"; texts: string[] } | { k: "none" } | { k: "failed" };

/**
 * Capture the visible tab and read every QR code on it (PHASE0X-PLAN B3). The texts go straight to the popup's confirm
 * page: they are no longer handed to the settings page through session storage. The image is never stored.
 */
export async function scanTab(): Promise<ScanResult> {
  try {
    const url = await chrome.tabs.captureVisibleTab({ format: "png" });
    const { decodeAllQrFromDataUrl } = await import("../../lib/qr");
    const texts = await decodeAllQrFromDataUrl(url);
    return texts.length ? { k: "found", texts } : { k: "none" };
  } catch {
    return { k: "failed" };
  }
}
