/**
 * Index adapter: the single seam over the codegraph library (spec 0003).
 *
 * This module is the only module that names the library's instance API,
 * its types, or its schema. The session's state machine and the renderers
 * call a small set of operations (IndexAdapterOps) and never see the
 * library's shape, so a library bump or an upstream schema change touches
 * this one module.
 *
 * Two implementations sit at this seam:
 *  - RealIndexAdapter (this file): the real library behind a thin
 *    delegation. Instances come from the runtime module (spec 0002); this
 *    file never loads the library itself.
 *  - an in-memory test adapter (tests/codegraph/inMemoryIndex.ts): plain
 *    data at the same seam, so the state machine is testable in
 *    milliseconds without the native library.
 *
 * The library's static helpers (directory layout, the initialization
 * check, the nearest-root lookup) are exposed through the factory; the
 * per-root lifecycle and query operations are exposed on the adapter.
 *
 * Known lie (deliberate, documented): `IndexAdapter` intersects the
 * library's `CodeGraph` type with the operations below. The intersection
 * exists so the frozen integration test (tests/codegraph/session.test.ts,
 * which passes an adapter to a function typed as the library class) keeps
 * compiling byte-identical. Extension code must use only the members of
 * `IndexAdapterOps`; everything else on the type is not implemented by
 * the adapters and must not be called.
 */
import fs from "node:fs";
import path from "node:path";
import {
  backup,
  backupFile,
  CodeGraph,
  DatabaseSync,
  FileLock,
  findNearestCodeGraphRoot,
  getDatabasePath,
  getCodeGraphDir,
  isInitialized,
  preflight,
  runtimeGapReason,
  RUNTIME_SQLITE_NOTICE,
} from "./runtime";
import { syncWithRetry } from "./sync-retry";
import type {
  CodeGraph as CodeGraphType,
  Edge,
  EdgeKind,
  FileRecord,
  FindRelevantContextOptions,
  GraphStats,
  IndexProgress,
  IndexResult,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  Subgraph,
  SyncResult,
} from "@colbymchenry/codegraph";
import type { PreflightResult } from "./runtime";

// The library types the rest of the extension names. They are re-exported
// from this module so that nothing outside it (and the runtime module)
// names the package.
export type {
  Edge,
  EdgeKind,
  FileRecord,
  FindRelevantContextOptions,
  GraphStats,
  IndexProgress,
  IndexResult,
  Language,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  Subgraph,
  SyncResult,
} from "@colbymchenry/codegraph";
export type { PreflightResult } from "./runtime";

/**
 * The per-root operations the extension uses. Every member has the
 * library's own behavior; the adapters implement them, and the frozen
 * integration test verifies the real one against the library itself.
 */
export interface IndexAdapterOps {
  /** The index directory for this root (`<root>/.codegraph`). */
  codeGraphDir(): string;
  /** The on-disk database path (`<root>/.codegraph/codegraph.db`). */
  databasePath(): string;
  /** The project root the open instance reports. */
  getProjectRoot(): string;
  /** The index directory AND the database exist on disk. */
  initialized(): boolean;
  /** The database file exists on disk (checked live, not from memory). */
  databaseExists(): boolean;

  /** Acquire the per-root lock. Throws if another live process holds it. */
  acquireLock(): void;
  releaseLock(): void;
  /** Create an empty index through the library's own directory setup. */
  createEmpty(): Promise<void>;
  /** Recreate the index directory from scratch. The adapter holds the open instance. */
  recreate(): Promise<void>;
  /** Open the existing index. The adapter holds the open instance. */
  open(): Promise<void>;
  close(): void;
  /** A full build. */
  indexAll(options?: AdapterIndexOptions): Promise<IndexResult>;
  /**
   * A reconciliation. Runs the lock-contention contract (see
   * sync-retry.ts) internally; a returned result with filesChecked === 0
   * is the "lock could not be acquired" signal.
   */
  sync(): Promise<SyncResult>;
  /** Start the file watcher. Returns false when it could not start. */
  watch(options: AdapterWatchOptions): boolean;
  getWatcherDegradedReason(): string | null;
  /** Reopen when the database file was replaced (seed/rebuild). */
  reopenIfReplaced(): boolean;
  /** Copy a sibling's index into this root's fresh index directory. */
  seedFrom(sourceRoot: string): Promise<void>;

  /** The live query surface. */
  getStats(): GraphStats;
  getIndexState(): string | null;
  /**
   * The on-disk counts and state, read straight from the database file
   * with the runtime's DatabaseSync and the schema known to this module.
   * Undefined when the file is absent or unreadable.
   */
  diskStats(): DiskStats | undefined;
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  getNodesByName(name: string): Node[];
  getFiles(): FileRecord[];
  getNodesInFile(filePath: string): Node[];
  getFile(filePath: string): FileRecord | null;
  getFileDependents(filePath: string): string[];
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: Node; edge: Edge }>;
  getCallees(nodeId: string, maxDepth?: number): Array<{ node: Node; edge: Edge }>;
  getImpactRadius(nodeId: string, maxDepth?: number): Subgraph;
  findRelevantContext(query: string, options?: FindRelevantContextOptions): Promise<Subgraph>;
}

