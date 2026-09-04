/**
 * The runtime compatibility stack (extensions/codegraph/runtime.ts).
 *
 * Fast unit tests: no index build. The preflight's temporary database
 * round trip is the only I/O here.
 */
import { describe, expect, it } from "vitest";
import shim from "../../extensions/codegraph/sqlite-shim.cjs";
import {
  applyEnvDefaults,
  backend,
  preflight,
  preflightRoundTripCount,
  runtimeGapReason,
  RUNTIME_SQLITE_NOTICE,
  RUNTIME_SQLITE_REASON,
} from "../../extensions/codegraph/runtime";

/** Save and restore the three codegraph env variables a test mutates. */
function withEnv(fn: () => void): void {
  const names = [
    "CODEGRAPH_TELEMETRY",
    "CODEGRAPH_NO_UPDATE_CHECK",
    "CODEGRAPH_NO_FAST_INIT",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const name of names) saved[name] = process.env[name];
  try {
    fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe("env defaults", () => {
  it("sets the defaults when unset", () => {
    withEnv(() => {
      delete process.env.CODEGRAPH_TELEMETRY;
      delete process.env.CODEGRAPH_NO_UPDATE_CHECK;
      delete process.env.CODEGRAPH_NO_FAST_INIT;
      applyEnvDefaults();
      expect(process.env.CODEGRAPH_TELEMETRY).toBe("0");
      expect(process.env.CODEGRAPH_NO_UPDATE_CHECK).toBe("1");
      // The fast-init gate is on the bun runtime only.
      if (process.versions.bun !== undefined) {
        expect(process.env.CODEGRAPH_NO_FAST_INIT).toBe("1");
      } else {
        expect(process.env.CODEGRAPH_NO_FAST_INIT).toBeUndefined();
      }
    });
  });

  it("preserves user settings", () => {
    withEnv(() => {
      process.env.CODEGRAPH_TELEMETRY = "1";
      process.env.CODEGRAPH_NO_UPDATE_CHECK = "0";
      process.env.CODEGRAPH_NO_FAST_INIT = "0";
      applyEnvDefaults();
      expect(process.env.CODEGRAPH_TELEMETRY).toBe("1");
      expect(process.env.CODEGRAPH_NO_UPDATE_CHECK).toBe("0");
      expect(process.env.CODEGRAPH_NO_FAST_INIT).toBe("0");
    });
  });
});

describe("preflight", () => {
  it("passes on the current runtime and runs the round trip once", () => {
    const first = preflight();
    expect(first.ok).toBe(true);
    if (first.ok) {
      // The temporary database round trip ran through the active shim.
      expect(first.backend).toBe(backend);
    }
    expect(preflightRoundTripCount()).toBe(1);
    // The second call returns the cache: no second round trip.
    const second = preflight();
    expect(second).toBe(first);
    expect(preflightRoundTripCount()).toBe(1);
  });
});

describe("backend", () => {
  it("reports the active shim backend", () => {
    expect(["node:sqlite", "bun:sqlite"]).toContain(backend);
    // The re-export is the shim's own report (one place).
    expect(backend).toBe(shim.backend);
  });
});

describe("runtime error classification", () => {
  it("maps the shim's runtime-gap error to the frozen reason", () => {
    // The shim's own error text for a runtime with neither backend.
    const err = new Error(
      "codegraph sqlite shim: this runtime has neither node:sqlite nor " +
        "bun:sqlite. Open a database only on Node >= 22.5 or bun.",
    );
    expect(runtimeGapReason(err)).toBe(RUNTIME_SQLITE_REASON);
  });

  it("maps the unpatched package's error text to the frozen reason", () => {
    // Node's failed-require diagnostic.
    expect(
      runtimeGapReason(new Error("No such built-in module: node:sqlite")),
    ).toBe(RUNTIME_SQLITE_REASON);
    // Bun's failed-require message names the module.
    expect(
      runtimeGapReason(new Error("Cannot find package 'node:sqlite'")),
    ).toBe(RUNTIME_SQLITE_REASON);
  });

  it("leaves unrelated errors to pass through", () => {
    expect(
      runtimeGapReason(new Error("index build failed: disk full")),
    ).toBeUndefined();
    expect(runtimeGapReason("boom")).toBeUndefined();
    expect(runtimeGapReason(42)).toBeUndefined();
    expect(runtimeGapReason(undefined)).toBeUndefined();
  });

  it("carries the frozen user-facing strings", () => {
    // The notification and the unavailable reason are frozen byte for
    // byte (spec 0002 behavior freeze).
    expect(RUNTIME_SQLITE_NOTICE).toBe(
      "codegraph: this runtime has no node:sqlite (pi bundles bun < 1.4). " +
        "The installed codegraph package is not patched for it. Run " +
        "`npm install` in the pi-extensions repo, then restart pi.",
    );
    expect(RUNTIME_SQLITE_REASON).toBe(
      "this runtime has no node:sqlite and codegraph is not patched for it (run npm install in the pi-extensions repo, then restart pi)",
    );
  });
});
