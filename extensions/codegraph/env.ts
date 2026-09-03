/**
 * Codegraph library environment defaults.
 *
 * Must be imported BEFORE the codegraph package is imported anywhere, so the
 * variables are set before the library initializes. codegraph phones home for
 * telemetry and for an npm update check at startup; neither is wanted from
 * inside pi. Explicit user settings (inherited from the environment) win.
 */
import shim from "./sqlite-shim.cjs";

if (process.env.CODEGRAPH_TELEMETRY === undefined) {
  process.env.CODEGRAPH_TELEMETRY = "0";
}
if (process.env.CODEGRAPH_NO_UPDATE_CHECK === undefined) {
  process.env.CODEGRAPH_NO_UPDATE_CHECK = "1";
}

// codegraph's "fast init" switches a fresh database to
// `journal_mode = MEMORY` from a second (store-worker) connection while the
// main connection is open. node:sqlite allows that; bun:sqlite returns
// "database is locked" for a journal-mode change while another connection
// holds the file, and codegraph's store worker treats that as fatal. On the
// bun backend, keep the fast build's WAL mode instead (correct, slightly
// more fsync). codegraph's own kill switch; user settings win.
if (shim.backend === "bun:sqlite" && process.env.CODEGRAPH_NO_FAST_INIT === undefined) {
  process.env.CODEGRAPH_NO_FAST_INIT = "1";
}

export {};
