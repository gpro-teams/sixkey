import { defineConfig } from "@playwright/test";

// The extension in Chromium against the real API server (npm run e2e:sync; docs/design/notes/M5-NOTES.md). Each file starts its own
// server and database (test/live/server.ts) and serves the e2e build's API origin, 127.0.0.1:8787, so one test at a time.
export default defineConfig({
  testDir: "test/sync",
  testMatch: /\.spec\.ts$/,
  timeout: 180_000,
  workers: 1,
  reporter: "list",
});
