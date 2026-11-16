// "Turn on now", handed from a click elsewhere to Settings › Backup's card: the popup's and the side panel's "立即备份"
// (src/popup/main/CsbPop.tsx) leaves the click's time here (chrome.storage.session, memory only) and opens the card of
// the backup in Chrome's sync storage (src/options/csb/CsbCard.tsx), which takes it within a minute and turns the
// backup on as it loads, unless the person turned it off before. (The Google Drive card took it the same way to connect,
// CLOUDBK patches 5 and 6; that card's code is gone.)
// The time and nothing else. A module of its own, so the popup can leave it without loading the settings page's code.
export const GO_KEY = "sk_cloud_go";
const GO_FOR_MS = 60_000;

/** Leave "turn on now" for the card. */
export const wantConnect = () => chrome.storage.session.set({ [GO_KEY]: Date.now() }).catch(() => undefined);

/** Whether "turn on now" was left for this page within the last minute; taken either way. */
export async function takeConnect(now = Date.now()): Promise<boolean> {
  try {
    const at = (await chrome.storage.session.get([GO_KEY]))[GO_KEY];
    await chrome.storage.session.remove([GO_KEY]);
    return typeof at === "number" && now - at >= 0 && now - at < GO_FOR_MS;
  } catch {
    return false;
  }
}
