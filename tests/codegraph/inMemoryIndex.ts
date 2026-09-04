/**
 * The in-memory Index adapter (spec 0003, the second implementation at the
 * seam).
 *
 * Plain data where the real adapter has a database: no native library, no
 * on-disk index. The session's state machine is testable in milliseconds.
 *
 * The factory and adapters are typed through the seam's types only
 * (type-only imports of indexAdapter.ts, erased at runtime), and the
 * reconcile retry comes from sync-retry.ts (library-free): this module
 * never loads the codegraph library.
 *
 * The adapters honor the real adapter's documented contracts:
 *  - reconcile lock contention: a configured zero-checked-files result
 *    runs the shared syncWithRetry ramp before the session sees it;
 *  - one adapter instance per root per factory (the factory caches), so
 *    state (open/closed, counters) is consistent across the session's
 *    calls;
 *  - an index "exists" (initialized) when its directory AND database
 *    exist in the store.
 *
 * The store is the test's control panel: per-root knobs steer the
 * behavior, per-root state records what happened.
 */
import fs from "node:fs";
import path from "node:path";
import { syncWithRetry } from "../../extensions/codegraph/sync-retry";
import type {
  AdapterIndexOptions,
  AdapterWatchOptions,
  DiskStats,
  IndexAdapter,
  IndexAdapterOps,
  IndexAdapterFactory,
  PreflightResult,
  RuntimeGapInfo,
} from "../../extensions/codegraph/indexAdapter";
import type {
  Edge,
  FileRecord,
  GraphStats,
  IndexResult,
  Node,
  SearchOptions,
  SearchResult,
  Subgraph,
  SyncResult,
} from "../../extensions/codegraph/indexAdapter";

/**
 * The in-memory index directory name. Deliberately different from the
 * real library's, so an in-memory index in a tree never collides with a
 * real one.
 */
export const IN_MEMORY_DIR_NAME = "codegraph-mem";

/** One root's knobs and state. Knobs steer, state records. */
export interface InMemoryRoot {
  // -- knobs (test configuration) ------------------------------------
  /**
   * The result every sync attempt returns. When unset, a no-change walk
   * over the indexed files (filesChecked = files.length). Set a result
   * with filesChecked: 0 to model a held lock.
   */
  syncResult?: SyncResult;
  /** The build outcome. When unset, the build succeeds. */
  buildOutcome?: { success: false; error?: string };
  /** The watcher start outcome. Default: "active". */
  watchMode: "active" | "degraded" | "throw";
  /** The reason for "degraded" (and the message for "throw"). */
  watchReason?: string;
  /** Whether reopenIfReplaced reports a replaced database. Default: false. */
  reopenReplaced: boolean;
  /**
   * Whether the nearest-root lookup reports this root. Default: true. Set
   * false to model an index that appears after the lookup (the TOCTOU
   * between resolution and preparation).
   */
  findable: boolean;
  /** Whether the per-root lock is held by another process. Default: false. */
  lockHeld: boolean;
  /** Whether the on-disk read reports the database unreadable. */
  unreadableDb: boolean;

  // -- state (what the adapters maintain) ------------------------------
  dirExists: boolean;
  dbExists: boolean;
  open: boolean;
  indexState: string | null;
  files: FileRecord[];
  nodes: Node[];
  edges: Edge[];
  /** Set when seedFrom copied a sibling's data here. */
  seededFrom?: string;
  buildCount: number;
  syncCount: number;
  watchOptions?: AdapterWatchOptions;

  /** Index a file with one node per line that declares an export. */
  addFile(
    relPath: string,
    opts?: { size?: number; exports?: string[] },
  ): void;
}

function makeRoot(): InMemoryRoot {
  const root: InMemoryRoot = {
    watchMode: "active",
    reopenReplaced: false,
    findable: true,
    lockHeld: false,
    unreadableDb: false,
    dirExists: false,
    dbExists: false,
    open: false,
    indexState: null,
    files: [],
    nodes: [],
    edges: [],
    buildCount: 0,
    syncCount: 0,
    addFile(relPath, opts = {}) {
      const now = Date.now();
      root.files.push({
        path: relPath,
        contentHash: "mem",
        language: "typescript",
        size: opts.size ?? 100,
        modifiedAt: now,
        indexedAt: now,
        nodeCount: 0,
      });
      for (const name of opts.exports ?? []) {
        const node: Node = {
          id: `${relPath}\0${name}`,
          kind: "function",
          name,
          qualifiedName: name,
          filePath: relPath,
          language: "typescript",
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: now,
        };
        root.nodes.push(node);
        root.files[root.files.length - 1].nodeCount = root.files[
          root.files.length - 1
        ].nodeCount + 1;
      }
    },
  };
  return root;
}

/** The test's control panel: one entry per root. */
export class InMemoryIndex {
  readonly roots = new Map<string, InMemoryRoot>();

  /** The entry for `rootPath` (created on first access). */
  root(rootPath: string): InMemoryRoot {
    let r = this.roots.get(rootPath);
    if (!r) {
      r = makeRoot();
      this.roots.set(rootPath, r);
    }
    return r;
  }

