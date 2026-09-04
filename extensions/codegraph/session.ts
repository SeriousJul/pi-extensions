/**
 * CodegraphSession: the session-scoped index manager.
 *
 * Every tool call and the /codegraph command go through `queryReady`/
 * `ensureReady`, which resolve the project root for the call, then create,
 * seed, build, or open the index for that worktree, reconcile it, and return
 * a live CodeGraph instance. Instances are cached per root for the session
 * and all closed on session shutdown.
 *
 * Cross-process safety: the create-or-seed-or-build decision runs under
 * codegraph's own per-root file lock. A process that finds a live build
 * marker waits; a process that finds a dead marker adopts the on-disk state
 * and converges it with a sync. Two concurrent ensureReady calls in the same
 * process share one in-flight promise, so a build always runs once.
 *
 * The internal protocols live in their own modules: the build marker
 * (marker.ts), the watcher policy (watcher.ts), and the per-index meta
 * record (index-meta.ts). This class keeps the state machine and the
 * public interface.
 *
 * The runtime compatibility stack (env defaults, library load, shim
 * wiring, preflight, runtime-gap classification) lives in runtime.ts;
 * this class runs the once-per-process preflight before the first query
 * and maps runtime-gap errors to the unavailable contract.
 */
import {
  CodeGraph,
  DatabaseSync,
  FileLock,
  getDatabasePath,
  getCodeGraphDir,
  isInitialized,
  preflight,
  RUNTIME_SQLITE_NOTICE,
  RUNTIME_SQLITE_REASON,
  runtimeGapReason,
} from "./runtime";
import type { GraphStats, IndexProgress, SyncResult } from "./runtime";
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
import { CodegraphUnavailable, resolveRoot, unsafeRootReason } from "./root";
import { findSeedSource, seedDb } from "./seed";
import { startWatcher as startCodegraphWatcher, type WatcherState } from "./watcher";

export type { WatcherState };

const LOCK_RETRY_MS = 500;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

interface InstanceEntry {
  cg: CodeGraph;
  root: string;
  firstSyncDone: boolean;
  watcher: WatcherState;
  watcherReason?: string;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
}

/** A ready-to-query index. */
export interface ReadyInfo {
  cg: CodeGraph;
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

