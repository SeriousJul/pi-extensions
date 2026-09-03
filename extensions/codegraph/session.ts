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
 */
import "./env";
import {
  CodeGraph,
  FileLock,
  getDatabasePath,
  getCodeGraphDir,
  isInitialized,
} from "./codegraph";
import type { GraphStats, IndexProgress, SyncResult } from "./codegraph";
import fs from "node:fs";
import path from "node:path";
import { gitCommonDir, isGitWorktree, listWorktrees } from "./git";
import { CodegraphUnavailable, resolveRoot, unsafeRootReason } from "./root";
import { findSeedSource, seedDb } from "./seed";

/** Exported for tests that simulate another process's live build. */
export const MARKER_NAME = "pi-codegraph-build.json";
const META_NAME = "pi-codegraph-meta.json";
const LOCK_RETRY_MS = 500;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const BUILD_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

interface BuildMarker {
  pid: number;
  startedAt: number;
  mode: "build" | "seed";
}

interface Meta {
  seedSource?: string;
  seededAt?: number;
  lastReconcileAt?: number;
  lastReconcileChanged?: number;
}

export type WatcherState = "active" | "degraded" | "disabled" | "off";

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

export interface RootStatus {
  root: string;
  needsCreate: boolean;
  mainCheckout?: string;
  isMainCheckout: boolean;
  stats?: GraphStats;
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

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    // metadata is advisory - never fail a query over it
  }
}

function markerPath(root: string): string {
  return path.join(getCodeGraphDir(root), MARKER_NAME);
}

function readMarker(root: string): BuildMarker | undefined {
  const marker = readJson<BuildMarker>(markerPath(root));
  return marker && typeof marker.pid === "number" ? marker : undefined;
}

function writeMarker(root: string, mode: "build" | "seed"): void {
  fs.writeFileSync(
    markerPath(root),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode }),
  );
}