  /**
   * The nearest root whose index exists and is findable, walking up from
   * `startPath` (mirrors the real nearest-root lookup).
   */
  nearestInitialized(startPath: string): string | null {
    let cur = path.resolve(startPath);
    for (;;) {
      const r = this.roots.get(cur);
      if (r && r.findable && r.dirExists && r.dbExists) return cur;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

const INDEXABLE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Scan a directory tree for indexable files (relative paths). */
function scanFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name === IN_MEMORY_DIR_NAME) continue;
      out.push(...scanFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && INDEXABLE.has(path.extname(entry.name))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * The in-memory adapter for one root. Implements the seam's operations
 * over the store; the CodeGraph half of the IndexAdapter type is not
 * implemented (see indexAdapter.ts).
 */
class InMemoryIndexAdapter implements IndexAdapterOps {
  constructor(
    private readonly rootPath: string,
    private readonly store: InMemoryIndex,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  private get r(): InMemoryRoot {
    return this.store.root(this.rootPath);
  }

  codeGraphDir(): string {
    return path.join(this.rootPath, IN_MEMORY_DIR_NAME);
  }
  databasePath(): string {
    return path.join(this.codeGraphDir(), "index.db");
  }
  getProjectRoot(): string {
    return this.rootPath;
  }
  initialized(): boolean {
    return this.r.dirExists && this.r.dbExists;
  }
  databaseExists(): boolean {
    return this.r.dbExists;
  }

  acquireLock(): void {
    if (this.r.lockHeld) {
      throw new Error(`codegraph lock is held at ${this.rootPath}`);
    }
    // The marker and meta files live in the index directory.
    fs.mkdirSync(this.codeGraphDir(), { recursive: true });
    this.r.dirExists = true;
  }
  releaseLock(): void {
    // nothing to release in memory
  }

  async createEmpty(): Promise<void> {
    this.r.dirExists = true;
    this.r.dbExists = true;
    this.r.indexState = null;
    this.r.open = false;
  }
  async recreate(): Promise<void> {
    this.r.dirExists = true;
    this.r.dbExists = true;
    this.r.indexState = null;
    this.r.files = [];
    this.r.nodes = [];
    this.r.edges = [];
    this.r.seededFrom = undefined;
    this.r.open = true;
  }
  async open(): Promise<void> {
    if (!this.initialized()) {
      throw new Error(`no codegraph index at ${this.rootPath}`);
    }
    this.r.open = true;
  }
  close(): void {
    this.r.open = false;
  }

  async indexAll(options?: AdapterIndexOptions): Promise<IndexResult> {
    const r = this.r;
    r.buildCount += 1;
    options?.onProgress?.({ phase: "scanning", current: 0, total: 1 });
    if (r.buildOutcome && !r.buildOutcome.success) {
      r.indexState = "failed";
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [
          { message: r.buildOutcome.error ?? "index build failed", severity: "error" },
        ],
        durationMs: 1,
      };
    }
    const now = Date.now();
    r.files = [];
    r.nodes = [];
    r.edges = [];
    r.seededFrom = undefined;
    for (const rel of scanFiles(this.rootPath)) {
      r.addFile(rel);
      const node: Node = {
        id: `${rel}\0file`,
        kind: "file",
        name: path.basename(rel),
        qualifiedName: rel,
        filePath: rel,
        language: "typescript",
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: now,
      };
      r.nodes.push(node);
      r.files[r.files.length - 1].nodeCount = 1;
    }
    r.indexState = "complete";
    return {
      success: true,
      filesIndexed: r.files.length,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: r.nodes.length,
      edgesCreated: 0,
      errors: [],
      durationMs: 1,
    };
  }

  async sync(): Promise<SyncResult> {
    const r = this.r;
    const base: SyncResult =
      r.syncResult ??
      {
        filesChecked: r.files.length,
        filesAdded: 0,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 1,
      };
    return syncWithRetry(
      () => {
        r.syncCount += 1;
        return Promise.resolve(base);
      },
      this.sleep,
    );
  }

  watch(options: AdapterWatchOptions): boolean {
    const r = this.r;
    r.watchOptions = options;
    if (r.watchMode === "throw") {
      throw new Error(r.watchReason ?? "in-memory watch failure");
    }
    return r.watchMode === "active";
  }
  getWatcherDegradedReason(): string | null {
    return this.r.watchMode === "degraded"
      ? this.r.watchReason ?? "in-memory degradation"
      : null;
  }
  reopenIfReplaced(): boolean {
    return this.r.reopenReplaced;
  }

  async seedFrom(sourceRoot: string): Promise<void> {
    const src = this.store.root(sourceRoot);
    const r = this.r;
    r.files = src.files.map((f) => ({ ...f }));
    r.nodes = src.nodes.map((n) => ({ ...n }));
    r.edges = src.edges.map((e) => ({ ...e }));
    r.seededFrom = sourceRoot;
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
  }

  getStats(): GraphStats {
    const r = this.r;
    return {
      nodeCount: r.nodes.length,
      edgeCount: r.edges.length,
      fileCount: r.files.length,
      nodesByKind: {} as GraphStats["nodesByKind"],
      edgesByKind: {} as GraphStats["edgesByKind"],
      filesByLanguage: {} as GraphStats["filesByLanguage"],
      dbSizeBytes: 0,
      walSizeBytes: 0,
      lastUpdated: Date.now(),
    };
  }
  getIndexState(): string | null {
    return this.r.indexState;
  }
  diskStats(): DiskStats | undefined {
    const r = this.r;
    if (!r.dirExists || !r.dbExists || r.unreadableDb) return undefined;
    return {
      fileCount: r.files.length,
      nodeCount: r.nodes.length,
      edgeCount: r.edges.length,
      indexState: r.indexState,
    };
  }

  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    const q = query.toLowerCase();
    const matches = this.r.nodes
      .filter((n) => n.name.toLowerCase().includes(q))
      .filter((n) => !options?.kinds || options.kinds.includes(n.kind));
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 10;
    return matches.slice(offset, offset + limit).map((node) => ({ node, score: 1 }));
  }
  getNodesByName(name: string): Node[] {
    return this.r.nodes.filter((n) => n.name === name);
  }
  getFiles(): FileRecord[] {
    return [...this.r.files];
  }
  getNodesInFile(filePath: string): Node[] {
    return this.r.nodes.filter((n) => n.filePath === filePath);
  }
  getFile(filePath: string): FileRecord | null {
    return this.r.files.find((f) => f.path === filePath) ?? null;
  }
  getFileDependents(filePath: string): string[] {
    void filePath;
    return [];
  }
  getCallers(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const byId = new Map(this.r.nodes.map((n) => [n.id, n]));
    return this.r.edges
      .filter((e) => e.target === nodeId && byId.has(e.source))
      .map((e) => ({ node: byId.get(e.source)!, edge: e }));
  }
  getCallees(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const byId = new Map(this.r.nodes.map((n) => [n.id, n]));
    return this.r.edges
      .filter((e) => e.source === nodeId && byId.has(e.target))
      .map((e) => ({ node: byId.get(e.target)!, edge: e }));
  }
  getImpactRadius(nodeId: string): Subgraph {
    const byId = new Map(this.r.nodes.map((n) => [n.id, n]));
    const nodes = new Map<string, Node>();
    if (byId.has(nodeId)) nodes.set(nodeId, byId.get(nodeId)!);
    return { nodes, edges: [], roots: nodeId in nodes ? [nodeId] : [] };
  }
  async findRelevantContext(query: string): Promise<Subgraph> {
    const q = query.toLowerCase();
    const nodes = new Map<string, Node>();
    for (const n of this.r.nodes) {
      if (n.name.toLowerCase().includes(q)) nodes.set(n.id, n);
    }
    return { nodes, edges: [], roots: [...nodes.keys()] };
  }
}

export interface InMemoryFactoryOptions {
  /** Share one store across factories (the default is a fresh store). */
  store?: InMemoryIndex;
  /** The delay between reconcile retries in ms. Default: 0 (instant). */
  sleepMs?: number;
  /** The preflight result. Default: ok. */
  preflightResult?: PreflightResult;
  /** Map an error to a runtime-gap reason. Default: no gaps. */
  gapMatcher?: (err: unknown) => string | undefined;
}

/**
 * The in-memory factory. Like the real factory, it caches one adapter per
 * root: the session may create the same root's adapter many times and must
 * always get the same instance.
 */
export function createInMemoryIndexFactory(
  opts: InMemoryFactoryOptions = {},
): IndexAdapterFactory & { store: InMemoryIndex } {
  const store = opts.store ?? new InMemoryIndex();
  const sleep = (ms: number): Promise<void> =>
    opts.sleepMs ? new Promise((r) => setTimeout(r, opts.sleepMs)) : Promise.resolve();
  const adapters = new Map<string, InMemoryIndexAdapter>();
  return {
    store,
    create(rootPath: string): IndexAdapter {
      let adapter = adapters.get(rootPath);
      if (!adapter) {
        adapter = new InMemoryIndexAdapter(rootPath, store, sleep);
        adapters.set(rootPath, adapter);
      }
      // The same documented cast the real factory makes: the adapter
      // implements the ops; the CodeGraph half of the intersection type is
      // the shim for the frozen integration test (see indexAdapter.ts).
      return adapter as unknown as IndexAdapter;
    },
    findNearestRoot(startPath: string): string | null {
      return store.nearestInitialized(startPath);
    },
    preflight(): PreflightResult {
      return opts.preflightResult ?? { ok: true, backend: "in-memory" };
    },
    runtimeGap(err: unknown): RuntimeGapInfo | undefined {
      if (!opts.gapMatcher) return undefined;
      const reason = opts.gapMatcher(err);
      return reason === undefined ? undefined : { reason, notice: reason };
    },
  };
}
