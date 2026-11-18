// The user name typed on the page the popup was opened over, so the account it names can be listed first (the owner's
// report of 2026-11-18: on a site with 14 accounts, the one whose name was already in the page's user name box was 4th).
// One executeScript call, `func` only, top frame only, isolated world, only when Sixkey already holds `scripting` (asked
// for in a click by armScripting below, or by a Fill) and its storage is closed to content scripts
// (platform/storage-access.ts storageClosed, as Fill checks).
// What comes back is page data: a short string, used for ordering the list and nothing else; it is never stored or sent.
import { storageClosed } from "./storage-access";

/** The longest value taken from the page; anything longer is no user name. */
export const MAX_USER = 128;
const CALL_MS = 1500;

/** Whether Sixkey held `scripting` at the last look (pageUser). */
let wasHeld = false;
/** Whether Sixkey holds `scripting` now (as platform/autofill.ts scriptingHeld; restated to keep this chunk small). */
async function held(): Promise<boolean> {
  const c = globalThis.chrome;
  if (typeof c?.permissions?.contains !== "function") return (wasHeld = false);
  try {
    return (wasHeld = await c.permissions.contains({ permissions: ["scripting"] }));
  } catch {
    return (wasHeld = false);
  }
}

/**
 * The popup's (or the side panel's) first click or key press asks for `scripting` first thing (Chrome grants only in the
 * user's gesture, and opening the popup is none; it grants this one without a dialog), so the next opening can read the
 * user name (the owner's report of 2026-11-18: `scripting` was asked for only by a first Fill, so a vault that never
 * filled never had its account listed first). Not while it is held, nor while autofill is switched off (the page hint
 * `sk_af_off`, platform/autofill-sites.ts offHint, restated: Off gives `scripting` back, and asking again would fight
 * it). The list does not move in this opening: nothing is reordered under the pointer that just clicked.
 */
let armed = false;
export function armScripting(): void {
  if (armed || wasHeld) return;
  armed = true;
  const ask = () => {
    removeEventListener("click", ask, true);
    removeEventListener("keydown", ask, true);
    if (wasHeld) return;
    try {
      if (localStorage.getItem("sk_af_off") !== null) return;
      void chrome.permissions.request({ permissions: ["scripting"] }).then(
        (ok) => void (wasHeld = ok),
        () => undefined,
      );
    } catch {
      // no permissions API, or no page storage: nothing asked
    }
  };
  addEventListener("click", ask, true);
  addEventListener("keydown", ask, true);
}

/**
 * Serialised into the page by executeScript: it must use nothing of this module. The value of the visible text field that
 * looks most like a user name box (its autocomplete, name, id, placeholder or label say so; or it comes before a
 * password field), or null. A page with no password field and no field that says it is a user name gives null.
 */
export function pickUser(max: number): string | null {
  const shown = (el: HTMLInputElement) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter((i) => !i.disabled && shown(i));
  const pw = inputs.find((i) => i.type === "password");
  let best: HTMLInputElement | null = null;
  let top = -1;
  for (const i of inputs) {
    if (i.type !== "text" && i.type !== "email" && i.type !== "tel") continue;
    const v = i.value.trim();
    if (!v) continue;
    const ac = (i.getAttribute("autocomplete") || "").toLowerCase();
    const said = `${i.name} ${i.id} ${i.placeholder} ${i.getAttribute("aria-label") || ""}`.toLowerCase();
    let s = 0;
    if (ac.includes("username") || ac === "email") s += 3;
    if (/user|login|account|email|mail|用户|账号|帳號|帐号|邮箱|手机/.test(said)) s += 2;
    if (pw && i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) s += 1;
    if (s > top) {
      top = s;
      best = i;
    }
  }
  if (!best || (!pw && top < 2)) return null;
  const v = best.value.trim();
  return v.length <= max ? v : null;
}

/** The user name typed on tab `tabId`, or null (not held, gated, nothing there, a page that cannot be scripted, slow). */
export async function pageUser(tabId: number | undefined): Promise<string | null> {
  if (typeof tabId !== "number" || !(await held()) || !(await storageClosed())) return null;
  try {
    const run = chrome.scripting.executeScript({ target: { tabId }, func: pickUser, args: [MAX_USER] });
    const res = await Promise.race([run, new Promise<null>((ok) => setTimeout(() => ok(null), CALL_MS))]);
    const v = res?.[0]?.result;
    return typeof v === "string" && v.length > 0 && v.length <= MAX_USER ? v : null;
  } catch {
    return null;
  }
}
