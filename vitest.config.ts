import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The codegraph library loads tree-sitter grammars once per process;
    // running every test file in a single fork keeps that cost low and
    // avoids grammar-load races.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
