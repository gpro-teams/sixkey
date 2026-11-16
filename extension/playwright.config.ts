import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  testMatch: /(e2e|regression)\/.*\.spec\.ts$/,
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
