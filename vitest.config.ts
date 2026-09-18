import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The codegraph library loads tree-sitter grammars once per process;
    // running every test file in a single fork keeps that cost low and
    // avoids grammar-load races.
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
    // Pin the capture environment (TZ, FORCE_COLOR, COLORTERM) before any
    // test file loads a pi module; see the setup file for why.
    setupFiles: ["tests/screenshots/vitest-setup.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