  constructor(opts: { autoIndex?: boolean; seeding?: boolean } = {}) {
    this.autoOn = envSwitch("CODEGRAPH_PI_AUTO_INDEX", true);
    if (opts.autoIndex !== undefined) this.autoOn = opts.autoIndex;
    this.seedingOn = envSwitch("CODEGRAPH_PI_SEEDING", true);
    if (opts.seeding !== undefined) this.seedingOn = opts.seeding;
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

  /**
   * The single boundary every tool call goes through. Resolves the root,
   * creates/seedes/builds/opens the index for that worktree when needed,
   * reconciles it, and returns a live instance. A worktree that was removed
   * and re-added is re-seeded from a sibling instead of served from a dead
   * snapshot.
   */
  async queryReady(startDir: string, file?: string): Promise<ReadyInfo> {
    const info = await this.ensureReady(startDir, file);
    const entry = this.instances.get(info.root);
    if (!entry) return info;
    const db = getDatabasePath(info.root);
    if (!fs.existsSync(db)) {
      // The index file is gone: the worktree was removed and re-added
      // without an index. Drop the dead instance and run the create path
      // again, which seeds from a sibling.
      this.drop(info.root);
      return this.ensureReady(startDir, file);
    }
    // `reopenIfReplaced` no-ops (returns false) when the db file was not
    // replaced; a successful reopen means a fresh snapshot now sits at the
    // same path and must be reconciled before serving queries.
    let reopened = false;
    try {
      reopened = entry.cg.reopenIfReplaced();
    } catch {
      reopened = false;
    }
    if (reopened) {
      await this.syncForQuery(entry, "replaced index file", true);
    }
    return info;
  }

  /**
   * Ensure an index exists and is up to date for the root of `startDir`
   * (or of the `file` argument's location), and return a ready instance.
   * This is the primary test seam.
   */
  async ensureReady(startDir: string, file?: string): Promise<ReadyInfo> {
    this.assertRuntime();
    try {
      return await this.ensureReadyCore(startDir, file);
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  /** Translate runtime gaps into the actionable unavailable contract. */
  private classifyError(err: unknown): unknown {
    if (err instanceof CodegraphUnavailable) return err;
    const reason = runtimeGapReason(err);
    if (reason !== undefined) {
      this.notifyOnce("runtime-sqlite", "warning", RUNTIME_SQLITE_NOTICE);
      return new CodegraphUnavailable(reason, true);
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
  private assertRuntime(): void {
    const res = preflight();
    if (res.ok) return;
    if (runtimeGapReason(res.reason) !== undefined) {
      this.notifyOnce("runtime-sqlite", "warning", RUNTIME_SQLITE_NOTICE);
      throw new CodegraphUnavailable(RUNTIME_SQLITE_REASON, true);
    }
    throw new CodegraphUnavailable(res.reason, true);
  }

  private async ensureReadyCore(
    startDir: string,
    file?: string,
  ): Promise<ReadyInfo> {
    const resolved = resolveRoot(startDir, file);
    let { needsCreate, mainCheckout, isMainCheckout } = resolved;
    const { root } = resolved;

    const cached = this.instances.get(root);
    if (cached) {
      if (fs.existsSync(getDatabasePath(root))) {
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
      this.drop(root);
      if (!isInitialized(root)) needsCreate = true;
    }

    const pending = this.inFlight.get(root);
    if (pending) return pending;
    const promise = (async (): Promise<ReadyInfo> => {
      try {
        return await this.createOrOpen(
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
      const { root, needsCreate } = resolveRoot(dir);
      if (needsCreate) return this.instances.has(root);
      const marker = readMarker(root);
      if (marker && isBuildInFlight(marker)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** A status snapshot for the /codegraph command. */
  statusFor(dir: string): RootStatus {
    const resolved = resolveRoot(dir);
    const entry = this.instances.get(resolved.root);
    const meta = isInitialized(resolved.root) ? readMeta(resolved.root) : {};
    // An index that exists on disk but is not open in this session still
    // reports its counts: they are read straight from the index database,
    // so the bare /codegraph status shows the file/node/edge counts without
    // opening the index.
    const disk = entry ? undefined : diskStats(resolved.root);
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
    this.assertRuntime();
    try {
      return await this.rebuildCore(dir);
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  private async rebuildCore(dir: string): Promise<ReadyInfo> {
    const resolved = resolveRoot(dir);
    if (resolved.needsCreate) return this.ensureReady(dir);
    const { root, mainCheckout, isMainCheckout } = resolved;
    this.drop(root);
    writeMarker(root, "build");
    let cg: CodeGraph;
    try {
      cg = await CodeGraph.recreate(root);
      this.status(`codegraph: rebuilding index at ${root}`);
      const res = await cg.indexAll({
        onProgress: (p) => this.status(formatProgress(p, root)),
      });
      this.status(undefined);
      if (!res.success) {
        const detail = res.errors?.[0]?.message ?? "unknown error";
        try {
          cg.close();
        } catch {
          // ignore
        }
        this.notifyOnce(
          `build-failed:${root}`,
          "warning",
          `codegraph: index rebuild failed at ${root}: ${detail}`,
        );
        throw new CodegraphUnavailable(`index rebuild failed: ${detail}`, true);
      }
      clearSeedRecord(root);
      const entry = this.register(cg, root);
      entry.firstSyncDone = true;
      this.startWatcher(entry);
      return { cg, root, mainCheckout, isMainCheckout, justBuilt: true };
    } finally {
      clearMarker(root);
    }
  }

  /**
   * Re-seed the index for `dir`'s root from a named sibling worktree
   * (`sourceDir`), or from the default seed source.
   */
  async reseed(dir: string, sourceDir?: string): Promise<ReadyInfo> {
    this.assertRuntime();
    try {
      return await this.reseedCore(dir, sourceDir);
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  private async reseedCore(
    dir: string,
    sourceDir?: string,
  ): Promise<ReadyInfo> {
    const resolved = resolveRoot(dir);
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
      if (!isInitialized(abs)) {
        throw new CodegraphUnavailable(`no codegraph index found at ${abs}`);
      }
      if (!isSiblingOf(root, abs)) {
        throw new CodegraphUnavailable(
          `${abs} is not a sibling worktree of ${root}`,
        );
      }
      source = abs;
    } else {
      const found = findSeedSource(root);
      if (!found) {
        throw new CodegraphUnavailable(
          "no sibling worktree with an index was found to seed from",
        );
      }
      source = found.path;
    }

    this.drop(root);
    if (!isInitialized(root)) {
      const created = await CodeGraph.init(root);
      created.close();
    }
    writeMarker(root, "seed");
    let cg: CodeGraph;
    try {
      await seedDb(root, source);
      cg = await CodeGraph.open(root, { sync: false });
      const entry = this.register(cg, root);
      return await this.finishSeed(
        entry,
        source,
        resolved.mainCheckout,
        resolved.isMainCheckout,
      );
    } finally {
      clearMarker(root);
      this.status(undefined);
    }
  }

  /** Remove the index for `dir`'s root. */
  async uninit(dir: string): Promise<{ root: string; removed: boolean }> {
    const { root } = resolveRoot(dir);
    this.drop(root);
    if (!isInitialized(root)) return { root, removed: false };
    fs.rmSync(getCodeGraphDir(root), { recursive: true, force: true });
    return { root, removed: true };
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private register(cg: CodeGraph, root: string): InstanceEntry {
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
    root: string,
    needsCreate: boolean,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    if (!needsCreate) {
      return this.openExisting(root, mainCheckout, isMainCheckout);
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
      const prepared = await this.prepareUnderLock(root);
      if (prepared.mode === "wait") {
        await this.waitForBuild(root);
        continue;
      }
      if (prepared.mode === "adopt") {
        return this.openExisting(root, mainCheckout, isMainCheckout);
      }
      return this.runBuildOrSeed(
        root,
        prepared.mode === "seed" ? prepared.seedSource : undefined,
        mainCheckout,
        isMainCheckout,
      );
    }
  }

  /** Open an existing index, run the first-use reconcile, and start the watcher. */
  private async openExisting(
    root: string,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    await this.awaitBuildMarker(root);
    const cg = await CodeGraph.open(root, { sync: false });
    try {
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
   * Under codegraph's per-root file lock: decide whether to wait for a live
   * build, adopt an existing index, or prepare an empty (optionally seeded)
   * index for the full build / post-seed reconcile that runs outside the
   * lock (codegraph holds the lock itself during index operations).
   */
  private async prepareUnderLock(
    root: string,
  ): Promise<
    | { mode: "wait" }
    | { mode: "adopt" }
    | { mode: "build" }
    | { mode: "seed"; seedSource: string }
  > {
    const dir = getCodeGraphDir(root);
    const lock = new FileLock(path.join(dir, "codegraph.lock"));
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        lock.acquire();
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
      try {
        if (isInitialized(root)) {
          const marker = readMarker(root);
          if (marker && isLivePeer(marker)) {
            return { mode: "wait" };
          }
          clearMarker(root);
          return { mode: "adopt" };
        }
        // No index yet. Create the index directory via codegraph's own
        // directory setup (this also creates an empty database), then seed
        // it from a sibling when one is available.
        const created = await CodeGraph.init(root);
        created.close();
        const source = this.seedingOn ? findSeedSource(root) : undefined;
        if (source) {
          await seedDb(root, source.path);
          writeMarker(root, "seed");
          return { mode: "seed", seedSource: source.path };
        }
        writeMarker(root, "build");
        return { mode: "build" };
      } finally {
        lock.release();
      }
    }
  }

  /**
   * Block while another live process is building the index for `root`
   * (its build marker is present). A marker whose process is dead is
   * removed and the on-disk state is adopted instead.
   */
  private async waitForBuild(root: string): Promise<void> {
    try {
      await markerWaitForBuild(root, {
        timeoutMs: BUILD_WAIT_TIMEOUT_MS,
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
  private async awaitBuildMarker(root: string): Promise<void> {
    const marker = readMarker(root);
    if (marker && isLivePeer(marker)) {
      await this.waitForBuild(root);
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
    recordSeed(entry.root, seedSource);
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
    root: string,
    seedSource: string | undefined,
    mainCheckout?: string,
    isMainCheckout = false,
  ): Promise<ReadyInfo> {
    let cg: CodeGraph;
    try {
      cg = await CodeGraph.open(root, { sync: false });
    } catch (err) {
      if (!seedSource) throw err;
      // A crashed seed may have left a corrupt database. Discard it, re-seed
      // once, and try again.
      const discarded = isInitialized(root)
        ? await CodeGraph.recreate(root)
        : await CodeGraph.init(root);
      discarded.close();
      await seedDb(root, seedSource);
      cg = await CodeGraph.open(root, { sync: false });
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
      clearMarker(root);
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
    // `sync` reports a held per-root lock as an all-zero result (a real
    // no-change sync still reports how many files it checked), so
    // filesChecked === 0 means the lock was not acquired. A concurrent
    // codegraph process can hold it briefly; retry before failing.
    let res: SyncResult;
    for (let attempt = 0; ; attempt++) {
      res = await entry.cg.sync();
      if (res.filesChecked > 0 || attempt >= 2) break;
      await sleep(750 * (attempt + 1));
    }
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
    entry.lastReconcileAt = recordReconcile(entry.root, changed);
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

/** The index state values codegraph writes to project_metadata. */
const INDEX_STATES = ["indexing", "complete", "partial", "failed"] as const;

/**
 * Read the index counts and state straight from the index database, without
 * opening a CodeGraph instance. Used by /codegraph status when the index
 * exists on disk but the session has not opened it yet. The counts mirror
 * CodeGraph.getStats() (the same table counts). Returns undefined when the
 * database cannot be read.
 *
 * Known coupling: the query names codegraph's schema directly (files,
 * nodes, edges, project_metadata). An upstream schema change breaks the
 * counts until this query is updated; the failure is graceful (status
 * falls back to "counts unavailable"), never a crash. Re-check this query
 * when the pinned codegraph version is bumped.
 */
function diskStats(
  root: string,
): {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  indexState: string | null;
} | undefined {
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

function isSiblingOf(root: string, candidate: string): boolean {
  if (!isGitWorktree(root)) return false;
  const common = gitCommonDir(root);
  if (common === undefined) return false;
  const candidateCommon = gitCommonDir(candidate);
  if (candidateCommon === undefined) return false;
  if (common !== candidateCommon) return false;
  return listWorktrees(root).some((w) => w.path === candidate);
}
