/**
 * Codegraph library environment defaults.
 *
 * Must be imported BEFORE the codegraph library loads anywhere, so the
 * variables are set before the library initializes. codegraph phones home
 * for telemetry and for an npm update check at startup; neither is wanted
 * from inside pi. Explicit user settings (inherited from the environment)
 * win.
 */
if (process.env.CODEGRAPH_TELEMETRY === undefined) {
  process.env.CODEGRAPH_TELEMETRY = "0";
}
if (process.env.CODEGRAPH_NO_UPDATE_CHECK === undefined) {
  process.env.CODEGRAPH_NO_UPDATE_CHECK = "1";
}

// codegraph's "fast init" switches a fresh database to
// `journal_mode = MEMORY` from a second (store-worker) connection while the
// main connection is open. Node's SQLite allows that; bun's SQLite engine
// returns "database is locked" for a journal-mode change while another
// connection holds the file, and codegraph's store worker treats that as
// fatal. The gate is the RUNTIME, not the shim backend: on bun >= 1.4 the
// shim picks node:sqlite (bun provides it), but the engine underneath is
// still bun's. On bun, keep the fast build's WAL mode instead (correct,
// slightly more fsync). codegraph's own kill switch; user settings win.
if (
  process.versions.bun !== undefined &&
  process.env.CODEGRAPH_NO_FAST_INIT === undefined
) {
  process.env.CODEGRAPH_NO_FAST_INIT = "1";
}

export {};
