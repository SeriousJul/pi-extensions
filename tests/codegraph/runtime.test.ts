/**
 * The runtime compatibility stack (extensions/codegraph/runtime.ts).
 *
 * Fast unit tests: no index build. The preflight's temporary database
 * round trip is the only I/O here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import shim from "../../extensions/codegraph/sqlite-shim.cjs";
import {
  applyEnvDefaults,
  backend,
  isResolutionFailure,
  preflight,
  preflightRoundTripCount,
  resolveCodegraphEntryFile,
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

describe("resolution failure classification", () => {
  it("matches Node's MODULE_NOT_FOUND by code", () => {
    const err = new Error("Cannot find module 'whatever'");
    (err as NodeJS.ErrnoException).code = "MODULE_NOT_FOUND";
    expect(isResolutionFailure(err)).toBe(true);
  });

  it("matches Bun's ResolveMessage by message (it carries no code)", () => {
    expect(
      isResolutionFailure(new Error("Cannot find module '@x/y'")),
    ).toBe(true);
    expect(
      isResolutionFailure(
        new Error("Cannot find package 'htmlparser2' from '/a/b'"),
      ),
    ).toBe(true);
  });

  it("leaves loaded-entry errors to pass through", () => {
    // The package's own actionable error when the platform bundle is
    // missing is not a resolution failure.
    expect(
      isResolutionFailure(
        new Error(
          "codegraph: the programmatic API is unavailable because the " +
            "platform bundle (x) is not installed.",
        ),
      ),
    ).toBe(false);
    expect(isResolutionFailure(new Error("boom"))).toBe(false);
    expect(isResolutionFailure("boom")).toBe(false);
    expect(isResolutionFailure(42)).toBe(false);
    expect(isResolutionFailure(null)).toBe(false);
    expect(isResolutionFailure(undefined)).toBe(false);
  });
});

/** The repo root, relative to this test file. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("package entry walk (compiled-bun fallback)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Plant a fake @colbymchenry/codegraph under root and return its dir. */
  function plantPackage(manifest: Record<string, unknown>, files: string[]): string {
    const pkgDir = path.join(root, "node_modules", "@colbymchenry", "codegraph");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify(manifest),
    );
    for (const file of files) {
      fs.writeFileSync(path.join(pkgDir, file), "module.exports = {};\n");
    }
    return pkgDir;
  }

  it("finds the installed package from the extension directory", () => {
    const entry = resolveCodegraphEntryFile(
      path.join(REPO_ROOT, "extensions", "codegraph"),
    );
    expect(entry).toBe(
      path.join(
        REPO_ROOT,
        "node_modules",
        "@colbymchenry",
        "codegraph",
        "npm-sdk.js",
      ),
    );
    expect(fs.statSync(entry).isFile()).toBe(true);
  });

  it("walks up through nested directories", () => {
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    const pkgDir = plantPackage({ exports: { ".": "./sdk.js" } }, ["sdk.js"]);
    expect(resolveCodegraphEntryFile(deep)).toBe(path.join(pkgDir, "sdk.js"));
  });

  it("reads the entry from the manifest, preferring require over default", () => {
    const pkgDir = plantPackage(
      {
        exports: { ".": { require: "./rq.js", default: "./df.js" } },
        main: "./mn.js",
      },
      ["rq.js", "df.js", "mn.js", "index.js"],
    );
    expect(resolveCodegraphEntryFile(root)).toBe(path.join(pkgDir, "rq.js"));
  });

  it("falls back to default, then main, then index.js", () => {
    const pkgDir = plantPackage(
      { exports: { ".": { default: "./df.js" } }, main: "./mn.js" },
      ["df.js", "mn.js", "index.js"],
    );
    expect(resolveCodegraphEntryFile(root)).toBe(path.join(pkgDir, "df.js"));

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ main: "./mn.js" }),
    );
    expect(resolveCodegraphEntryFile(root)).toBe(path.join(pkgDir, "mn.js"));

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@colbymchenry/codegraph" }),
    );
    expect(resolveCodegraphEntryFile(root)).toBe(path.join(pkgDir, "index.js"));
  });

  it("throws an actionable error when the package is absent", () => {
    expect(() => resolveCodegraphEntryFile(root)).toThrowError(
      /not installed in any node_modules/,
    );
  });

  it("keeps walking when a planted package has no entry file", () => {
    plantPackage({ exports: { ".": "./missing.js" } }, []);
    expect(() => resolveCodegraphEntryFile(root)).toThrowError(
      /not installed in any node_modules/,
    );
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
