// The release gate of the sync user interface (SYNC-DESIGN §9: M6 builds it, M8 puts the cloud behind it).
//
// The settings page's Sync section, its flows and its text are built into the dev and e2e flavours always, and into the
// store (prod) flavour only when SYNC_UI_IN_STORE_BUILD is true. While it is false, a store build holds none of it: the
// section's code is not in the module graph at all (the gated import is removed before the bundler loads it), its
// catalogs and its chunk are not emitted, and the enrolment code stays forbidden in that build, exactly as before M6
// (scripts/build.mjs fails a prod build whose graph reaches it; scripts/check-dist.mjs checks the built files again).
//
// Flipping it is one reviewed change, made with the cloud go-live (M8, OWNER-DECISIONS/10): this constant, the test
// that pins it (test/unit/m6-gate.test.ts), the store's permission text and OWNER-DECISIONS/06's "no network" line, all
// in the same change. Nothing else can turn the section on: no environment variable, command-line flag or other define
// (the same test checks that this module is the only place the value comes from).
//
// Besides the section, a flip gives the store build's worker its sync worker, bridge and transport back, and the build
// its API origin (src/background/sw.ts, scripts/build.mjs). Before the flip the store build has no API host for autofill
// to refuse, so api.sixkey.app may be on a profile's list of autofill sites; after it, that site is dropped from the list
// without a word (src/core/autofill-sites.ts readSites), and its grant is removed at the next browser start while sync
// is not set up (src/platform/sync-worker.ts).
export const SYNC_UI_IN_STORE_BUILD = false;

/** Whether a build flavour ("prod", "dev", "e2e") carries the sync user interface. */
export const syncUiIn = (flavour) => (flavour === "prod" ? SYNC_UI_IN_STORE_BUILD : true);
