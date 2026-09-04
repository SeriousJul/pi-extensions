/**
 * Bun-only runtime module test: with CODEGRAPH_PI_SQLITE_SHIM=bun the
 * runtime module reports the bun:sqlite backend, and the preflight's
 * round trip passes on it.
 *
 * CODEGRAPH_PI_SQLITE_SHIM is read when the shim loads, so it is set
 * before the runtime module is required.
 *
 * Run with:  bun test tests/codegraph/runtime-bun.test.cts
 */
"use strict";

const { describe, expect, it } = require("bun:test");

process.env.CODEGRAPH_PI_SQLITE_SHIM = "bun";

const runtime = require("../../extensions/codegraph/runtime.ts");

describe("runtime module on the forced bun:sqlite backend", () => {
  it("reports the bun:sqlite backend", () => {
    expect(runtime.backend).toBe("bun:sqlite");
  });

  it("preflight passes on the bun:sqlite backend", () => {
    const res = runtime.preflight();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.backend).toBe("bun:sqlite");
    }
  });
});
