/**
 * The codegraph runtime compatibility stack, in one module.
 *
 * "Make codegraph run under pi's runtimes" used to be spread over five
 * files with an invisible load-order rule: the env defaults had to be
 * imported before the codegraph library initialized anywhere, and the
 * only guard was a comment. This module makes the rule structural - the
 * env defaults and the library load happen here, in file order, so a new
 * file cannot load the library without the defaults being set first. No
 * other file loads the library.
 *
 * The sections below are owned in this order (the order is the
 * contract):
 *
 * 1. Env defaults - telemetry silencing, update-check silencing, and the
 *    bun fast-init gate. Explicit user settings win.
 * 2. Library load - the codegraph library through CJS require: the npm
 *    package is a CJS re-export (its entry, `npm-sdk.js`, ends in
 *    `module.exports = require(<platform bundle>/lib/dist/index.js)`),
 *    and Node's ESM loader cannot detect the named exports of that
 *    shape, so `import { CodeGraph } from "@colbymchenry/codegraph"`
 *    fails under plain Node and under tsx ("Named export 'CodeGraph' not
 *    found"). This repo's vitest suite masks the breakage on Node -
 *    which is why the plain-node smoke test exists. CJS require
 *    resolves the same way on every loader pi can run an extension
 *    through (jiti on Node, bun, tsx, vitest), so this module is the
 *    single import point for the library. The load is fail-fast: a
 *    broken or missing package fails the extension import.
 * 3. Shim export - the `node:sqlite` compatibility surface
 *    (sqlite-shim.cjs: real `node:sqlite` on Node, an emulation over
 *    `bun:sqlite` on pi's bun runtime), re-exported here so seed.ts, the
 *    session, and the tests import the shim through one place.
 * 4. Preflight - a once-per-process check of this stack (library,
 *    backend, a functional round trip on a temporary database), run
 *    lazily by the session before the first query so a broken shim
 *    wiring is reported before a real index is at stake.
 * 5. Runtime error classification - this module's failure vocabulary:
 *    the shim's runtime-gap error and the "No such built-in module" text
 *    of an unpatched package's failed require. The session maps such
 *    errors to CodegraphUnavailable with the frozen reason and notifies
 *    once; every other error passes through.
 *
 * Relationship to scripts/patch-codegraph.mjs: the script is the
 * install-time writer - it rewrites the installed package's
 * `require('node:sqlite')` to the shim and bare requires to absolute
 * paths (bun worker threads cannot resolve bare specifiers),
 * idempotently and best-effort. This module is the load-time owner. A
 * package that was never patched fails at the first database open and
 * is classified with the existing fix instruction (run `npm install` in
 * the pi-extensions repo, then restart pi).
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import shim from "./sqlite-shim.cjs";

// --------------------------------------------------------------------
// 1. Env defaults (must run before the library load below; the file
// order is the guarantee)
// --------------------------------------------------------------------

/**
 * Codegraph library environment defaults.
 *
 * Must be set BEFORE the codegraph library initializes. codegraph phones
 * home for telemetry and for an npm update check at startup; neither is
 * wanted from inside pi. Explicit user settings (inherited from the
 * environment) win. Exported so the behavior is testable; the module
 * calls it once at load.
 */
export function applyEnvDefaults(): void {
  if (process.env.CODEGRAPH_TELEMETRY === undefined) {
    process.env.CODEGRAPH_TELEMETRY = "0";
  }
  if (process.env.CODEGRAPH_NO_UPDATE_CHECK === undefined) {
    process.env.CODEGRAPH_NO_UPDATE_CHECK = "1";
  }

  // codegraph's "fast init" switches a fresh database to
  // `journal_mode = MEMORY` from a second (store-worker) connection while
  // the main connection is open. Node's SQLite allows that; bun's SQLite
  // engine returns "database is locked" for a journal-mode change while
  // another connection holds the file, and codegraph's store worker
  // treats that as fatal. The gate is the RUNTIME, not the shim backend:
  // on bun >= 1.4 the shim picks node:sqlite (bun provides it), but the
  // engine underneath is still bun's. On bun, keep the fast build's WAL
  // mode instead (correct, slightly more fsync). codegraph's own kill
  // switch; user settings win.
  if (
    process.versions.bun !== undefined &&
    process.env.CODEGRAPH_NO_FAST_INIT === undefined
  ) {
    process.env.CODEGRAPH_NO_FAST_INIT = "1";
  }
}

applyEnvDefaults();

// --------------------------------------------------------------------
// 2. Library load
// --------------------------------------------------------------------

type CodegraphModule = typeof import("@colbymchenry/codegraph");

const requireModule = createRequire(import.meta.url);
const cg = requireModule("@colbymchenry/codegraph") as CodegraphModule;

/** The CodeGraph instance type (usable in type positions). */
export type CodeGraph = import("@colbymchenry/codegraph").CodeGraph;
/** The CodeGraph class (static init/open/recreate, usable in value positions). */
export const CodeGraph: CodegraphModule["CodeGraph"] = cg.CodeGraph;
export const FileLock = cg.FileLock;
export const findNearestCodeGraphRoot = cg.findNearestCodeGraphRoot;
export const getDatabasePath = cg.getDatabasePath;
export const getCodeGraphDir = cg.getCodeGraphDir;
export const isInitialized = cg.isInitialized;

