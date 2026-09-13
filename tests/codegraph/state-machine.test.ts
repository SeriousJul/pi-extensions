/**
 * The session state machine over the in-memory Index adapter (spec 0003).
 *
 * The fast suite the spec asks for: the session's decision logic is tested
 * in milliseconds with no index build, no native library, and no git. The
 * in-memory factory is injected at construction; this module never
 * imports the library (only the session, the marker module, and the
 * in-memory factory - all library-free at runtime).
 *
 * The integration suite (session.test.ts) covers the same logic against
 * the real adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodegraphSession } from "../../extensions/codegraph/session";
import { CodegraphUnavailable } from "../../extensions/codegraph/root";
import { createOpenSrc } from "../../extensions/codegraph/opensrc";
import { MARKER_NAME, writeMarker } from "../../extensions/codegraph/marker";
import {
  IN_MEMORY_DIR_NAME,
  InMemoryIndex,
  createInMemoryIndexFactory,
  type InMemoryFactoryOptions,
} from "./inMemoryIndex";

let root: string;
let store: InMemoryIndex;
let dir: string;
const sessions: CodegraphSession[] = [];

function newSession(opts: InMemoryFactoryOptions = {}): CodegraphSession {
  const s = new CodegraphSession({
    factory: createInMemoryIndexFactory({ store, ...opts }),
  });
  sessions.push(s);
  return s;
}

function dirMarker(): string {
  return path.join(root, IN_MEMORY_DIR_NAME);
}

/** A pid whose process has exited: the marker it owned reads as dead. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
}

function unavailable(e: unknown): e is CodegraphUnavailable {
  return e instanceof CodegraphUnavailable;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-state-"));
  dir = dirMarker();
  // A non-git project: a manifest and one indexable file.
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  store = new InMemoryIndex();
});

afterEach(() => {
  for (const s of sessions.splice(0)) s.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("build and readiness", () => {
  it("runs one build for two concurrent ensureReady calls", async () => {
    const s = newSession();
    const [a, b] = await Promise.all([s.ensureReady(root), s.ensureReady(root)]);
    expect(a.root).toBe(root);
    expect(a.justBuilt).toBe(true);
    expect(a.cg).toBe(b.cg); // the same adapter instance, not a second build
    expect(store.root(root).buildCount).toBe(1);
  });

  it("adopts an index that appeared after root resolution, clearing a dead marker", async () => {
    const r = store.root(root);
    // The index is NOT reported by the nearest-root lookup (it appeared
    // between resolution and preparation), but it exists: the store has
    // its data, so prepareUnderLock must adopt it.
    r.findable = false;
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts", { exports: ["alpha"] });
    // A crashed builder's marker: the peer pid is dead.
    fs.mkdirSync(dir, { recursive: true });
    writeMarker(dir, "build", await deadPid());

    const s = newSession();
    const info = await s.ensureReady(root);
    expect(info.justBuilt).toBeUndefined(); // adopted, not built
    expect(r.buildCount).toBe(0);
    expect(fs.existsSync(path.join(dir, MARKER_NAME))).toBe(false);
    // adopted data is queryable through the adapter
    expect(info.cg.getNodesByName("alpha")).toHaveLength(1);
  });

  it("times out waiting for a live peer's build with the unavailable contract", async () => {
    const r = store.root(root);
    r.findable = false;
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts");

    const peer = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      fs.mkdirSync(dir, { recursive: true });
      writeMarker(dir, "build", peer.pid!);
      // a short injected deadline: the state machine must fail fast with
      // the unavailable contract, not wait 30 minutes
      const s = new CodegraphSession({
        factory: createInMemoryIndexFactory({ store }),
        buildWaitTimeoutMs: 300,
      });
      sessions.push(s);
      const notices: string[] = [];
      s.setUi({ notify: (_level, msg) => notices.push(msg) });
      const t0 = Date.now();
      await expect(s.ensureReady(root)).rejects.toSatisfy((e) =>
        unavailable(e) &&
        e.reason ===
          `timed out waiting for another codegraph process to finish the index`,
      );
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(notices).toContain(
        `codegraph: timed out waiting for the index build at ${root}`,
      );
      // a live build's marker survives the timeout
      expect(fs.existsSync(path.join(dir, MARKER_NAME))).toBe(true);
    } finally {
      peer.kill();
      fs.rmSync(path.join(dir, MARKER_NAME), { force: true });
    }
  });

  it("adopts when the live build finishes", async () => {
    const r = store.root(root);
    r.findable = false;
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts");

    // A peer that finishes: it lives ~250 ms, then its marker reads dead.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"]);
    fs.mkdirSync(dir, { recursive: true });
    writeMarker(dir, "build", child.pid!);
    const s = newSession();
    const info = await s.ensureReady(root);
    expect(info.justBuilt).toBeUndefined();
    expect(r.buildCount).toBe(0);
    expect(fs.existsSync(path.join(dir, MARKER_NAME))).toBe(false);
    expect(info.cg.getFiles()).toHaveLength(1);
  });

  it("reports a failed build with the unavailable contract and drops the instance", async () => {
    const r = store.root(root);
    r.buildOutcome = { success: false, error: "kaboom" };
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    await expect(s.ensureReady(root)).rejects.toSatisfy((e) =>
      unavailable(e) && e.reason === "index build failed: kaboom",
    );
    expect(notices).toContain(`codegraph: index build failed at ${root}: kaboom`);
    expect(r.open).toBe(false); // the dead instance was dropped
    expect(r.buildCount).toBe(1);
  });

  it("re-runs the create path when the database vanishes", async () => {
    const r = store.root(root);
    const s = newSession();
    const first = await s.ensureReady(root);
    expect(first.justBuilt).toBe(true);
    r.dbExists = false; // the database file is gone from under the instance
    const second = await s.ensureReady(root);
    expect(second.justBuilt).toBe(true);
    expect(r.buildCount).toBe(2);
  });
});

describe("reconcile", () => {
  it("fails the first sync with the unavailable contract after the documented retries", async () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts");
    // A held lock: every sync attempt reports zero checked files.
    r.syncResult = {
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: 0,
      durationMs: 1,
    };
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    await expect(s.ensureReady(root)).rejects.toSatisfy((e) =>
      unavailable(e) &&
      e.reason ===
        `could not reconcile the index at ${root}: the codegraph lock is held by another process`,
    );
    // the adapter ran the shared retry contract: initial + 2 retries
    expect(r.syncCount).toBe(3);
    expect(notices).toContain(
      `codegraph: could not reconcile the index at ${root} - the codegraph lock is held by another process`,
    );
  });

  it("reconciles before every query while the watcher is degraded", async () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts");
    r.watchMode = "degraded";
    r.watchReason = "in-memory test";
    const s = newSession();
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    await s.ensureReady(root); // first-use sync
    await s.ensureReady(root); // second sync
    await s.ensureReady(root); // third sync
    expect(r.syncCount).toBe(3);
    expect(notices).toContain(
      "codegraph: file watcher unavailable (in-memory test); the index is reconciled before every query",
    );
  });

  it("does not reconcile between queries while the watcher is active", async () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts");
    const s = newSession();
    await s.ensureReady(root); // first-use sync
    await s.ensureReady(root); // skipped: active watcher
    await s.ensureReady(root); // skipped
    expect(r.syncCount).toBe(1);
  });
});

describe("status", () => {
  it("reports no index when nothing exists", () => {
    const s = newSession();
    const st = s.statusFor(root);
    expect(st.needsCreate).toBe(true);
    expect(st.instanceOpen).toBe(false);
    expect(st.indexState).toBeNull();
    expect(st.watcher).toBe("off");
    expect(st.stats).toBeUndefined();
  });

  it("reads the on-disk counts and state through the adapter", () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "partial";
    r.addFile("src/a.ts");
    r.addFile("src/b.ts", { exports: ["alpha"] });
    const s = newSession();
    const st = s.statusFor(root);
    expect(st.instanceOpen).toBe(false);
    expect(st.indexState).toBe("partial");
    expect(st.stats).toEqual({
      fileCount: 2,
      nodeCount: 1,
      edgeCount: 0,
      indexState: "partial",
    });
    r.unreadableDb = true;
    const st2 = s.statusFor(root);
    expect(st2.stats).toBeUndefined();
    expect(st2.indexState).toBeNull();
  });

  it("reports the open instance and its stats", async () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts", { exports: ["alpha"] });
    const s = newSession();
    await s.ensureReady(root);
    const st = s.statusFor(root);
    expect(st.instanceOpen).toBe(true);
    expect(st.needsCreate).toBe(false);
    expect(st.indexState).toBe("complete");
    expect(st.stats).toEqual(
      expect.objectContaining({ fileCount: 1, nodeCount: 1, edgeCount: 0 }),
    );
  });
});

describe("the query surface", () => {
  it("serves the renderers' data through the adapter", async () => {
    const r = store.root(root);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts", { exports: ["alpha", "beta"] });
    const s = newSession();
    const info = await s.ensureReady(root);
    expect(info.cg.getNodesByName("alpha")).toHaveLength(1);
    expect(info.cg.searchNodes("alpha")).toHaveLength(1);
    expect(info.cg.getFiles()).toHaveLength(1);
    expect(info.cg.getStats().nodeCount).toBe(2);
  });
});

describe("runtime compatibility", () => {
  it("classifies a preflight failure as the runtime gap when matched", async () => {
    const s = newSession({
      preflightResult: { ok: false, reason: "node:sqlite is not available" },
      gapMatcher: (err) =>
        /node:sqlite/.test(String(err)) ? "the runtime sqlite gap reason" : undefined,
    });
    const notices: string[] = [];
    s.setUi({ notify: (_level, msg) => notices.push(msg) });
    await expect(s.ensureReady(root)).rejects.toSatisfy((e) =>
      unavailable(e) && e.reason === "the runtime sqlite gap reason",
    );
  });
});

describe("named roots (spec 0009)", () => {
  // The named trees live OUTSIDE the session root's manifest tree, so the
  // normal root policy never snaps them up to the session root.
  let outside: string;
  let trusted: string;

  beforeEach(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-named-"));
    trusted = path.join(outside, "trusted");
    fs.mkdirSync(trusted, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /** A manifest-carrying dependency tree with one indexable file. */
  function makeDep(name: string, parent: string = trusted): string {
    const dep = path.join(parent, name);
    fs.mkdirSync(path.join(dep, "src"), { recursive: true });
    fs.writeFileSync(path.join(dep, "package.json"), "{}");
    fs.writeFileSync(path.join(dep, "src", "a.ts"), "export const a = 1;\n");
    return dep;
  }

  function withTrusted(
    extra: Partial<ConstructorParameters<typeof CodegraphSession>[0]> = {},
  ): CodegraphSession {
    const s = new CodegraphSession({
      factory: createInMemoryIndexFactory({ store }),
      trustedRoots: [{ root: trusted, origin: "CODEGRAPH_PI_TRUSTED_ROOTS" }],
      ...extra,
    });
    sessions.push(s);
    return s;
  }

  it("builds an index for a named root under a trusted root", async () => {
    const dep = makeDep("depA");
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    const info = await s.ensureReady(root, undefined, dep);
    expect(info.root).toBe(depReal);
    expect(info.justBuilt).toBe(true);
    expect(info.named).toBe(true);
    expect(store.root(depReal).buildCount).toBe(1);
  });

  it("caches the named root's instance across calls", async () => {
    const dep = makeDep("depA");
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    const a = await s.ensureReady(root, undefined, dep);
    const b = await s.ensureReady(root, undefined, dep);
    expect(b.cg).toBe(a.cg);
    expect(b.justBuilt).toBeUndefined();
    expect(store.root(depReal).buildCount).toBe(1);
  });

  it("refuses a build outside every trusted root, writing nothing", async () => {
    const dep = makeDep("depB", outside);
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    await expect(s.ensureReady(root, undefined, dep)).rejects.toSatisfy((e) =>
      unavailable(e) &&
        e.noLedger &&
        e.reason ===
          `refusing to build an index outside a trusted root (${depReal}) ` +
            `- ask the user to run /codegraph add ${depReal}`,
    );
    // The refusal writes nothing: no index directory, no build, no instance.
    expect(fs.existsSync(path.join(dep, IN_MEMORY_DIR_NAME))).toBe(false);
    expect(store.root(depReal).dirExists).toBe(false);
    expect(store.root(depReal).buildCount).toBe(0);
  });

  it("serves an existing index outside every trusted root without a build", async () => {
    const dep = makeDep("depC", outside);
    const depReal = fs.realpathSync(dep);
    const r = store.root(depReal);
    r.dirExists = true;
    r.dbExists = true;
    r.indexState = "complete";
    r.addFile("src/a.ts", { exports: ["alpha"] });
    const s = withTrusted();
    const info = await s.ensureReady(root, undefined, dep);
    expect(info.root).toBe(depReal);
    expect(info.justBuilt).toBeUndefined();
    expect(r.buildCount).toBe(0);
    expect(info.cg.getNodesByName("alpha")).toHaveLength(1);
  });

  it("starts no watcher on a named root and reconciles before every query", async () => {
    const dep = makeDep("depD");
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    await s.ensureReady(root, undefined, dep); // build; the build is current
    const r = store.root(depReal);
    expect(r.watchOptions).toBeUndefined(); // no watcher on a dependency source
    expect(r.syncCount).toBe(0);
    await s.ensureReady(root, undefined, dep); // reconciled: no watcher
    await s.ensureReady(root, undefined, dep); // and again: before every query
    expect(r.syncCount).toBe(2);
  });

  it("serves a file argument relative to the named root and refuses an escape", async () => {
    const dep = makeDep("depE");
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    const info = await s.ensureReady(root, "src/a.ts", dep);
    expect(info.root).toBe(depReal);
    expect(info.file).toBe("src/a.ts");
    const outsideFile = path.join(root, "src", "a.ts");
    await expect(
      s.ensureReady(root, outsideFile, dep),
    ).rejects.toSatisfy((e) =>
      unavailable(e) &&
        e.noLedger &&
        e.reason ===
          `file ${outsideFile} is outside the named project root (${depReal})`,
    );
  });

  it("fails with the exact message for a missing directory", async () => {
    const s = withTrusted();
    const missing = path.join(outside, "missing");
    await expect(
      s.ensureReady(root, undefined, missing),
    ).rejects.toSatisfy((e) =>
      unavailable(e) && e.noLedger && e.reason === `no such directory (${missing})`,
    );
  });

  it("names a fetch hint for a missing directory under a symlinked trusted root", async () => {
    // The trusted root is stored on its real path; the argument arrives
    // through a symlink. The hint's trust check must compare where the
    // directory will live, not the logical form it arrived in.
    const link = path.join(outside, "link");
    fs.symlinkSync(trusted, link);
    const s = withTrusted({
      opensrc: createOpenSrc(trusted, {
        list: () => ({
          packages: [
            { name: "zeta", version: "1.0.0", path: "zeta/1.0.0" },
          ],
        }),
      }),
    });
    const missing = path.join(link, "zeta", "1.0.0");
    await expect(
      s.ensureReady(root, undefined, missing),
    ).rejects.toSatisfy((e) =>
      unavailable(e) &&
        e.noLedger &&
        e.reason ===
          `no such directory (${missing}) - the source is not cached; ` +
            "ask the user to run: opensrc fetch zeta",
    );
  });

  it("lets auto off block a named build", async () => {
    const dep = makeDep("depF");
    const s = withTrusted({ autoIndex: false });
    await expect(s.ensureReady(root, undefined, dep)).rejects.toSatisfy((e) =>
      unavailable(e) &&
        e.reason ===
          "auto-index is off for this session (enable it with /codegraph auto on)",
    );
    expect(fs.existsSync(path.join(dep, IN_MEMORY_DIR_NAME))).toBe(false);
  });

  it("snaps a named directory inside a cache entry to the entry's tree", async () => {
    const home = path.join(outside, "cache");
    const entry = path.join(home, "packages", "alpha", "1.0.0");
    fs.mkdirSync(path.join(entry, "src"), { recursive: true });
    fs.writeFileSync(path.join(entry, "package.json"), "{}");
    fs.writeFileSync(path.join(entry, "src", "lib.ts"), "export const lib = 1;\n");
    const homeReal = fs.realpathSync(home);
    const entryReal = fs.realpathSync(entry);
    const s = new CodegraphSession({
      factory: createInMemoryIndexFactory({ store }),
      trustedRoots: [{ root: homeReal, origin: "OPENSRC_HOME" }],
      opensrc: createOpenSrc(home, {
        list: () => ({
          packages: [
            { name: "alpha", version: "1.0.0", path: "packages/alpha/1.0.0" },
          ],
        }),
        manifestStat: () => undefined,
      }),
    });
    sessions.push(s);
    const info = await s.ensureReady(root, undefined, path.join(entry, "src"));
    expect(info.root).toBe(entryReal); // snapped up to the entry's tree
    expect(info.justBuilt).toBe(true);
    expect(info.named).toBe(true);
    expect(store.root(entryReal).buildCount).toBe(1);
  });

  it("closes a named root's instance on shutdown", async () => {
    const dep = makeDep("depG");
    const depReal = fs.realpathSync(dep);
    const s = withTrusted();
    await s.ensureReady(root, undefined, dep);
    expect(store.root(depReal).open).toBe(true);
    s.closeAll();
    expect(store.root(depReal).open).toBe(false);
  });

  it("seed with no argument keeps the legacy sibling form", async () => {
    const s = withTrusted();
    expect(await s.seedTargetFor(root, undefined)).toEqual({});
  });

  it("seed with a path that is not a sibling targets a named root", async () => {
    const dep = makeDep("depH");
    const s = withTrusted();
    expect(await s.seedTargetFor(root, dep)).toEqual({ projectRoot: dep });
  });
});
