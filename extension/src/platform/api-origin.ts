// The sync API origin this build talks to (SYNC-DESIGN §5.2, §7): scripts/api-origin.mjs, injected by scripts/build.mjs
// (Vite define). It is the manifest's only host permission and the CSP's only connect-src source, and it is the origin
// whose host every request signature covers. A device identity remembers the origin it was made for, so a dev build and
// a prod build never use each other's (§2.5 apiOrigin).
//
// Empty in a build without the sync user interface (the store build with the release gate closed, scripts/sync-ui.mjs):
// that build has no sync worker, talks to no API and names none (scripts/check-dist.mjs holds it to that).
//
// Read through typeof, so code that runs unbuilt (the unit tests) gets the prod origin; tests that need another one pass
// it to the code under test instead of relying on this constant.
declare const __API_ORIGIN__: string;

export const API_ORIGIN: string = typeof __API_ORIGIN__ === "string" ? __API_ORIGIN__ : "https://api.sixkey.app";
