// The content script of TOTP autofill Stage 2: the code box noticed (patch 3; docs/design/notes/AUTOFILL2-NOTES.md §9)
// and, only in a build with the in-page suggestion's release gate open, the suggestion drawn next to it (patch 4b, §13).
// Registered by the worker (platform/autofill-register.ts) for the sites the user turned on, and only while storage.local
// and storage.session are closed to content scripts. It runs in Sixkey's ISOLATED world after inject/otp.js, the Stage 1
// finder, and uses that same finder (`__skOtp`, one per page): no detection of its own, and the same tokens the Fill
// button and the shortcut use.
//
// With the gate closed (scripts/suggest-ui.mjs; the store build), what it does, all of it:
//   - it listens, in the capture phase and passively (it never cancels or changes an event), for a pointerdown or a
//     keydown that the browser marks as the user's (`isTrusted`) on an <input> a code could be typed into. A page's own
//     focus(), autofocus, or an event the page made itself is never a reason to look;
//   - then, at most once every 2 s in this document, it asks the finder to look, and when the box the user is in is one the
//     finder names as a code box (score 60 or more, not weak, room for a 6- or 8-digit code), it sends the worker one
//     message, `{type: "sk-af-cand"}`, once per page address (without its hash): no field, no token, nothing of the page.
//     The worker takes who sent it from the browser (sender-policy.ts contentSender), checks the site again, and sets the
//     toolbar badge of that tab; the page gets no answer;
//   - nothing else: no element, attribute, style, event or global the page can see (`__skOtp` and this file's state live
//     in the isolated world), no storage, no network, no other message, no timer. check-dist holds the built file to that.
//
// With the gate open (dev and e2e builds until it is flipped), none of the list above holds as written: ./suggest-ui.ts
// takes over the listening (still only the user's own events), and the page gets an element of Sixkey's (`sixkey-suggest`,
// its content in a closed shadow root), Esc consumed while the suggestion is shown, the worker's answer to `sk-af-cand`, a
// second message (`sk-af-open`, the suggestion's click) and a frame loop while it is shown. Still no storage and no
// network. Its header says what and why; check-dist holds that build to its own rules (`checkSuggestion`).
import { watcher, type Finder } from "./suggest-core";
import { startSuggestion } from "./suggest-ui";

// The in-page suggestion's release gate (scripts/suggest-ui.mjs, the build's define; patch 4b, AUTOFILL2-NOTES.md §13): with
// it open the content script draws its suggestion next to the box (./suggest-ui.ts); with it closed this file is patch 3's,
// byte for byte, and ./suggest-ui.ts is not in the build (scripts/suggest-guard.mjs).
declare const __SUGGEST_UI__: boolean;
const SUGGEST_UI = typeof __SUGGEST_UI__ === "boolean" && __SUGGEST_UI__;

const finder = () => (globalThis as { __skOtp?: Finder }).__skOtp;
/** The one message; a context Chrome has since cut off (Sixkey reloaded) throws: then there is no one to tell. */
const send = () => {
  try {
    void chrome.runtime.sendMessage({ type: "sk-af-cand" }).catch(() => undefined);
  } catch {
    /* no extension context any more */
  }
};
const onEvent = watcher(finder, send);
const listen = (e: Event) => onEvent(e, location.href);
if (!SUGGEST_UI) document.addEventListener("pointerdown", listen, { capture: true, passive: true });
if (!SUGGEST_UI) document.addEventListener("keydown", listen, { capture: true, passive: true });
if (SUGGEST_UI) startSuggestion(finder); // the gate open: the suggestion's own listeners, which tell the worker too
