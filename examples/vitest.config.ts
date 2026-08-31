import { defineConfig } from "vitest/config";

/**
 * Vitest config for the consumer examples (CONS-01 offline proof).
 * Node env, globals off (explicit imports), only the examples test files.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
