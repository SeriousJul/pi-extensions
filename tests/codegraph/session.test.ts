import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodeGraph,
  getCodeGraphDir,
  getDatabasePath,
} from "@colbymchenry/codegraph";
import shim from "../../extensions/codegraph/sqlite-shim.cjs";
import { buildFixture, type Fixture } from "./fixture";
import { CodegraphSession } from "../../extensions/codegraph/session";
import {
  CodegraphUnavailable,
  resolveRoot,
  unsafeRootReason,
} from "../../extensions/codegraph/root";
import { listWorktrees } from "../../extensions/codegraph/git";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

let fixture: Fixture;
const sessions: CodegraphSession[] = [];

beforeEach(() => {
  fixture = buildFixture();
});

afterEach(() => {
  for (const s of sessions.splice(0)) s.closeAll();
  fixture.cleanup();
});

function newSession(
  opts: ConstructorParameters<typeof CodegraphSession>[0] = {},
): CodegraphSession {
  const s = new CodegraphSession(opts);
  sessions.push(s);
  return s;
}

function nodeNames(cg: CodeGraph): string[] {
  return cg
    .getFiles()
    .flatMap((f) => cg.getNodesInFile(f.path))
    .map((n) => `${n.filePath}:${n.name}`)
    .sort();
}

describe("ensureReady (primary seam)", () => {
  it("builds an index from scratch when no sibling has one", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.feature);
    expect(info.root).toBe(fixture.feature);
    expect(info.justBuilt).toBe(true);
    expect(info.justSeeded).toBeUndefined();
    expect(info.cg.getProjectRoot()).toBe(fixture.feature);
    expect(info.cg.getNodesByName("featureOnlySymbol").length).toBeGreaterThan(0);
    expect(info.cg.getNodesByName("helper").length).toBeGreaterThan(0);
  });

  it("seeds from an indexed sibling and reconciles to the worktree's own tree", async () => {
    const builder = newSession();
    const main = await builder.ensureReady(fixture.main);
    expect(main.justBuilt).toBe(true);
    const mainNodes = nodeNames(main.cg);
    expect(mainNodes).not.toContain("src/feature.ts:featureOnlySymbol");

    // A fresh session sees the seeded index.
    const s = newSession();
    const info = await s.ensureReady(fixture.feature);
    expect(info.root).toBe(fixture.feature);
    expect(info.justSeeded).toBeDefined();
    expect(info.justSeeded?.source).toBe(fixture.main);

    const cg = info.cg;
    // Reconcile converged the seed to the feature branch's tree.
    expect(cg.getNodesByName("featureOnlySymbol").length).toBeGreaterThan(0);
    expect(cg.getNodesByName("helper").length).toBeGreaterThan(0);
    // The modified main.ts was picked up: mainEntry now calls
    // featureOnlySymbol, which the sibling's stale copy never did.
    const mainEntry = cg.getNodesByName("mainEntry")[0];
    const callees = cg.getCallees(mainEntry.id).map((r) => r.node.name);
    expect(callees).toContain("featureOnlySymbol");
    // A sibling-only file (src/mainonly.ts, committed on main after the
    // feature branch was cut) must be reconciled OUT of the seeded index:
    // a query run from a worktree never answers from another worktree's
    // files.
    expect(cg.getNodesByName("mainOnlySymbol").length).toBe(0);
    expect(cg.getFiles().some((f) => f.path === "src/mainonly.ts")).toBe(
      false,
    );
    // Sibling-only state did not leak into main.
    expect(nodeNames(main.cg)).toEqual(mainNodes);
  });

  it("converges a seeded index to the same node and edge set as a from-scratch build", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    // feature2: a detached worktree at the same commit as `feature`.
    const feature2 = path.join(fixture.base, "feature2");
    git(fixture.main, ["worktree", "add", "-q", "--detach", feature2, "feature"]);

    const seeded = newSession();
    const seededInfo = await seeded.ensureReady(fixture.feature);
    expect(seededInfo.justSeeded).toBeDefined();

    const scratch = newSession({ seeding: false });
    const scratchInfo = await scratch.ensureReady(feature2);
    expect(scratchInfo.justBuilt).toBe(true);

    expect(nodeNames(seededInfo.cg)).toEqual(nodeNames(scratchInfo.cg));
    expect(seededInfo.cg.getStats().edgeCount).toBe(
      scratchInfo.cg.getStats().edgeCount,
    );
    git(fixture.main, ["worktree", "remove", "--force", feature2]);
  });

  it("recovers an incomplete sibling index through the post-seed reconcile", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    // Simulate an interrupted build: the sibling's database lost a file's
    // index (its rows and its files-table entry), as if the process died
    // mid-extraction.
    const db = new shim.DatabaseSync(getDatabasePath(fixture.main));
    db.exec("DELETE FROM files WHERE path LIKE '%shared.ts'");
    db.exec("DELETE FROM nodes WHERE file_path LIKE '%shared.ts' OR name = 'ANSWER'");
    db.close();

    const s = newSession();
    const info = await s.ensureReady(fixture.feature);
    expect(info.justSeeded).toBeDefined();
    // The reconcile re-walked the tree and restored the missing symbol.
    expect(info.cg.getNodesByName("ANSWER").length).toBeGreaterThan(0);
  });

  it("runs one build for concurrent calls in the same process", async () => {
    const s = newSession();
    const p1 = s.ensureReady(fixture.feature);
    const p2 = s.ensureReady(fixture.feature);
    const [a, b] = await Promise.all([p1, p2]);
    // Both calls share the single build and the cached instance. If two
    // builds had run, the second would have failed on the file lock.
    expect(a.cg).toBe(b.cg);
    expect(a.justBuilt).toBe(true);
  });

  it("waits for another live process's build before adopting", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    // An uninitialized sibling worktree that another "process" is building.
    const other = path.join(fixture.base, "other");
    git(fixture.main, ["worktree", "add", "-q", "--detach", other, "HEAD"]);
    const init = await CodeGraph.init(other);
    init.close();

    // A real live child process owns the build marker and exits after ~2s.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"]);
    fs.writeFileSync(
      path.join(getCodeGraphDir(other), "pi-codegraph-build.json"),
      JSON.stringify({
        pid: child.pid,
        startedAt: Date.now(),
        mode: "build",
      }),
    );

    const s = newSession();
    const started = Date.now();
    const info = await s.ensureReady(other);
    const elapsed = Date.now() - started;
    child.kill();

    // It blocked until the marker's owner process exited, then adopted the
    // on-disk state and reconciled it.
    expect(elapsed).toBeGreaterThan(1500);
    expect(info.cg.getProjectRoot()).toBe(other);
    expect(info.cg.getNodesByName("helper").length).toBeGreaterThan(0);
    expect(
      fs.existsSync(
        path.join(getCodeGraphDir(other), "pi-codegraph-build.json"),
      ),
    ).toBe(false);
    git(fixture.main, ["worktree", "remove", "--force", other]);
  }, 120_000);

  it("re-seeds a worktree that was removed and re-added on another branch", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    const s = newSession();
    const first = await s.ensureReady(fixture.feature);
    expect(first.cg.getNodesByName("featureOnlySymbol").length).toBeGreaterThan(0);

    // Remove and re-add the worktree, detached at the main commit.
    git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);
    git(fixture.main, ["worktree", "add", "-q", "--detach", fixture.feature, "HEAD"]);

    const second = await s.queryReady(fixture.feature);
    expect(second.cg.getNodesByName("featureOnlySymbol").length).toBe(0);
    expect(second.cg.getNodesByName("helper").length).toBeGreaterThan(0);
  });

  it("reopens a replaced index file when the worktree is re-added with its index", async () => {
    const s = newSession();
    const first = await s.ensureReady(fixture.feature);
    expect(first.cg.getNodesByName("featureOnlySymbol").length).toBeGreaterThan(0);

    // Add a new file on the branch.
    fs.writeFileSync(
      path.join(fixture.feature, "src/added.ts"),
      "export function addedLate(): number { return 7; }\n",
    );
    git(fixture.feature, ["add", "-A"]);
    git(fixture.feature, ["commit", "-q", "-m", "add"]);

    // Preserve the index across remove + re-add (same path, new inode).
    const preserved = path.join(fixture.base, "preserved-codegraph");
    fs.cpSync(getCodeGraphDir(fixture.feature), preserved, { recursive: true });
    git(fixture.main, ["worktree", "remove", "--force", fixture.feature]);
    git(fixture.main, ["worktree", "add", "-q", fixture.feature, "feature"]);
    fs.cpSync(preserved, getCodeGraphDir(fixture.feature), { recursive: true });
    fs.rmSync(preserved, { recursive: true, force: true });

    const second = await s.queryReady(fixture.feature);
    expect(second.cg.getNodesByName("addedLate").length).toBe(1);
    expect(second.cg.getNodesByName("featureOnlySymbol").length).toBeGreaterThan(0);
  });

  it("serves the worktree's own index, never a sibling's", async () => {
    const builder = newSession();
    await builder.ensureReady(fixture.main);

    const resolved = resolveRoot(fixture.feature);
    expect(resolved.root).toBe(fixture.feature);
    expect(resolved.needsCreate).toBe(true);

    const s = newSession();
    const info = await s.ensureReady(fixture.feature);
    expect(info.root).toBe(fixture.feature);
    expect(info.cg.getProjectRoot()).toBe(fixture.feature);
  });

  it("resolves a sub-directory of the worktree to the worktree's index", async () => {
    const s = newSession();
    const info = await s.ensureReady(path.join(fixture.main, "src"));
    expect(info.root).toBe(fixture.main);
    expect(info.cg.getProjectRoot()).toBe(fixture.main);
  });

  it("throws CodegraphUnavailable with a reason when auto-index is off", async () => {
    const s = newSession({ autoIndex: false });
    await expect(s.ensureReady(fixture.feature)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodegraphUnavailable &&
        err.reason.includes("auto-index"),
    );
  });
});

