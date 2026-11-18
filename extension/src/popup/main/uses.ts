// How often each account was used in this browser (a code copied, or filled), so that on a site the accounts used more
// often come first (the owner's question of 2026-11-18: "simply, the one clicked more often first"). Kept in this
// extension's page storage (localStorage, shared by the popup and the side panel, read with no chrome.storage call at
// their open): account ids and counts, no names and no codes; never in the vault, never synced. Read when the popup opens
// or the side panel's tab changes, so a click never moves the rows under the pointer.
const KEY = "sk_uses";

/** id → times used. Anything unreadable reads as nothing used. */
export function readUses(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** One more use of account `id`. */
export function countUse(id: string): void {
  try {
    const u = readUses();
    const n = typeof u[id] === "number" && Number.isFinite(u[id]) ? u[id] : 0;
    u[id] = Math.min(n + 1, 1_000_000);
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    // no page storage: not counted
  }
}