/** The adapter type the rest of the extension sees (see the header). */
export type IndexAdapter = CodeGraphType & IndexAdapterOps;

/**
 * The build options the session passes. Structurally a subset of the
 * library's, so both adapters can hand it straight through.
 */
export interface AdapterIndexOptions {
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * The watcher options the session passes. Structurally a subset of the
 * library's, so both adapters can hand it straight through.
 */
export interface AdapterWatchOptions {
  debounceMs: number;
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;
  onSyncError?: (error: Error) => void;
  onDegraded?: (reason: string) => void;
}

/** The on-disk index shape: the counts plus the build state string. */
export interface DiskStats {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  indexState: string | null;
}

/** The runtime-gap classification result (spec 0002's reasons, owned here). */
export interface RuntimeGapInfo {
  /** The frozen unavailable reason. */
  reason: string;
  /** The one-time notification text. */
  notice: string;
}

/**
 * The per-root factory. Factories cache one adapter per root: an adapter
 * holds the open instance, so two adapters for one root would desync.
 */
export interface IndexAdapterFactory {
  /** The adapter for `root` (the same instance on every call). */
  create(root: string): IndexAdapter;
  /** The nearest initialized ancestor of `startPath`, or null. */
  findNearestRoot(startPath: string): string | null;
  /** The runtime compatibility check (spec 0002). */
  preflight(): PreflightResult;
  /** The runtime-gap classification, or undefined when unrelated. */
  runtimeGap(err: unknown): RuntimeGapInfo | undefined;
}

// ---------------------------------------------------------------------------
// The on-disk read
// ---------------------------------------------------------------------------

const INDEX_STATES = ["indexing", "complete", "partial", "failed"] as const;

/**
 * Read the index counts and state straight from the index database,
 * without opening a CodeGraph instance. Used by /codegraph status when the
 * index exists on disk but the session has not opened it yet. The counts
 * mirror CodeGraph.getStats() (the same table counts). Returns undefined
 * when the database cannot be read.
 *
 * Known coupling: the query names codegraph's schema directly (files,
 * nodes, edges, project_metadata). An upstream schema change breaks the
 * counts until this query is updated; the failure is graceful (status
 * falls back to "counts unavailable"), never a crash. This module is the
 * single place that names the schema (spec 0003). Re-check this query
 * when the pinned codegraph version is bumped.
 */
function readDiskStats(root: string): DiskStats | undefined {
  if (!isInitialized(root)) return undefined;
  const db = new DatabaseSync(getDatabasePath(root), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM files) AS file_count, " +
          "(SELECT COUNT(*) FROM nodes) AS node_count, " +
          "(SELECT COUNT(*) FROM edges) AS edge_count, " +
          "(SELECT value FROM project_metadata WHERE key = 'index_state') AS index_state",
      )
      .get() as
      | {
          file_count: number;
          node_count: number;
          edge_count: number;
          index_state: string | null | undefined;
        }
      | undefined;
    if (!row) return undefined;
    const state = row.index_state;
    return {
      fileCount: Number(row.file_count),
      nodeCount: Number(row.node_count),
      edgeCount: Number(row.edge_count),
      indexState:
        typeof state === "string" &&
        (INDEX_STATES as readonly string[]).includes(state)
          ? state
          : null,
    };
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The real adapter
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The real library behind the seam. One delegation per operation; the
 * lifecycle operations leave the instance held on the adapter (open /
 * recreate), so the session can build on the instance it just created.
 */
class RealIndexAdapter implements IndexAdapterOps {
  private instance: CodeGraphType | undefined;
  private lock: InstanceType<typeof FileLock> | undefined;

  constructor(private readonly root: string) {}

  private inst(): CodeGraphType {
    if (!this.instance) {
      throw new Error(`codegraph index is not open at ${this.root}`);
    }
    return this.instance;
  }

  codeGraphDir(): string {
    return getCodeGraphDir(this.root);
  }
  databasePath(): string {
    return getDatabasePath(this.root);
  }
  getProjectRoot(): string {
    return this.inst().getProjectRoot();
  }
  initialized(): boolean {
    return isInitialized(this.root);
  }
  databaseExists(): boolean {
    return fs.existsSync(this.databasePath());
  }

