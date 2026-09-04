/**
 * Staleness gate tests (upstream isFileStaleOnDisk, issue #1474).
 *
 * The renderers slice CURRENT on-disk bytes at INDEXED line ranges. When a
 * file changes after the last index sync, that slice can be a different
 * symbol's code served under the requested name, so the renderers must
 * detect the drift at emission and never emit a slice from a drifted file.
 *
 * Every test here runs with the watcher disabled and calls the renderers
 * directly on a real session-built index: a file edited after the build
 * stays exactly one sync behind (the real stale window) and nothing can
 * heal the indexed record between the edit and the render, so the
 * behavior is deterministic on every runtime.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildFixture, type Fixture } from "./fixture";
import { CodegraphSession } from "../../extensions/codegraph/session";
import {
  clearDriftCache,
  isFileStaleOnDisk,
  STALE_WHOLE_FILE_MAX_LINES,
} from "../../extensions/codegraph/staleness";
import { renderExplore, renderSymbol } from "../../extensions/codegraph/format";

let fixture: Fixture;
const sessions: CodegraphSession[] = [];

beforeEach(() => {
  fixture = buildFixture();
  process.env.CODEGRAPH_NO_WATCH = "1";
  clearDriftCache();
});

afterEach(() => {
  delete process.env.CODEGRAPH_NO_WATCH;
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

/** 350-line file: above the stale whole-file cap, below nothing else. */
function writeBigFile(dir: string): string {
  const p = path.join(dir, "src", "big.ts");
  fs.writeFileSync(
    p,
    Array.from(
      { length: STALE_WHOLE_FILE_MAX_LINES + 50 },
      (_, i) => `export function bigFn${i}(): number { return ${i}; }`,
    ).join("\n") + "\n",
  );
  return p;
}

describe("isFileStaleOnDisk", () => {
  it("reports a fresh file as not stale", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    expect(isFileStaleOnDisk(info.cg, info.root, "src/main.ts")).toBe(false);
  });

  it("reports a file edited after the last sync as stale", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    fs.appendFileSync(
      path.join(fixture.main, "src/main.ts"),
      "export function lateEdit(): number { return 1; }\n",
    );
    clearDriftCache();
    expect(isFileStaleOnDisk(info.cg, info.root, "src/main.ts")).toBe(true);
    // Other files of the same index are unaffected.
    expect(isFileStaleOnDisk(info.cg, info.root, "src/shared.ts")).toBe(false);
  });

  it("does not false-positive when identical bytes are rewritten", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const p = path.join(fixture.main, "src/main.ts");
    const content = fs.readFileSync(p, "utf-8");
    const st = fs.statSync(p);
    fs.writeFileSync(p, content);
    // Move the mtime well away from the indexed record, so the stat fast
    // path misses and the content hash must rescue the file.
    fs.utimesSync(p, st.atime, new Date(st.mtimeMs - 10_000));
    clearDriftCache();
    expect(isFileStaleOnDisk(info.cg, info.root, "src/main.ts")).toBe(false);
  });

  it("reports false for a deleted file (the not-found path handles it)", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    fs.rmSync(path.join(fixture.main, "src/main.ts"));
    clearDriftCache();
    expect(isFileStaleOnDisk(info.cg, info.root, "src/main.ts")).toBe(false);
  });

  it("reports false for an on-disk file that has no indexed record", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    fs.writeFileSync(
      path.join(fixture.main, "src/untracked.ts"),
      "export function untrackedFn(): number { return 2; }\n",
    );
    clearDriftCache();
    // No files-table row (no sync ran): the gate says false, and the
    // not-found paths - not the staleness flag - handle the lookup.
    expect(isFileStaleOnDisk(info.cg, info.root, "src/untracked.ts")).toBe(
      false,
    );
  });
});

describe("renderers on a drifted file", () => {
  it("symbol mode serves the full current source, not a slice, for a drifted small file", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    // Drift: prepend lines so the indexed range of mainEntry (line 3) now
    // points at the inserted code.
    const p = path.join(fixture.main, "src/main.ts");
    const current = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(p, "// drifted edit one\n// drifted edit two\n" + current);
    clearDriftCache();

    const text = renderSymbol(info.cg, info.root, "mainEntry", true);
    expect(text).toContain("stale");
    expect(text).toContain("changed on disk after the last index sync");
    // The full CURRENT source (Read-parity), numbered from line 1.
    expect(text).toContain("1\t// drifted edit one");
    expect(text).toContain("2\t// drifted edit two");
    expect(text).toContain("export function mainEntry");
    // The index trail is still served: it is the index's answer.
    expect(text).toContain("Top callers");
    expect(text).toContain("Top callees");
  });

  it("symbol mode omits the body with a notice for a drifted large file", async () => {
    const bigPath = writeBigFile(fixture.main);
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const current = fs.readFileSync(bigPath, "utf-8");
    fs.writeFileSync(
      bigPath,
      "export function bigDrift(): number { return -1; }\n" + current,
    );
    clearDriftCache();

    const text = renderSymbol(info.cg, info.root, "bigFn7", true);
    expect(text).toContain("stale");
    expect(text).toContain("The symbol body is omitted");
    // No stale slice: bigFn7's indexed line (8) now holds bigFn8's code
    // after the insert; that line must not appear under bigFn7's name.
    expect(text).not.toContain("export function bigFn8");
    expect(text).not.toContain("export function bigDrift");
  });

  it("explore omits the slice of a drifted large file with a notice", async () => {
    const bigPath = writeBigFile(fixture.main);
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const current = fs.readFileSync(bigPath, "utf-8");
    fs.writeFileSync(
      bigPath,
      "export function bigDrift(): number { return -1; }\n" + current,
    );
    clearDriftCache();

    const text = await renderExplore(info.cg, info.root, "bigFn7", 12);
    expect(text).toContain("## src/big.ts");
    expect(text).toContain("stale");
    expect(text).toContain("source omitted");
    expect(text).not.toContain("export function bigFn8");
    expect(text).not.toContain("export function bigDrift");
  });

  it("explore serves the full current source for a drifted small file", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const p = path.join(fixture.main, "src/main.ts");
    const current = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(p, "// drifted edit one\n" + current);
    clearDriftCache();

    const text = await renderExplore(info.cg, info.root, "mainEntry", 12);
    expect(text).toContain("## src/main.ts");
    expect(text).toContain("stale");
    expect(text).toContain("1\t// drifted edit one");
    // The call path (index facts) is still served.
    expect(text).toContain("Call paths:");
  });

  it("serves slices as usual when nothing drifted", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const text = renderSymbol(info.cg, info.root, "mainEntry", true);
    expect(text).not.toContain("stale");
    expect(text).toContain("3\texport function mainEntry");
  });
});
