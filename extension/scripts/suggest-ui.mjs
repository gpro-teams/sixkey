// The release gate of TOTP autofill's in-page suggestion (Stage 2, patch 4; docs/design/notes/AUTOFILL2-NOTES.md §12).
//
// With the gate open, the content script on a site the user turned on may draw a suggestion next to the code box, whose
// click opens Sixkey's own popup or side panel. The worker then has the content script's second message, `open`, and
// answers its first one, `cand`, with whether to draw it. The dev and e2e flavours carry this always, and the store (prod)
// flavour only when SUGGEST_UI_IN_STORE_BUILD is true.
//
// While the gate is false, a store build is patches 1 to 3: the content script draws nothing, its one message gets no
// answer, and the worker has no `open` at all. Its code is compiled out through the define `__SUGGEST_UI__`
// (scripts/build.mjs), and scripts/check-dist.mjs checks the built worker both ways: no `open` with the gate closed, the
// `open` with it open.
//
// Flipping it is one reviewed change, made after the store draft upload and the owner's real-Chrome checks: this
// constant, the test that pins it (test/unit/suggest-ui-gate.test.ts), the README rows and the store text, all in the same
// change. Nothing else can turn it on: no environment variable, command-line flag or other define (the same test checks
// that this module is the only place the value comes from).
export const SUGGEST_UI_IN_STORE_BUILD = false;

/** Whether a build flavour ("prod", "dev", "e2e") carries the in-page suggestion. */
export const suggestUiIn = (flavour) => (flavour === "prod" ? SUGGEST_UI_IN_STORE_BUILD : true);
