/**
 * CodegraphSession: the session-scoped index manager.
 *
 * Every tool call and the /codegraph command go through `ensureReady`,
 * which resolves the project root for the call, then creates, seeds,
 * builds, or opens the index for that worktree, reconciles it, and
 * returns the live Index adapter for that root. Adapters are cached per
 * root for the session and all closed on session shutdown.
 *
 * The library itself is reached only through the Index adapter (spec
 * 0003): the session names none of the library's instance API, types, or
 * schema. The per-root factory is injected (the real factory in
 * production, the in-memory one in tests) or resolved from the default
 * registry / a lazy dynamic import, so the state machine is testable
 * without the native library.
 *
 * Cross-process safety: the create-or-seed-or-build decision runs under
 * codegraph's own per-root file lock. A process that finds a live build
 * marker waits; a process that finds a dead marker adopts the on-disk
 * state and converges it with a sync. Two concurrent ensureReady calls in
 * the same process share one in-flight promise, so a build always runs
 * once.
 *
 * The internal protocols live in their own modules: the build marker
 * (marker.ts), the watcher policy (watcher.ts), the per-index meta record
 * (index-meta.ts), and the reconcile lock-contention contract
 * (sync-retry.ts). This class keeps the state machine and the public
 * interface.
 */
import type {
  IndexAdapter,
  IndexAdapterFactory,
  IndexProgress,
  SyncResult,
} from "./indexAdapter";
import { getDefaultIndexFactory } from "./factory-registry";
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir, isGitWorktree, listWorktrees } from "./git";
import { clearSeedRecord, readMeta, recordReconcile, recordSeed } from "./index-meta";
import {
  BuildWaitTimeout,
  clearMarker,
  isBuildInFlight,
  isLivePeer,
  readMarker,
  waitForBuild as markerWaitForBuild,
  writeMarker,
} from "./marker";
import type { ResolvedRoot } from "./root";
import { CodegraphUnavailable, resolveRoot, unsafeRootReason } from "./root";
import { findSeedSource } from "./seed";
import { startWatcher as startCodegraphWatcher, type WatcherState } from "./watcher";

export type { WatcherState };
export type { ResolvedRoot };

const LOCK_RETRY_MS = 500;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

interface InstanceEntry {
  cg: IndexAdapter;
  root: string;
  firstSyncDone: boolean;
  watcher: WatcherState;
  watcherReason?: string;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
}

/** A ready-to-query index. */
export interface ReadyInfo {
  cg: IndexAdapter;
  root: string;
  mainCheckout?: string;
  isMainCheckout: boolean;
  justSeeded?: { source: string; changedFiles: number };
  justBuilt?: boolean;
}

/** The counts /codegraph status shows for an index (open or on disk only). */
export interface IndexCounts {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
}

export interface RootStatus {
  root: string;
  needsCreate: boolean;
  mainCheckout?: string;
  isMainCheckout: boolean;
  stats?: IndexCounts;
  indexState?: string | null;
  watcher: WatcherState;
  watcherReason?: string;
  seedSource?: string;
  seededAt?: number;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
  instanceOpen: boolean;
}

