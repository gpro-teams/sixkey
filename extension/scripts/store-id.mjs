// Sixkey's extension ID in the Chrome Web Store: the one place it is written down (SYNC-DESIGN H4, PHASE0X-PLAN C3).
//
// Set: the store assigned it to Sixkey's item when the ID draft was uploaded (README.md, "Publishing", steps 1 and 2).
// The install-source check (src/platform/install-source.ts) reports a copy that was not installed from the store, and
// also one whose ID differs from this; the settings page shows both IDs side by side. Before it was set it was empty,
// and the check only looked at how a copy was installed.
//
// It belongs to the store item, not to a package, so it should change only if Sixkey moves to a new item. Then empty
// it (the ID draft is refused while it is set), upload an ID draft as the new item (`npm run package -- --id-draft`),
// write the new item's ID here, and build and upload the store package again; copies from the old item then show the
// install-source notice. test/unit/prf-source-rules.test.ts holds the value, so change it there too.
//
// - scripts/build.mjs injects it into the prod build as __STORE_ID__, with __INSTALL_CHECK__ on. Dev and e2e builds get
//   "" and the check off, so they never show the banner; test/e2e/install-source.spec.ts asserts it on the prod build.
//   The test build (--test, loaded unpacked by hand) gets the ID with the check off, so it never shows the banner either.
// - scripts/check-dist.mjs fails a prod build that does not contain it.
// - scripts/package.mjs refuses the store package while it is empty or the developer build's ID
//   (scripts/store-gates.mjs storeIdGate); test/unit/m5-build-guard.test.ts proves both refusals in copies of the tree.
// The format is the one Chrome uses for every extension ID: 32 letters from a to p.
export const STORE_ID = "bbfpkjnpfcddoagjiadebfafdfbckpho";
