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
