/**
 * Source-section tests (spec 0005: one module owns the trustworthy
 * source section).
 *
 * Three seams of one module:
 *  - the drift gate, tested directly: the stat/mtime/hash precision is
 *    the part with the subtle failure modes.
 *  - the section entry: the contract - the kind of section a file gets.
 *  - the renderers, at their existing seam: presentation - wording,
 *    output shape, and the index trail.
 *
 * Every test here runs with the watcher disabled and calls the entry or
 * the renderers directly on a real session-built index: a file edited
 * after the build stays exactly one sync behind (the real stale window)
 * and nothing can heal the indexed record between the edit and the
 * render, so the behavior is deterministic on every runtime.
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
  sourceSection,
  STALE_WHOLE_FILE_MAX_LINES,
} from "../../extensions/codegraph/sourceSection";
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

describe("sourceSection", () => {
  it("returns the exact slice at the indexed ranges for a fresh file", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const section = sourceSection(info.cg, info.root, "src/main.ts", [[3, 5]]);
    expect(section).toEqual({
      kind: "slice",
      lines: [
        "3\texport function mainEntry(): number {",
        "4\t  return helper(1);",
        "5\t}",
      ],
    });
  });

  it("returns one slice per range, in the given order", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const section = sourceSection(info.cg, info.root, "src/shared.ts", [
      [1, 1],
      [3, 5],
    ]);
    expect(section).toEqual({
      kind: "slice",
      lines: [
        "1\texport const ANSWER = 42;",
        "3\texport function helper(x: number): number {",
        "4\t  return x + ANSWER;",
        "5\t}",
      ],
    });
  });

  it("returns the full current source for a small drifted file", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    // Drift: prepend lines so the indexed range of mainEntry (line 3) now
    // points at the inserted code.
    const p = path.join(fixture.main, "src/main.ts");
    const current = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(p, "// drifted edit one\n// drifted edit two\n" + current);
    clearDriftCache();

    const section = sourceSection(info.cg, info.root, "src/main.ts", [[3, 5]]);
    expect(section.kind).toBe("whole");
    if (section.kind !== "whole") return;
    // Numbered from line 1 over the CURRENT bytes, not a slice at the
    // shifted indexed range.
    expect(section.lines[0]).toBe("1\t// drifted edit one");
    expect(section.lines[1]).toBe("2\t// drifted edit two");
    expect(section.lines).toEqual([
      "1\t// drifted edit one",
      "2\t// drifted edit two",
      '3\timport { helper } from "./shared";',
      "4\t",
      "5\texport function mainEntry(): number {",
      "6\t  return helper(1);",
      "7\t}",
    ]);
  });

  it("returns omitted for a large drifted file", async () => {
    const bigPath = writeBigFile(fixture.main);
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const current = fs.readFileSync(bigPath, "utf-8");
    fs.writeFileSync(
      bigPath,
      "export function bigDrift(): number { return -1; }\n" + current,
    );
    clearDriftCache();

    const section = sourceSection(info.cg, info.root, "src/big.ts", [[8, 8]]);
    // Beyond the whole-file caps: no source at all, so no stale line can
    // appear under bigFn7's name (its indexed line 8 now holds bigFn8's
    // code after the insert).
    expect(section).toEqual({ kind: "omitted" });
  });

  it("returns missing for a file gone from disk", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    fs.rmSync(path.join(fixture.main, "src/main.ts"));
    clearDriftCache();

    const section = sourceSection(info.cg, info.root, "src/main.ts", [[3, 5]]);
    expect(section).toEqual({ kind: "missing" });
  });

  it("returns a slice when identical bytes are rewritten (the hash rescues it)", async () => {
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

    const section = sourceSection(info.cg, info.root, "src/main.ts", [[3, 5]]);
    expect(section).toEqual({
      kind: "slice",
      lines: [
        "3\texport function mainEntry(): number {",
        "4\t  return helper(1);",
        "5\t}",
      ],
    });
  });
});

describe("renderers on a drifted file", () => {
  it("symbol mode keeps its stale and whole wording, and serves the index trail", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    // Drift: prepend lines so the indexed range of mainEntry (line 3) now
    // points at the inserted code.
    const p = path.join(fixture.main, "src/main.ts");
    const current = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(p, "// drifted edit one\n// drifted edit two\n" + current);
    clearDriftCache();

    const text = renderSymbol(info.cg, info.root, "mainEntry", true);
    expect(text).toContain(
      "  (stale: src/main.ts changed on disk after the last index sync; the line above may have shifted)",
    );
    expect(text).toContain(
      "  Full CURRENT source of the file instead of a slice (treat it as already read):",
    );
    // The index trail is still served: it is the index's answer.
    expect(text).toContain("Top callers");
    expect(text).toContain("Top callees");
  });

  it("symbol mode keeps its omitted wording, and serves the index trail", async () => {
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
    expect(text).toContain(
      "  (stale: src/big.ts changed on disk after the last index sync; the line above may have shifted)",
    );
    expect(text).toContain("The symbol body is omitted");
    expect(text).toContain("The change is picked up on the next index reconcile.");
    expect(text).toContain("Top callers");
    expect(text).toContain("Top callees");
  });

  it("explore keeps its stale and whole wording, and serves the call path section", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const p = path.join(fixture.main, "src/main.ts");
    const current = fs.readFileSync(p, "utf-8");
    fs.writeFileSync(p, "// drifted edit one\n" + current);
    clearDriftCache();

    const text = await renderExplore(info.cg, info.root, "mainEntry", 12);
    expect(text).toContain("## src/main.ts");
    expect(text).toContain(
      "  (stale: changed on disk after the last index sync; the full CURRENT source is shown instead of a slice, and symbol positions may have shifted)",
    );
    // The call path (index facts) is still served.
    expect(text).toContain("Call paths:");
  });

  it("explore keeps its omitted wording", async () => {
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
    expect(text).toContain(
      "  (stale: changed on disk after the last index sync - source omitted, the indexed line ranges no longer match. Read the file directly for current content; the change is picked up on the next index reconcile.)",
    );
  });

  it("serves slices as usual when nothing drifted", async () => {
    const s = newSession();
    const info = await s.ensureReady(fixture.main);
    const text = renderSymbol(info.cg, info.root, "mainEntry", true);
    expect(text).not.toContain("stale");
    expect(text).toContain("3\texport function mainEntry");
  });
});