export interface SessionUi {
  notify(level: "info" | "warning" | "error", message: string): void;
  status?(text: string | undefined): void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function envSwitch(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function formatProgress(p: IndexProgress, root: string): string {
  const counts = p.total > 0 ? ` ${p.current}/${p.total}` : "";
  const file = p.currentFile ? ` ${p.currentFile}` : "";
  return `codegraph: indexing ${root} [${p.phase}]${counts}${file}`;
}

export class CodegraphSession {
  private readonly instances = new Map<string, InstanceEntry>();
  private readonly inFlight = new Map<string, Promise<ReadyInfo>>();
  private readonly notified = new Set<string>();
  private autoOn: boolean;
  readonly seedingOn: boolean;
  private ui: SessionUi | undefined;
  private readonly factoryOpt: IndexAdapterFactory | undefined;
  private readonly buildWaitTimeoutMs: number;
  private factoryPromise: Promise<IndexAdapterFactory> | undefined;

  constructor(
    opts: {
      autoIndex?: boolean;
      seeding?: boolean;
      /**
       * The Index factory (spec 0003). Production injects the real one;
       * tests inject the in-memory one. When omitted, the real factory is
       * resolved from the default registry or loaded lazily on the first
       * async use.
       */
      factory?: IndexAdapterFactory;
      /** Test seam for the build-wait deadline; the default is 30 minutes. */
      buildWaitTimeoutMs?: number;
    } = {},
  ) {
    this.autoOn = envSwitch("CODEGRAPH_PI_AUTO_INDEX", true);
    if (opts.autoIndex !== undefined) this.autoOn = opts.autoIndex;
    this.seedingOn = envSwitch("CODEGRAPH_PI_SEEDING", true);
    if (opts.seeding !== undefined) this.seedingOn = opts.seeding;
    this.factoryOpt = opts.factory;
    this.buildWaitTimeoutMs = opts.buildWaitTimeoutMs ?? BUILD_WAIT_TIMEOUT_MS;
  }

  /** Bind the TUI sink for notifications and status line updates. */
  setUi(ui: SessionUi): void {
    this.ui = ui;
  }

  setAutoIndex(on: boolean): void {
    this.autoOn = on;
  }

  get autoIndex(): boolean {
    return this.autoOn;
  }

  /** One notification per session per key. */
  notifyOnce(
    key: string,
    level: "info" | "warning" | "error",
    message: string,
  ): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.ui?.notify(level, message);
  }

  /** Close all open instances (session shutdown). */
  closeAll(): void {
    for (const entry of this.instances.values()) {
      try {
        entry.cg.close();
      } catch {
        // already closed
      }
    }
    this.instances.clear();
  }

  private drop(root: string): void {
    const entry = this.instances.get(root);
    if (!entry) return;
    this.instances.delete(root);
    try {
      entry.cg.close();
    } catch {
      // already closed
    }
  }

  private status(text: string | undefined): void {
    this.ui?.status?.(text);
  }

  // ------------------------------------------------------------------
  // factory plumbing
  // ------------------------------------------------------------------

  /**
   * The factory for this session: the injected one, the registered default
   * (handlers.ts registers the real one at module load), or the real one
   * loaded lazily. The lazy load keeps the module graph of a
   * factory-less session free of the library until it is actually needed.
   */
  private async factory(): Promise<IndexAdapterFactory> {
    if (this.factoryOpt) return this.factoryOpt;
    const registered = getDefaultIndexFactory();
    if (registered) return registered;
    if (!this.factoryPromise) {
      this.factoryPromise = import("./indexAdapter").then(
        (m) => m.realIndexFactory,
      );
    }
    return this.factoryPromise;
  }

  /** The factory available synchronously, for the sync entry points. */
  private syncFactory(): IndexAdapterFactory | undefined {
    return this.factoryOpt ?? getDefaultIndexFactory();
  }

  /** The nearest-root lookup as resolveRoot expects, or undefined. */
  private nearest(
    f: IndexAdapterFactory | undefined,
  ): ((startPath: string) => string | null | undefined) | undefined {
    return f ? (p) => f.findNearestRoot(p) : undefined;
  }

  // ------------------------------------------------------------------
  // runtime compatibility (spec 0002)
  // ------------------------------------------------------------------

  /** Translate runtime gaps into the actionable unavailable contract. */
  private classifyError(f: IndexAdapterFactory, err: unknown): unknown {
    if (err instanceof CodegraphUnavailable) return err;
    const gap = f.runtimeGap(err);
    if (gap !== undefined) {
      this.notifyOnce("runtime-sqlite", "warning", gap.notice);
      return new CodegraphUnavailable(gap.reason, true);
    }
    return err;
  }

  /**
   * The once-per-process preflight of the runtime compatibility stack
   * (runtime.ts). A failing stack is reported with an actionable reason
   * before the first query, instead of after the first failure. A
   * runtime-gap failure carries the frozen vocabulary and the one-time
   * notification, exactly like the classifyError path.
   */
  private assertRuntime(f: IndexAdapterFactory): void {
    const res = f.preflight();
    if (res.ok) return;
    const gap = f.runtimeGap(res.reason);
    if (gap !== undefined) {
      this.notifyOnce("runtime-sqlite", "warning", gap.notice);
      throw new CodegraphUnavailable(gap.reason, true);
    }
    throw new CodegraphUnavailable(res.reason, true);
  }

  // ------------------------------------------------------------------
  // public interface
  // ------------------------------------------------------------------

  /**
   * The single boundary every tool call and every test crosses. Resolves
   * the root of `startDir` (or of the `file` argument's location),
   * creates/seedes/builds/opens the index for that worktree when needed,
   * reconciles it, and returns the ready adapter. The recovery for a
   * removed-then-re-added worktree lives in the cached-instance branch of
   * the core path below.
   */
  async ensureReady(startDir: string, file?: string): Promise<ReadyInfo> {
    const f = await this.factory();
    this.assertRuntime(f);
    try {
      return await this.ensureReadyCore(f, startDir, file);
    } catch (err) {
      throw this.classifyError(f, err);
    }
  }

  private async ensureReadyCore(
    f: IndexAdapterFactory,
    startDir: string,
    file?: string,
  ): Promise<ReadyInfo> {
    const resolved = resolveRoot(startDir, file, this.nearest(f));
    let { needsCreate, mainCheckout, isMainCheckout } = resolved;
    const { root } = resolved;

    const cached = this.instances.get(root);
    if (cached) {
      if (cached.cg.databaseExists()) {
        // Replaced-index recovery: `reopenIfReplaced` no-ops (returns
        // false) when the db file was not replaced; a successful reopen
        // means the index file was replaced (a worktree re-added with its
        // index preserved) and a fresh snapshot now sits at the same path,
        // which must be reconciled before serving queries.
        let reopened = false;
        try {
          reopened = cached.cg.reopenIfReplaced();
        } catch {
          reopened = false;
        }
        await this.syncForQuery(
          cached,
          reopened ? "replaced index file" : undefined,
          reopened,
        );
        return { cg: cached.cg, root, mainCheckout, isMainCheckout };
      }
      // Dead-index recovery: the index file is gone, so the worktree was
      // removed and re-added without an index. Drop the dead instance and
      // run the create path below, which seeds from a sibling when one is
      // available.
      this.drop(root);
      if (!f.create(root).initialized()) needsCreate = true;
    }

    const pending = this.inFlight.get(root);
    if (pending) return pending;
    const promise = (async (): Promise<ReadyInfo> => {
      try {
        return await this.createOrOpen(
          f,
          root,
          needsCreate,
          mainCheckout,
          isMainCheckout,
        );
      } finally {
        this.inFlight.delete(root);
      }
    })();
    this.inFlight.set(root, promise);
    return promise;
  }

  /**
   * True when the index for `dir`'s root is ready to serve queries: it
   * exists (on disk or in this session) and no build or seed is running -
   * not in this process (its own marker) and not in another live process
   * (a peer's live marker). While a build runs the database file exists,
   * but the index is not ready, and the prompt note must not steer toward
   * a tool that would block on the build.
   *
   * Cost note: this runs on every before_agent_start and spawns two git
   * calls (rev-parse, worktree list) per turn. That cost is accepted
   * instead of cached: the result only gates the prompt note, and a
   * cached answer would go stale exactly when a worktree is added or
   * removed.
   */
  isReadyFor(dir: string): boolean {
    try {
      const f = this.syncFactory();
      const { root, needsCreate } = resolveRoot(dir, undefined, this.nearest(f));
      if (needsCreate) return this.instances.has(root);
      const marker = f ? readMarker(f.create(root).codeGraphDir()) : undefined;
      if (marker && isBuildInFlight(marker)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The resolved root for `dir` without touching the index. Used by the
   * /codegraph command, which must name the root before it acts.
   */
  resolveRootFor(dir: string): ResolvedRoot {
    return resolveRoot(dir, undefined, this.nearest(this.syncFactory()));
  }

  /** A status snapshot for the /codegraph command. */
  statusFor(dir: string): RootStatus {
    const f = this.syncFactory();
    const resolved = resolveRoot(dir, undefined, this.nearest(f));
    const entry = this.instances.get(resolved.root);
    const adapter = f ? f.create(resolved.root) : undefined;
    const meta =
      adapter && adapter.initialized() ? readMeta(adapter.codeGraphDir()) : {};
    // An index that exists on disk but is not open in this session still
    // reports its counts: they are read straight from the index database,
    // so the bare /codegraph status shows the file/node/edge counts without
    // opening the index.
    const disk = entry ? undefined : adapter?.diskStats();
    return {
      root: resolved.root,
      needsCreate: resolved.needsCreate,
      mainCheckout: resolved.mainCheckout,
      isMainCheckout: resolved.isMainCheckout,
      stats: entry ? entry.cg.getStats() : disk,
      indexState: entry ? entry.cg.getIndexState() : disk?.indexState ?? null,
      watcher: entry?.watcher ?? "off",
      watcherReason: entry?.watcherReason,
      seedSource: meta.seedSource,
      seededAt: meta.seededAt,
      lastReconcileAt: entry?.lastReconcileAt ?? meta.lastReconcileAt,
      lastReconcileChanged:
        entry?.lastReconcileChanged ?? meta.lastReconcileChanged,
      instanceOpen: entry !== undefined,
    };
  }

  /** Force a full rebuild of the index for `dir`'s root. */
  async rebuild(dir: string): Promise<ReadyInfo> {
    const f = await this.factory();
    this.assertRuntime(f);
    try {
      return await this.rebuildCore(f, dir);
    } catch (err) {
      throw this.classifyError(f, err);
    }
  }

  private async rebuildCore(
    f: IndexAdapterFactory,
    dir: string,
  ): Promise<ReadyInfo> {
    const resolved = resolveRoot(dir, undefined, this.nearest(f));
    if (resolved.needsCreate) return this.ensureReady(dir);
    const { root, mainCheckout, isMainCheckout } = resolved;
    this.drop(root);
    const cg = f.create(root);
    writeMarker(cg.codeGraphDir(), "build");
    try {
      await cg.recreate();
      this.status(`codegraph: rebuilding index at ${root}`);
      const res = await cg.indexAll({
        onProgress: (p) => this.status(formatProgress(p, root)),
      });
      this.status(undefined);
      if (!res.success) {
        const detail = res.errors?.[0]?.message ?? "unknown error";
        cg.close();
        this.notifyOnce(
          `build-failed:${root}`,
          "warning",
          `codegraph: index rebuild failed at ${root}: ${detail}`,
        );
        throw new CodegraphUnavailable(`index rebuild failed: ${detail}`, true);
      }
      clearSeedRecord(cg.codeGraphDir());
      const entry = this.register(cg, root);
      entry.firstSyncDone = true;
      this.startWatcher(entry);
      return { cg, root, mainCheckout, isMainCheckout, justBuilt: true };
    } finally {
      clearMarker(cg.codeGraphDir());
    }
  }

  /**
   * Re-seed the index for `dir`'s root from a named sibling worktree
   * (`sourceDir`), or from the default seed source.
   */
  async reseed(dir: string, sourceDir?: string): Promise<ReadyInfo> {
    const f = await this.factory();
    this.assertRuntime(f);
    try {
      return await this.reseedCore(f, dir, sourceDir);
    } catch (err) {
      throw this.classifyError(f, err);
    }
  }

  private async reseedCore(
    f: IndexAdapterFactory,
    dir: string,
    sourceDir?: string,
  ): Promise<ReadyInfo> {
    const resolved = resolveRoot(dir, undefined, this.nearest(f));
    const { root } = resolved;
    // The same guard the auto path applies: a manual seed must not create
    // an index at a refused root (the home directory, the filesystem root).
    const unsafe = unsafeRootReason(root);
    if (unsafe) {
      this.notifyOnce(`unsafe-root:${root}`, "warning", `codegraph: ${unsafe}`);
      throw new CodegraphUnavailable(unsafe, true);
    }
    let source: string;
    if (sourceDir) {
      const abs = path.resolve(dir, sourceDir);
      if (!f.create(abs).initialized()) {
        throw new CodegraphUnavailable(`no codegraph index found at ${abs}`);
      }
      if (!isSiblingOf(root, abs)) {
        throw new CodegraphUnavailable(
          `${abs} is not a sibling worktree of ${root}`,
        );
      }
      source = abs;
    } else {
      const found = findSeedSource(root, (p) => f.create(p).initialized());
      if (!found) {
        throw new CodegraphUnavailable(
          "no sibling worktree with an index was found to seed from",
        );
      }
      source = found.path;
    }

    this.drop(root);
    const cg = f.create(root);
    if (!cg.initialized()) {
      await cg.createEmpty();
    }
    writeMarker(cg.codeGraphDir(), "seed");
    try {
      await cg.seedFrom(source);
      await cg.open();
      const entry = this.register(cg, root);
      return await this.finishSeed(
        entry,
        source,
        resolved.mainCheckout,
        resolved.isMainCheckout,
      );
    } finally {
      clearMarker(cg.codeGraphDir());
      this.status(undefined);
    }
  }

  /** Remove the index for `dir`'s root. */
  async uninit(dir: string): Promise<{ root: string; removed: boolean }> {
    const f = await this.factory();
    const { root } = resolveRoot(dir, undefined, this.nearest(f));
    this.drop(root);
    const cg = f.create(root);
    if (!cg.initialized()) return { root, removed: false };
    fs.rmSync(cg.codeGraphDir(), { recursive: true, force: true });
    return { root, removed: true };
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private register(cg: IndexAdapter, root: string): InstanceEntry {
    const entry: InstanceEntry = {
      cg,
      root,
      firstSyncDone: false,
      watcher: "off",
    };
    this.instances.set(root, entry);
    return entry;
  }

  private async createOrOpen(
    f: IndexAdapterFactory,
    root: string,
    needsCreate: boolean,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    if (!needsCreate) {
      return this.openExisting(f, root, mainCheckout, isMainCheckout);
    }
    if (!this.autoOn) {
      throw new CodegraphUnavailable(
        "auto-index is off for this session (enable it with /codegraph auto on)",
      );
    }
    const unsafe = unsafeRootReason(root);
    if (unsafe) {
      this.notifyOnce(
        `unsafe-root:${root}`,
        "warning",
        `codegraph: ${unsafe}`,
      );
      throw new CodegraphUnavailable(unsafe, true);
    }

    for (;;) {
      const prepared = await this.prepareUnderLock(f, root);
      if (prepared.mode === "wait") {
        await this.waitForBuild(f, root);
        continue;
      }
      if (prepared.mode === "adopt") {
        return this.openExisting(f, root, mainCheckout, isMainCheckout);
      }
      return this.runBuildOrSeed(
        f,
        root,
        prepared.mode === "seed" ? prepared.seedSource : undefined,
        mainCheckout,
        isMainCheckout,
      );
    }
  }

  /** Open an existing index, run the first-use reconcile, and start the watcher. */
  private async openExisting(
    f: IndexAdapterFactory,
    root: string,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    await this.awaitBuildMarker(f, root);
    const cg = f.create(root);
    try {
      await cg.open();
      const entry = this.register(cg, root);
      this.startWatcher(entry);
      await this.syncForQuery(entry);
      return { cg, root, mainCheckout, isMainCheckout };
    } catch (err) {
      this.drop(root);
      throw err;
    }
  }

  /**
   * Under codegraph's per-root file lock: decide whether to wait for a
   * live build, adopt an existing index, or prepare an empty (optionally
   * seeded) index for the full build / post-seed reconcile that runs
   * outside the lock (codegraph holds the lock itself during index
   * operations).
   */
  private async prepareUnderLock(
    f: IndexAdapterFactory,
    root: string,
  ): Promise<
    | { mode: "wait" }
    | { mode: "adopt" }
    | { mode: "build" }
    | { mode: "seed"; seedSource: string }
  > {
    const cg = f.create(root);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        cg.acquireLock();
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new CodegraphUnavailable(
            `timed out waiting for the codegraph lock at ${root}`,
            true,
          );
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
    }
    try {
      if (cg.initialized()) {
        const marker = readMarker(cg.codeGraphDir());
        if (marker && isLivePeer(marker)) {
          return { mode: "wait" };
        }
        clearMarker(cg.codeGraphDir());
        return { mode: "adopt" };
      }
      // No index yet. Create the index directory via codegraph's own
      // directory setup (this also creates an empty database), then seed
      // it from a sibling when one is available.
      await cg.createEmpty();
      const source = this.seedingOn
        ? findSeedSource(root, (p) => f.create(p).initialized())
        : undefined;
      if (source) {
        await cg.seedFrom(source.path);
        writeMarker(cg.codeGraphDir(), "seed");
        return { mode: "seed", seedSource: source.path };
      }
      writeMarker(cg.codeGraphDir(), "build");
      return { mode: "build" };
    } finally {
      cg.releaseLock();
    }
  }

  /**
   * Block while another live process is building the index for `root`
   * (its build marker is present). A marker whose process is dead is
   * removed and the on-disk state is adopted instead.
   */
  private async waitForBuild(f: IndexAdapterFactory, root: string): Promise<void> {
    try {
      await markerWaitForBuild(f.create(root).codeGraphDir(), {
        timeoutMs: this.buildWaitTimeoutMs,
        onStatus: (text) => this.status(text),
      });
    } catch (err) {
      if (!(err instanceof BuildWaitTimeout)) throw err;
      this.status(undefined);
      this.notifyOnce(
        `build-wait-timeout:${root}`,
        "warning",
        `codegraph: timed out waiting for the index build at ${root}`,
      );
      throw new CodegraphUnavailable(
        "timed out waiting for another codegraph process to finish the index",
        true,
      );
    }
  }

  /**
   * Block (open path) while another live process is rebuilding this index.
   * Without this, the open path could serve a snapshot of an index that a
   * concurrent /codegraph init is about to replace.
   */
  private async awaitBuildMarker(f: IndexAdapterFactory, root: string): Promise<void> {
    const marker = readMarker(f.create(root).codeGraphDir());
    if (marker && isLivePeer(marker)) {
      await this.waitForBuild(f, root);
    }
  }

  /**
   * The shared post-seed completion, used by the manual reseed path and the
   * auto create-or-seed path: reconcile the seeded index, record the seed,
   * notify, mark the first sync done, start the watcher, and return the
   * ReadyInfo.
   */
  private async finishSeed(
    entry: InstanceEntry,
    seedSource: string,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    this.status(`codegraph: reconciling seeded index at ${entry.root}`);
    const res = await this.runSync(entry);
    const changed = res.filesAdded + res.filesModified + res.filesRemoved;
    recordSeed(entry.cg.codeGraphDir(), seedSource);
    this.notifyOnce(
      `seeded:${entry.root}`,
      "info",
      `codegraph: seeded index for ${entry.root} from ${seedSource}; reconcile changed ${changed} file${changed === 1 ? "" : "s"}`,
    );
    entry.firstSyncDone = true;
    this.startWatcher(entry);
    return {
      cg: entry.cg,
      root: entry.root,
      mainCheckout,
      isMainCheckout,
      justSeeded: { source: seedSource, changedFiles: changed },
    };
  }

  /** Run the full build or the post-seed reconcile for a prepared index. */
  private async runBuildOrSeed(
    f: IndexAdapterFactory,
    root: string,
    seedSource: string | undefined,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    const cg = f.create(root);
    try {
      await cg.open();
    } catch (err) {
      if (!seedSource) throw err;
      // A crashed seed may have left a corrupt database. Discard it, re-seed
      // once, and try again.
      if (cg.initialized()) {
        await cg.recreate();
      } else {
        await cg.createEmpty();
      }
      cg.close();
      await cg.seedFrom(seedSource);
      await cg.open();
    }
    const entry = this.register(cg, root);
    try {
      if (seedSource) {
        return this.finishSeed(entry, seedSource, mainCheckout, isMainCheckout);
      }
      this.status(`codegraph: building index at ${root}`);
      const res = await cg.indexAll({
        onProgress: (p) => this.status(formatProgress(p, root)),
      });
      this.status(undefined);
      if (!res.success) {
        const detail = res.errors?.[0]?.message ?? "unknown error";
        this.drop(root);
        this.notifyOnce(
          `build-failed:${root}`,
          "warning",
          `codegraph: index build failed at ${root}: ${detail}`,
        );
        throw new CodegraphUnavailable(`index build failed: ${detail}`, true);
      }
      entry.firstSyncDone = true;
      this.startWatcher(entry);
      return { cg, root, mainCheckout, isMainCheckout, justBuilt: true };
    } finally {
      clearMarker(cg.codeGraphDir());
      this.status(undefined);
    }
  }

  /**
   * Reconcile before serving queries: the first use of a root in this
   * session always reconciles (a full walk is a fast no-op when nothing
   * changed, and it heals an interrupted build), and so does every query
   * when the watcher is not active (reconcile-on-use).
   */
  private async syncForQuery(
    entry: InstanceEntry,
    label?: string,
    force = false,
  ): Promise<void> {
    if (!force && entry.firstSyncDone && entry.watcher === "active") return;
    this.status(
      `codegraph: reconciling index at ${entry.root}${label ? ` (${label})` : ""}`,
    );
    await this.runSync(entry);
    entry.firstSyncDone = true;
    this.status(undefined);
  }

  private async runSync(entry: InstanceEntry): Promise<SyncResult> {
    // The adapter runs the lock-contention contract internally (see
    // sync-retry.ts); a returned result with filesChecked === 0 is the
    // "the lock could not be acquired" signal.
    const res = await entry.cg.sync();
    if (res.filesChecked === 0) {
      this.notifyOnce(
        `sync-failed:${entry.root}`,
        "warning",
        `codegraph: could not reconcile the index at ${entry.root} - the codegraph lock is held by another process`,
      );
      throw new CodegraphUnavailable(
        `could not reconcile the index at ${entry.root}: the codegraph lock is held by another process`,
        true,
      );
    }
    const changed = res.filesAdded + res.filesModified + res.filesRemoved;
    entry.lastReconcileAt = recordReconcile(entry.cg.codeGraphDir(), changed);
    entry.lastReconcileChanged = changed;
    return res;
  }

  private startWatcher(entry: InstanceEntry): void {
    const { state, reason } = startCodegraphWatcher(entry.cg, entry.root, {
      onDegraded: (r: string) => {
        entry.watcher = "degraded";
        entry.watcherReason = r;
        this.notifyOnce(
          `watcher-degraded:${entry.root}`,
          "warning",
          `codegraph: file watcher degraded (${r}); the index is reconciled before every query`,
        );
      },
      onSyncComplete: (filesChanged: number, reconciledAt: number) => {
        entry.lastReconcileChanged = filesChanged;
        entry.lastReconcileAt = reconciledAt;
      },
    });
    entry.watcher = state;
    entry.watcherReason = reason;
    if (state === "disabled") {
      this.notifyOnce(
        `watcher-disabled:${entry.root}`,
        "warning",
        `codegraph: file watcher disabled on this filesystem (${reason}); the index is reconciled before every query`,
      );
    } else if (state === "degraded") {
      this.notifyOnce(
        `watcher-degraded:${entry.root}`,
        "warning",
        `codegraph: file watcher unavailable (${reason}); the index is reconciled before every query`,
      );
    }
  }
}

function isSiblingOf(root: string, candidate: string): boolean {
  if (!isGitWorktree(root)) return false;
  const common = gitCommonDir(root);
  if (common === undefined) return false;
  const candidateCommon = gitCommonDir(candidate);
  if (candidateCommon === undefined) return false;
  if (common !== candidateCommon) return false;
  return listWorktrees(root).some((w) => w.path === candidate);
}
