/**
 * Bun-only shim test: a full codegraph index round trip through the
 * bun:sqlite path.
 *
 * Codegraph's internal `require('node:sqlite')` is patched by
 * scripts/patch-codegraph.mjs to load this repo's shim. With
 * CODEGRAPH_PI_SQLITE_SHIM=bun the shim takes its bun:sqlite branch even on
 * a runtime that also has node:sqlite, so this test proves the exact code
 * path pi (bun) runs: init, index, and query a real codegraph database
 * over bun:sqlite.
 *
 * Run with:  bun test tests/codegraph/shim-bun.test.cts
 */
"use strict";

const { afterAll, beforeAll, describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.CODEGRAPH_PI_SQLITE_SHIM = "bun";
process.env.CODEGRAPH_TELEMETRY = "0";
process.env.CODEGRAPH_NO_UPDATE_CHECK = "1";

const shim = require("../../extensions/codegraph/sqlite-shim.cjs");
const { CodeGraph } = require("@colbymchenry/codegraph");

let dir;
let cg;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-shim-bun-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "src", "lib.js"),
    "export const SHIM_SYMBOL = 'from-bun-sqlite';\nexport function bunOnlyFn() { return SHIM_SYMBOL; }\n",
  );
});

afterAll(() => {
  if (cg) {
    try {
      cg.close();
    } catch {
      // already closed
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("codegraph over the bun:sqlite shim", () => {
  it("runs on the bun:sqlite backend when forced", () => {
    expect(shim.backend).toBe("bun:sqlite");
  });

  it("init, index, and query a real codegraph database", async () => {
    cg = await CodeGraph.init(dir);
    const res = await cg.indexAll();
    expect(res.success).toBe(true);
    expect(res.filesIndexed).toBeGreaterThanOrEqual(1);

    const results = cg.searchNodes("bunOnlyFn");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.name).toBe("bunOnlyFn");

    const stats = cg.getStats();
    expect(stats.fileCount).toBeGreaterThanOrEqual(1);
    cg.close();
    cg = undefined;
  }, 120_000);

  it("backup() copies the indexed database through the serialize path", async () => {
    // The exact seeding copy path pi (bun) uses: open the source db
    // read-only, back it up to a fresh root with the shim's backup (the
    // bun:sqlite serialize + write branch), and prove the copy is a
    // complete, queryable snapshot.
    const copyDir = path.join(dir, "copy");
    fs.mkdirSync(path.join(copyDir, ".codegraph"), { recursive: true });
    const srcPath = path.join(dir, ".codegraph", "codegraph.db");
    const dstPath = path.join(copyDir, ".codegraph", "codegraph.db");
    const src = new shim.DatabaseSync(srcPath, { readOnly: true });
    try {
      await shim.backup(src, dstPath);
    } finally {
      src.close();
    }
    const copy = await CodeGraph.open(copyDir, { sync: false });
    try {
      expect(copy.getStats().fileCount).toBeGreaterThanOrEqual(1);
      const results = copy.searchNodes("bunOnlyFn");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].node.name).toBe("bunOnlyFn");
    } finally {
      copy.close();
    }
  }, 120_000);
});
