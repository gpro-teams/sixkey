// The Sync section's chunk (assets/sync-ui-*.js): loaded by src/options/SyncHost.tsx when the section is first shown,
// never by the popup, and not built at all where the release gate keeps the sync user interface out (scripts/sync-ui.mjs).
// Its text is its own catalog (text.ts), loaded here before the section draws.
import "./sync.css";
import { loadSyncText } from "./text";

export { SyncSection, type SyncRail } from "./SyncSection";

/** The section's text, before its first render. Never rejects (text.ts). */
export const prepare = (): Promise<void> => loadSyncText();
