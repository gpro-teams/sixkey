// The settings page's parts of the backup in Chrome's sync storage, as one lazy chunk (assets/CsbPages-*.js): Settings ›
// Backup's card (CsbCard.tsx), first run's parts (CsbFirstRun.tsx), and the writes and messages they make (merge.ts).
// Backup.tsx and FirstRun.tsx import this module and nothing else of src/options/csb/, so the popup's and the side
// panel's counted code cannot gain anything through it (scripts/check-dist.mjs holds the pages to their budgets).
export { CsbCard } from "./CsbCard";
export { CsbAfter, CsbBox, CsbFound, CsbRestore } from "./CsbFirstRun";
export { boxCleared, finishRestore, turnOn, type BackupOutcome } from "./merge";
