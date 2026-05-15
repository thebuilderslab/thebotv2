import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Workers globals (crypto.randomUUID, etc.) are present in Node 20+, sufficient for
    // pure-function tests like chain-match. Tests that need D1/DO bindings should be
    // integration tests under a separate config in a future PR.
    globals: false,
    reporters: ["default"],
  },
});
