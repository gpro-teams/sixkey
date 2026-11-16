// The service worker's size limit (scripts/check-dist.mjs), gzipped, by build flavour. Its own module so that a test can
// hold the store build's limit apart from every release gate (test/unit/rules-update-check-dist.test.ts).
//
// SW_BUDGET_GZ is the worker's budget (CLOUD-BACKUP §6.4: patch 4 set it, patch 5 tightened it after A4's trim; review P4,
// A7). RULES_UPDATER_GZ is the room the site rules' updater takes in the worker (TOTP autofill Stage 3, AF3-U2; docs/
// design/notes/AUTOFILL3-NOTES.md §10: measured at 9,061 B gz in the e2e build, the format's checker and the signed
// manifest's checks being most of it), given to the dev and e2e builds, which always carry the updater, and to no store
// build: the store build's limit does not follow the updater's release gate (scripts/rules-update.mjs), so a store
// build with the gate open fails on its worker's size until the owner agrees to give it this room, in the change that
// opens the gate (AF3-U3; the maintainers' C33 and C27, the plan's C14).
export const SW_BUDGET_GZ = 104 * 1024;
export const RULES_UPDATER_GZ = 9 * 1024;

/** The worker's limit for a build flavour ("prod", "dev", "e2e"); the dev build's is not held (it is not minified). */
export const swBudgetOf = (flavour) => SW_BUDGET_GZ + (flavour === "prod" ? 0 : RULES_UPDATER_GZ);
