import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Workspace package isn't symlinked in node_modules; alias to source so
      // tests can import from @bot-nation/core-domain without `pnpm install`.
      "@bot-nation/core-domain": fileURLToPath(new URL("../core-domain/src/index.ts", import.meta.url)),
    },
  },
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
