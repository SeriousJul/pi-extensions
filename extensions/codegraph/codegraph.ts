/**
 * The codegraph library, loaded through CJS require.
 *
 * The npm package is a CJS re-export: its entry (`npm-sdk.js`) ends in
 * `module.exports = require(<platform bundle>/lib/dist/index.js)`. Node's
 * ESM loader cannot detect the named exports of that shape, so
 * `import { CodeGraph } from "@colbymchenry/codegraph"` fails under plain
 * Node and under tsx ("Named export 'CodeGraph' not found"). pi loads
 * extensions on Node (npm install mode, tsx from source) and inside its
 * Bun binary, and this repo's vitest suite masks the breakage on Node -
 * which is why the plain-node smoke test exists. CJS require resolves the
 * same way on every loader pi can run an extension through (jiti on Node,
 * bun, tsx, vitest), so this module is the single import point for the
 * library: no other file imports "@colbymchenry/codegraph" at runtime.
 *
 * `./env` is imported first so the telemetry, update-check, and fast-init
 * environment defaults are set before the library initializes.
 */
import "./env";
import { createRequire } from "node:module";

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
