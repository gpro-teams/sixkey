import { defineConfig } from "vitest/config";

// The live suite (npm run test:live): the sync engine against the real API server, which each file starts for itself
// (test/live/server.ts). One file at a time, with long timeouts: it waits for a real server and real backoffs.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/live/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
