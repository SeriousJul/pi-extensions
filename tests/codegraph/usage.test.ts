/**
 * The usage ledger reader (spec 0007), pinned at its own module seam: lines are
 * written with `appendUsage` and read back as a summary, exactly as
 * /codegraph status reads it.
 *
 * The behaviors that matter here are the ones a crash and a long-lived worktree
 * produce: a torn or malformed line must not make status unreadable, must not be
 * counted twice once it is completed, and must not cost a full reparse of the
 * history. Counts are cumulative across reads and sessions, and the failure
 * status shows is the newest failure by the clock, not the last line written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendUsage,
  readUsage,
  IGNORE_NAME,
  USAGE_NAME,
  type UsageRecord,
} from "../../extensions/codegraph/usage";

let dir: string;
let file: string;

function writeLines(lines: string[]): void {
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf-8");
}

function line(
  overrides: Partial<UsageRecord> & Pick<UsageRecord, "ts" | "tool" | "ok">,
): string {
  const record: UsageRecord = {
    ts: overrides.ts,
    tool: overrides.tool,
    ok: overrides.ok,
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    duration_ms: overrides.duration_ms ?? 5,
    chars: overrides.chars ?? 10,
  };
  return JSON.stringify(record);
}

/** Append a fragment with no line terminator, as a crash mid-write leaves it. */
function appendRaw(text: string): void {
  fs.appendFileSync(file, text, "utf-8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-usage-"));
  file = path.join(dir, USAGE_NAME);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readUsage", () => {
  it("is empty when no ledger exists", () => {
    expect(readUsage(dir)).toEqual({ ok: 0, failed: 0, toolCounts: {} });
  });

  it("keeps the fold's clock order out of the public summary", () => {
    // `lastFailure` is the public contract; the timestamp it was chosen by is
    // fold bookkeeping inside the reader, not something the status shows.
    appendUsage(dir, {
      tool: "codegraph_search",
      ok: false,
      reason: "boom",
      duration_ms: 1,
      chars: 0,
    });
    expect(Object.keys(readUsage(dir)).sort()).toEqual([
      "failed",
      "lastAt",
      "lastFailure",
      "ok",
      "toolCounts",
    ]);
  });

  it("counts outcomes, per-tool calls, and the last call", () => {
    appendUsage(dir, { tool: "codegraph_explore", ok: true, duration_ms: 12, chars: 900 });
    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 3, chars: 120 });
    appendUsage(dir, {
      tool: "codegraph_search",
      ok: false,
      reason: "auto-index is off",
      duration_ms: 1,
      chars: 0,
    });
    const s = readUsage(dir);
    expect(s.ok).toBe(2);
    expect(s.failed).toBe(1);
    // The short tool names the status block shows (the codegraph_ prefix gone).
    expect(s.toolCounts).toEqual({ explore: 1, search: 2 });
    expect(s.lastFailure).toBe("auto-index is off");
    expect(typeof s.lastAt).toBe("number");
    expect(Math.abs((s.lastAt ?? 0) - Date.now())).toBeLessThan(60_000);
  });

  it("ignores malformed lines and lines without a readable timestamp", () => {
    writeLines([
      line({ ts: "2026-09-04T12:00:00.000Z", tool: "codegraph_search", ok: true }),
      "{ not json at all",
      JSON.stringify({ tool: "codegraph_search", ok: true }), // no ts
      line({ ts: "not-a-time", tool: "codegraph_callers", ok: true }),
      line({ ts: "2026-09-04T12:01:00.000Z", tool: "codegraph_node", ok: false, reason: "boom", chars: 0 }),
    ]);
    const s = readUsage(dir);
    expect(s.ok).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.toolCounts).toEqual({ search: 1, node: 1 });
    expect(s.lastAt).toBe(Date.parse("2026-09-04T12:01:00.000Z"));
  });

  it("skips a torn last line and counts it once it is completed", () => {
    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 2, chars: 20 });
    // A crash half-way through the next record: no newline, invalid JSON.
    appendRaw('{"ts":"2026-09-04T12:00:00.000Z","tool":"codegraph_impact","ok":tr');
    const torn = readUsage(dir);
    expect(torn.ok).toBe(1);
    expect(torn.toolCounts).toEqual({ search: 1 });

    // The writer that runs later appends its own complete line after the
    // fragment; the completed line is still readable, and the fragment is
    // never counted twice by the incremental reader.
    appendRaw('ue, "duration_ms": 30, "chars": 400}\n');
    const healed = readUsage(dir);
    expect(healed.ok).toBe(2);
    expect(healed.toolCounts).toEqual({ search: 1, impact: 1 });

    const appended = readUsage(dir);
    expect(appended.ok).toBe(2);
    expect(appended.toolCounts).toEqual({ search: 1, impact: 1 });
  });

  it("accumulates across reads, so a later session sees earlier use", () => {
    appendUsage(dir, { tool: "codegraph_explore", ok: true, duration_ms: 40, chars: 2000 });
    expect(readUsage(dir).ok).toBe(1);
    appendUsage(dir, { tool: "codegraph_explore", ok: true, duration_ms: 41, chars: 2000 });
    appendUsage(dir, { tool: "codegraph_callers", ok: true, duration_ms: 2, chars: 30 });
    const s = readUsage(dir);
    expect(s.ok).toBe(3);
    expect(s.toolCounts).toEqual({ explore: 2, callers: 1 });
  });

  it("picks the last failure by the clock, not by file order", () => {
    const older = "2026-09-04T10:00:00.000Z";
    const newest = "2026-09-04T12:00:00.000Z";
    const middle = "2026-09-04T11:00:00.000Z";
    // Two sessions append concurrently, so the file order is not the clock
    // order: the newest failure is the one the user must see.
    writeLines([
      line({ ts: older, tool: "codegraph_search", ok: false, reason: "older failure", chars: 0 }),
      line({ ts: newest, tool: "codegraph_node", ok: false, reason: "newest failure", chars: 0 }),
      line({ ts: middle, tool: "codegraph_callers", ok: false, reason: "middle failure", chars: 0 }),
    ]);
    const s = readUsage(dir);
    expect(s.failed).toBe(3);
    expect(s.lastFailure).toBe("newest failure");
    expect(s.lastAt).toBe(Date.parse(newest));
  });

  it("keeps the clock-ordered failure when a later read sees an older one", () => {
    // Two sessions of one worktree, and a writer whose clock is behind: the
    // incremental fold must not let the late-arriving older failure win.
    const newest = "2026-09-04T12:00:00.000Z";
    const older = "2026-09-04T10:00:00.000Z";
    fs.writeFileSync(
      file,
      line({ ts: newest, tool: "codegraph_search", ok: false, reason: "newest", chars: 0 }) +
        "\n",
    );
    expect(readUsage(dir).lastFailure).toBe("newest");
    appendRaw(
      line({ ts: older, tool: "codegraph_search", ok: false, reason: "older", chars: 0 }) +
        "\n",
    );
    const s = readUsage(dir);
    expect(s.failed).toBe(2);
    expect(s.lastFailure).toBe("newest");
  });

  it("breaks a timestamp tie by the later line", () => {
    const ts = "2026-09-04T12:00:00.000Z";
    writeLines([
      line({ ts, tool: "codegraph_search", ok: false, reason: "first", chars: 0 }),
      line({ ts, tool: "codegraph_search", ok: false, reason: "second", chars: 0 }),
    ]);
    expect(readUsage(dir).lastFailure).toBe("second");
  });

  it("restarts the counts when the ledger is deleted and written again", () => {
    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 1, chars: 5 });
    expect(readUsage(dir).ok).toBe(1);

    // /codegraph uninit removes the directory with the ledger in it.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    expect(readUsage(dir).ok).toBe(0);

    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 1, chars: 5 });
    const s = readUsage(dir);
    expect(s.ok).toBe(1);
    expect(s.toolCounts).toEqual({ search: 1 });
  });

  it("creates the ledger directory and survives an unreadable ledger", () => {
    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 1, chars: 5 });
    expect(fs.existsSync(file)).toBe(true);
    // A ledger that cannot be read must not break status: the summary is empty.
    fs.rmSync(file);
    fs.mkdirSync(file); // a directory where the ledger file belongs
    expect(readUsage(dir).ok).toBe(0);
  });

  it("writes an ignore file with a ledger it creates", () => {
    // The ledger of a worktree with no index is all that sits in the index
    // directory, so the directory must ignore itself. What git really does with
    // those rules is pinned in a real repository (the tools test and the
    // plain-Node smoke); this checks the file the writer produces.
    appendUsage(dir, { tool: "codegraph_search", ok: false, reason: "x", duration_ms: 1, chars: 0 });
    const ignore = path.join(dir, IGNORE_NAME);
    expect(fs.existsSync(ignore)).toBe(true);
    const content = fs.readFileSync(ignore, "utf-8");
    const rules = content.split("\n");
    expect(rules).toContain("*");
    expect(rules).toContain("!.gitignore");

    // Upstream owns this file too, and only upgrades one it recognizes as its
    // own: codegraph's `ensureGitignore` (src/directory.ts) matches a header
    // prefix and treats a file with a bare `*` line as its current default. A
    // header of our own would read as user-authored and freeze these rules for
    // good, so the file must keep both properties (issue #9, spec 0007 review).
    expect(content.startsWith("# CodeGraph data files")).toBe(true);
    expect(rules.some((line) => line.trim() === "*")).toBe(true);
  });

  it("never overwrites an ignore file it did not create", () => {
    // The index directory of a built index carries codegraph's own ignore file;
    // writing the ledger must leave it byte for byte as it is.
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, IGNORE_NAME);
    fs.writeFileSync(ignore, "# the library wrote this\n*\n!.gitignore\n", "utf-8");
    appendUsage(dir, { tool: "codegraph_search", ok: true, duration_ms: 1, chars: 5 });
    expect(fs.readFileSync(ignore, "utf-8")).toBe(
      "# the library wrote this\n*\n!.gitignore\n",
    );
  });
});