export type {
  Edge,
  GraphStats,
  IndexProgress,
  Node,
  NodeKind,
  SearchResult,
  Subgraph,
  SyncResult,
} from "@colbymchenry/codegraph";

// --------------------------------------------------------------------
// 3. Shim export
// --------------------------------------------------------------------

/** The active `DatabaseSync`: node:sqlite's, or the bun:sqlite emulation. */
export const DatabaseSync = shim.DatabaseSync;
/** Async DB copy (undefined on Node 22.5-22.15; use `backupFile` there). */
export const backup = shim.backup;
/** Consistent DB copy without the backup API (checkpoint + file copy). */
export const backupFile = shim.backupFile;
/** "node:sqlite" or "bun:sqlite" - which backend is active. */
export const backend = shim.backend;
/** The shim's named-parameter helpers (for tests). */
export const findNamedParams = shim.findNamedParams;
export const mapNamedParams = shim.mapNamedParams;

// --------------------------------------------------------------------
// 4. Preflight
// --------------------------------------------------------------------

export interface PreflightOk {
  ok: true;
  /** The active shim backend ("node:sqlite" or "bun:sqlite"). */
  backend: string;
}

export interface PreflightFail {
  ok: false;
  /** An actionable reason, rendered in the standard unavailable line. */
  reason: string;
}

export type PreflightResult = PreflightOk | PreflightFail;

let cachedResult: PreflightResult | undefined;
let roundTrips = 0;

/**
 * Verify the compatibility stack. Runs once per process, lazily on the
 * session's first use; the result is cached. Checks, in order:
 *  - the library require succeeded. The load above is fail-fast (a broken
 *    package fails the extension import), so this guards the re-exported
 *    surface in case the load is ever made lazy;
 *  - the shim backend is a known value (`node:sqlite` or `bun:sqlite`);
 *  - a functional round trip: open a temporary database through the
 *    shim, run one query, close it. This catches broken shim wiring
 *    before a real index is at stake.
 */
export function preflight(): PreflightResult {
  if (cachedResult !== undefined) return cachedResult;
  cachedResult = runPreflight();
  return cachedResult;
}

/** Test seam: how many temporary database round trips have run. */
export function preflightRoundTripCount(): number {
  return roundTrips;
}

function runPreflight(): PreflightResult {
  if (typeof CodeGraph !== "function") {
    return { ok: false, reason: "the codegraph library did not load" };
  }
  if (backend !== "node:sqlite" && backend !== "bun:sqlite") {
    return { ok: false, reason: `unknown sqlite backend: ${backend}` };
  }
  roundTrips += 1;
  const file = path.join(
    os.tmpdir(),
    `cg-preflight-${process.pid}-${roundTrips}.db`,
  );
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec("CREATE TABLE preflight (v TEXT)");
      db.prepare("INSERT INTO preflight VALUES (?)").run("ok");
      const row = db.prepare("SELECT v FROM preflight").get() as
        | { v?: unknown }
        | undefined;
      if (row?.v !== "ok") {
        throw new Error("round-trip query returned an unexpected row");
      }
    } finally {
      db.close();
    }
    return { ok: true, backend };
  } catch (err) {
    return {
      ok: false,
      reason:
        "sqlite round trip failed: " +
        (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    // Remove the database and any journal sidecars (the journal mode is
    // whatever the backend defaults to).
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        fs.rmSync(file + suffix, { force: true });
      } catch {
        // already gone
      }
    }
  }
}

// --------------------------------------------------------------------
// 5. Runtime error classification
// --------------------------------------------------------------------

/**
 * The runtime-gap failure vocabulary (moved out of session.ts): the
 * shim's runtime-gap error ("codegraph sqlite shim: this runtime has
 * neither node:sqlite nor bun:sqlite") and the failed
 * `require('node:sqlite')` of an unpatched package, which carries Node's
 * "No such built-in module" diagnostic or a message naming node:sqlite.
 * Both texts name node:sqlite or carry that diagnostic, which is what the
 * matcher looks for. The session maps a matching error to
 * CodegraphUnavailable with RUNTIME_SQLITE_REASON and notifies once with
 * RUNTIME_SQLITE_NOTICE under the "runtime-sqlite" key.
 */

/** The one-time session notification for a runtime gap. */
export const RUNTIME_SQLITE_NOTICE =
  "codegraph: this runtime has no node:sqlite (pi bundles bun < 1.4). " +
  "The installed codegraph package is not patched for it. Run " +
  "`npm install` in the pi-extensions repo, then restart pi.";

/** The frozen unavailable reason for a runtime gap. */
export const RUNTIME_SQLITE_REASON =
  "this runtime has no node:sqlite and codegraph is not patched for it (run npm install in the pi-extensions repo, then restart pi)";

/**
 * The frozen unavailable reason when `err` is a runtime-gap error (see
 * above), or undefined when the error is unrelated and must pass through
 * unchanged.
 */
export function runtimeGapReason(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  if (/node:sqlite|No such built-in module/i.test(msg)) {
    return RUNTIME_SQLITE_REASON;
  }
  return undefined;
}
