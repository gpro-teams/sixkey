import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PBKDF2 at 600k iterations runs inside loops (enable-crash); the 5 s default flakes under load.
    testTimeout: 30_000,
    include: ["test/unit/**/*.test.ts", "test/fault/**/*.test.ts", "test/regression/**/*.test.ts"],
  },
});