describe("root resolution", () => {
  it("reports the main checkout as main", () => {
    const resolved = resolveRoot(fixture.main);
    expect(resolved.isMainCheckout).toBe(true);
    expect(resolved.mainCheckout).toBe(fixture.main);
    expect(resolved.needsCreate).toBe(true);
  });

  it("reports a linked worktree with its main checkout path", () => {
    const resolved = resolveRoot(fixture.feature);
    expect(resolved.isMainCheckout).toBe(false);
    expect(resolved.mainCheckout).toBe(fixture.main);
  });

  it("falls back to the nearest build manifest outside git", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-plain-"));
    fs.mkdirSync(path.join(base, "proj", "src"), { recursive: true });
    fs.writeFileSync(path.join(base, "proj", "package.json"), "{}");
    const resolved = resolveRoot(path.join(base, "proj", "src"));
    expect(resolved.root).toBe(path.join(base, "proj"));
    expect(resolved.needsCreate).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("rejects the home directory and filesystem root as index roots", () => {
    expect(unsafeRootReason(os.homedir())).toBeDefined();
    expect(unsafeRootReason("/")).toBeDefined();
    expect(unsafeRootReason(os.tmpdir())).toBeUndefined();
  });

  it("throws when no project can be found", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-empty-"));
    expect(() => resolveRoot(empty)).toThrow(CodegraphUnavailable);
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe("git helpers", () => {
  it("lists worktrees of the repository", () => {
    const worktrees = listWorktrees(fixture.main);
    expect(worktrees.map((w) => w.path)).toEqual([
      fixture.main,
      fixture.feature,
    ]);
    const branch = gitOut(fixture.main, ["branch", "--show-current"]);
    expect(worktrees[0].branch).toBe(`refs/heads/${branch}`);
  });
});

describe("watcher disabled (CODEGRAPH_NO_WATCH=1)", () => {
  it("reconciles before every query and warns once", async () => {
    process.env.CODEGRAPH_NO_WATCH = "1";
    const notices: string[] = [];
    try {
      const s = newSession();
      s.setUi({ notify: (_level, message) => notices.push(message) });

      await s.ensureReady(fixture.main);
      expect(notices).toContain(
        "codegraph: file watcher disabled on this filesystem (CODEGRAPH_NO_WATCH=1); the index is reconciled before every query",
      );

      // Without a watcher, the pre-query reconcile must pick up new files
      // before serving every query, not just the first one.
      fs.writeFileSync(
        path.join(fixture.main, "src", "late1.ts"),
        "export function lateSymbolOne(): number { return 1; }\n",
      );
      const second = await s.queryReady(fixture.main);
      expect(second.cg.getNodesByName("lateSymbolOne").length).toBe(1);

      fs.writeFileSync(
        path.join(fixture.main, "src", "late2.ts"),
        "export function lateSymbolTwo(): number { return 2; }\n",
      );
      const third = await s.queryReady(fixture.main);
      expect(third.cg.getNodesByName("lateSymbolTwo").length).toBe(1);

      // The notice is one-time across the whole session.
      expect(
        notices.filter((m) => m.includes("file watcher disabled")),
      ).toHaveLength(1);
    } finally {
      delete process.env.CODEGRAPH_NO_WATCH;
    }
  });
});

describe("manual seed guard", () => {
  // The end-to-end refusal needs the home directory pointed at a fixture
  // worktree: os.homedir() honors $HOME on Node but not on bun, so this
  // runs on Node only. The unsafe-root detection itself is covered by the
  // root-resolution test ("rejects the home directory and filesystem
  // root") on every runtime, and the reseed guard calls the same
  // unsafeRootReason the auto path uses.
  it.skipIf(Boolean(process.versions.bun))("refuses to seed at an unsafe root (the home directory)", async () => {
    const savedHome = process.env.HOME;
    process.env.HOME = fixture.main;
    try {
      const s = newSession();
      await expect(s.reseed(fixture.main)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof CodegraphUnavailable &&
          err.reason.includes("refusing to index the home directory"),
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