function clearMarker(root: string): void {
  fs.rmSync(markerPath(root), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function metaPath(root: string): string {
  return path.join(getCodeGraphDir(root), META_NAME);
}

function readMeta(root: string): Meta {
  return readJson<Meta>(metaPath(root)) ?? {};
}

function writeMeta(root: string, meta: Meta): void {
  writeJson(metaPath(root), meta);
}

let wslCache: boolean | undefined;
function isWsl(): boolean {
  if (wslCache === undefined) {
    wslCache = Boolean(
      process.env.WSL_DISTRO_NAME || process.env.WSL_INTERACTIVE,
    );
    if (!wslCache) {
      try {
        wslCache = /microsoft|wsl/i.test(
          fs.readFileSync("/proc/version", "utf-8"),
        );
      } catch {
        // not WSL
      }
    }
  }
  return wslCache;
}

/**
 * Mirrors codegraph's own watch policy: recursive fs.watch is pathologically
 * slow on WSL2 /mnt drives, and CODEGRAPH_NO_WATCH=1 opts out explicitly.
 */
export function watchDisabledReason(root: string): string | null {
  if (process.env.CODEGRAPH_NO_WATCH === "1") {
    return "CODEGRAPH_NO_WATCH=1";
  }
  if (isWsl() && root.startsWith("/mnt/")) {
    return "WSL2 /mnt drive";
  }
  return null;
}

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
    } else if (!fs.existsSync(db)) {
      this.drop(info.root);
      return this.ensureReady(startDir, file);
    }
    return info;
  }

  /**
   * Ensure an index exists and is up to date for the root of `startDir`
   * (or of the `file` argument's location), and return a ready instance.
   * This is the primary test seam.
   */
  async ensureReady(startDir: string, file?: string): Promise<ReadyInfo> {
    try {
      return await this.ensureReadyCore(startDir, file);
    } catch (err) {
      throw this.classifyError(err);
    }
  }

  /** Translate runtime gaps into the actionable unavailable contract. */
  private classifyError(err: unknown): unknown {
    if (err instanceof CodegraphUnavailable) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/node:sqlite|No such built-in module/i.test(msg)) {
      this.notifyOnce(
        "runtime-sqlite",
        "warning",
        "codegraph: this runtime has no node:sqlite (pi bundles bun < 1.4). " +
          "The installed codegraph package is not patched for it. Run " +
          "`npm install` in the pi-extensions repo, then restart pi.",
      );
      return new CodegraphUnavailable(
        "this runtime has no node:sqlite and codegraph is not patched for it (run npm install in the pi-extensions repo, then restart pi)",
        true,
      );
    }
    return err;
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
   */
  isReadyFor(dir: string): boolean {
    try {
      const { root, needsCreate } = resolveRoot(dir);
      if (needsCreate) return this.instances.has(root);
      const marker = readMarker(root);
      if (marker && (marker.pid === process.pid || isPidAlive(marker.pid))) {
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
    return {
      root: resolved.root,
      needsCreate: resolved.needsCreate,
      mainCheckout: resolved.mainCheckout,
      isMainCheckout: resolved.isMainCheckout,
      stats: entry ? entry.cg.getStats() : undefined,
      indexState: entry ? entry.cg.getIndexState() : undefined,
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
      const meta = readMeta(root);
      delete meta.seedSource;
      delete meta.seededAt;
      writeMeta(root, meta);
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
      this.status(`codegraph: reconciling seeded index at ${root}`);
      const res = await this.runSync(entry);
      const changed = res.filesAdded + res.filesModified + res.filesRemoved;
      const meta = readMeta(root);
      meta.seedSource = source;
      meta.seededAt = Date.now();
      writeMeta(root, meta);
      this.notifyOnce(
        `seeded:${root}`,
        "info",
        `codegraph: seeded index for ${root} from ${source}; reconcile changed ${changed} file${changed === 1 ? "" : "s"}`,
      );
      entry.firstSyncDone = true;
      this.startWatcher(entry);
      return {
        cg,
        root,
        mainCheckout: resolved.mainCheckout,
        isMainCheckout: resolved.isMainCheckout,
        justSeeded: { source, changedFiles: changed },
      };
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
          if (
            marker &&
            marker.pid !== process.pid &&
            isPidAlive(marker.pid)
          ) {
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
    const deadline = Date.now() + BUILD_WAIT_TIMEOUT_MS;
    for (;;) {
      const marker = readMarker(root);
      if (!marker) return;
      if (marker.pid !== process.pid && !isPidAlive(marker.pid)) {
        clearMarker(root);
        return;
      }
      this.status(
        `codegraph: waiting for the index build at ${root} (pid ${marker.pid})`,
      );
      if (Date.now() > deadline) {
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
      await sleep(300);
    }
  }

  /**
   * Block (open path) while another live process is rebuilding this index.
   * Without this, the open path could serve a snapshot of an index that a
   * concurrent /codegraph init is about to replace.
   */
  private async awaitBuildMarker(root: string): Promise<void> {
    const marker = readMarker(root);
    if (marker && marker.pid !== process.pid && isPidAlive(marker.pid)) {
      await this.waitForBuild(root);
    }
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
        this.status(`codegraph: reconciling seeded index at ${root}`);
        const res = await this.runSync(entry);
        const changed = res.filesAdded + res.filesModified + res.filesRemoved;
        const meta = readMeta(root);
        meta.seedSource = seedSource;
        meta.seededAt = Date.now();
        writeMeta(root, meta);
        this.notifyOnce(
          `seeded:${root}`,
          "info",
          `codegraph: seeded index for ${root} from ${seedSource}; reconcile changed ${changed} file${changed === 1 ? "" : "s"}`,
        );
        entry.firstSyncDone = true;
        this.startWatcher(entry);
        return {
          cg,
          root,
          mainCheckout,
          isMainCheckout,
          justSeeded: { source: seedSource, changedFiles: changed },
        };
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
    entry.lastReconcileAt = Date.now();
    entry.lastReconcileChanged = changed;
    const meta = readMeta(entry.root);
    meta.lastReconcileAt = entry.lastReconcileAt;
    meta.lastReconcileChanged = changed;
    writeMeta(entry.root, meta);
    return res;
  }

  private startWatcher(entry: InstanceEntry): void {
    const disabled = watchDisabledReason(entry.root);
    if (disabled) {
      entry.watcher = "disabled";
      entry.watcherReason = disabled;
      this.notifyOnce(
        `watcher-disabled:${entry.root}`,
        "warning",
        `codegraph: file watcher disabled on this filesystem (${disabled}); the index is reconciled before every query`,
      );
      return;
    }
    // A thrown watch() (not just a false return) degrades the watcher;
    // it must not fail a tool call that has already synced.
    let ok: boolean;
    let startError: string | undefined;
    try {
      ok = entry.cg.watch({
        debounceMs: 1000,
        onDegraded: (reason: string) => {
          entry.watcher = "degraded";
          entry.watcherReason = reason;
          this.notifyOnce(
            `watcher-degraded:${entry.root}`,
            "warning",
            `codegraph: file watcher degraded (${reason}); the index is reconciled before every query`,
          );
        },
        onSyncComplete: (r: { filesChanged: number; durationMs: number }) => {
          entry.lastReconcileAt = Date.now();
          entry.lastReconcileChanged = r.filesChanged;
          const meta = readMeta(entry.root);
          meta.lastReconcileAt = entry.lastReconcileAt;
          meta.lastReconcileChanged = r.filesChanged;
          writeMeta(entry.root, meta);
        },
        onSyncError: () => {
          // transient sync errors are retried by the watcher
        },
      });
    } catch (err) {
      ok = false;
      startError = err instanceof Error ? err.message : String(err);
    }
    if (ok) {
      entry.watcher = "active";
    } else {
      entry.watcher = "degraded";
      entry.watcherReason =
        startError ??
        entry.cg.getWatcherDegradedReason() ??
        "watcher failed to start";
      this.notifyOnce(
        `watcher-degraded:${entry.root}`,
        "warning",
        `codegraph: file watcher unavailable (${entry.watcherReason}); the index is reconciled before every query`,
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