  acquireLock(): void {
    // The lock file lives in the index directory, which must exist first.
    fs.mkdirSync(this.codeGraphDir(), { recursive: true });
    this.lock = new FileLock(path.join(this.codeGraphDir(), "codegraph.lock"));
    this.lock.acquire();
  }
  releaseLock(): void {
    try {
      this.lock?.release();
    } finally {
      this.lock = undefined;
    }
  }

  async createEmpty(): Promise<void> {
    const created = await CodeGraph.init(this.root);
    created.close();
  }
  async recreate(): Promise<void> {
    this.instance = await CodeGraph.recreate(this.root);
  }
  async open(): Promise<void> {
    this.instance = await CodeGraph.open(this.root, { sync: false });
  }
  close(): void {
    try {
      this.instance?.close();
    } catch {
      // already closed
    }
    this.instance = undefined;
  }

  indexAll(options?: AdapterIndexOptions): Promise<IndexResult> {
    return this.inst().indexAll(options);
  }
  sync(): Promise<SyncResult> {
    return syncWithRetry(() => this.inst().sync(), sleep);
  }
  watch(options: AdapterWatchOptions): boolean {
    return this.inst().watch(options);
  }
  getWatcherDegradedReason(): string | null {
    return this.inst().getWatcherDegradedReason();
  }
  reopenIfReplaced(): boolean {
    return this.inst().reopenIfReplaced();
  }

  async seedFrom(sourceRoot: string): Promise<void> {
    // Copy the sibling's index DB over this root's index DB as a
    // consistent snapshot (online backup where the node:sqlite backup API
    // exists, serialize+write on bun, checkpoint+file copy on
    // Node 22.5-22.15 - see sqlite-shim.cjs). The destination's existing
    // db file and WAL sidecars are removed first, so the destination ends
    // as exactly the source's snapshot. Re-opened on next open().
    const srcPath = getDatabasePath(sourceRoot);
    const dstPath = this.databasePath();
    fs.mkdirSync(this.codeGraphDir(), { recursive: true });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(dstPath + suffix, { force: true });
    }
    const src = new DatabaseSync(srcPath, { readOnly: true });
    try {
      if (backup) {
        await backup(src, dstPath);
      } else {
        // Node 22.5-22.15: no node:sqlite backup API. The checkpoint +
        // file copy fallback yields a consistent snapshot at the
        // checkpoint moment.
        await backupFile(srcPath, dstPath);
      }
    } finally {
      src.close();
    }
  }

  getStats(): GraphStats {
    return this.inst().getStats();
  }
  getIndexState(): string | null {
    return this.inst().getIndexState();
  }
  diskStats(): DiskStats | undefined {
    return readDiskStats(this.root);
  }

  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.inst().searchNodes(query, options);
  }
  getNodesByName(name: string): Node[] {
    return this.inst().getNodesByName(name);
  }
  getFiles(): FileRecord[] {
    return this.inst().getFiles();
  }
  getNodesInFile(filePath: string): Node[] {
    return this.inst().getNodesInFile(filePath);
  }
  getFile(filePath: string): FileRecord | null {
    return this.inst().getFile(filePath);
  }
  getFileDependents(filePath: string): string[] {
    return this.inst().getFileDependents(filePath);
  }
  getCallers(nodeId: string, maxDepth?: number): Array<{ node: Node; edge: Edge }> {
    return this.inst().getCallers(nodeId, maxDepth);
  }
  getCallees(nodeId: string, maxDepth?: number): Array<{ node: Node; edge: Edge }> {
    return this.inst().getCallees(nodeId, maxDepth);
  }
  getImpactRadius(nodeId: string, maxDepth?: number): Subgraph {
    return this.inst().getImpactRadius(nodeId, maxDepth);
  }
  findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions,
  ): Promise<Subgraph> {
    return this.inst().findRelevantContext(query, options);
  }
}

// ---------------------------------------------------------------------------
// The real factory
// ---------------------------------------------------------------------------

export const realIndexFactory: IndexAdapterFactory = (() => {
  const adapters = new Map<string, RealIndexAdapter>();
  return {
    create(root: string): IndexAdapter {
      let adapter = adapters.get(root);
      if (!adapter) {
        adapter = new RealIndexAdapter(root);
        adapters.set(root, adapter);
      }
      // The single documented cast: RealIndexAdapter implements the ops;
      // the CodeGraph half of the intersection type is the shim that keeps
      // the frozen integration test compiling (see the header).
      return adapter as unknown as IndexAdapter;
    },
    findNearestRoot(startPath: string): string | null {
      return findNearestCodeGraphRoot(startPath);
    },
    preflight(): PreflightResult {
      return preflight();
    },
    runtimeGap(err: unknown): RuntimeGapInfo | undefined {
      const reason = runtimeGapReason(err);
      if (reason === undefined) return undefined;
      return { reason, notice: RUNTIME_SQLITE_NOTICE };
    },
  };
})();

