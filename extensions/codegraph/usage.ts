/**
 * The per-index codegraph usage ledger.
 *
 * Usage is local, append-only, and disposable with the index. A malformed or
 * torn line is ignored so a crash cannot make status unreadable.
 *
 * Cost policy: the ledger is never rewritten, so there is no compaction and no
 * size cap, and the counts stay cumulative across sessions of the worktree.
 * The read cost is bounded instead. A status call folds only the bytes appended
 * since the previous read of that file: the running summary is kept in memory,
 * keyed by the ledger path and validated against the file's inode and size
 * (`LedgerState` below). The first status call of a session pays one parse of
 * that worktree's ledger; every later call pays its new lines only. A replaced
 * or truncated file is reparsed from scratch, and a deleted one drops its
 * cached state. Memory is bounded by the number of cached ledgers
 * (MAX_CACHED_LEDGERS, evicted oldest-first), and each entry is a summary, not
 * the raw history.
 *
 * A reader may fold the same file from two processes; the ledger is advisory,
 * and appends are line-atomic (`appendFileSync` of one complete line), so the
 * worst case is a torn final line, which is skipped and read again later.
 *
 * Git hygiene: a failing call records its reason in the index directory of a
 * worktree that has no index yet, so the ledger can be the only file there.
 * `appendUsage` therefore writes the directory's own ignore file with it: one
 * wildcard keeps the ledger (and every other file in the index directory) out
 * of `git add -A`, exactly as the index directory's own ignore file does.
 */
import fs from "node:fs";
import path from "node:path";

export const USAGE_NAME = "usage.jsonl";

/**
 * The name of the index directory's self-ignore file. The codegraph library
 * writes its own version of it when it builds an index; this module writes an
 * equivalent one when the ledger is all that is there, so a usage log can
 * never be staged by `git add -A`.
 */
export const IGNORE_NAME = ".gitignore";

/**
 * The ignore rules for an index directory this module created.
 *
 * Upstream owns this file too: codegraph's `ensureGitignore` (`src/directory.ts`)
 * writes its own default when it builds an index and upgrades a default it
 * recognizes in place. It decides "this one is mine" from a header prefix
 * (`GITIGNORE_MARKER`, `# CodeGraph data files`) and "out of date" from the
 * absence of a bare `*` line; anything else it treats as user-authored and never
 * touches. A file with an invented header would therefore sit outside upstream's
 * upgrade path for good, keeping stale rules if upstream ever changes them.
 *
 * These rules keep both properties that put the file inside that path: the first
 * line starts with upstream's marker, and a bare `*` line is present. Only the
 * comment wording is ours, and it names the one file upstream does not know
 * about: the usage ledger. A directory this module created is then the same as
 * one upstream created as far as git is concerned, and a future upstream default
 * replaces these rules instead of being blocked by them. The `*` already covers
 * `usage.jsonl`, so no extra pattern is needed.
 */
const IGNORE_CONTENT = [
  "# CodeGraph data files - local to each machine, not for committing.",
  "# Ignore everything in .codegraph/ except this file itself, so transient",
  "# files (the database, daemon.pid, sockets, logs, and this extension's usage",
  "# ledger) never show up in git.",
  "*",
  "!.gitignore",
  "",
].join("\n");

export interface UsageRecord {
  ts: string;
  tool: string;
  ok: boolean;
  reason?: string;
  duration_ms: number;
  chars: number;
}

export interface UsageSummary {
  ok: number;
  failed: number;
  lastAt?: number;
  /** The reason of the newest failed call (same clock order as `lastAt`). */
  lastFailure?: string;
  toolCounts: Record<string, number>;
}

/** How many ledger files keep a cached running summary in one process. */
const MAX_CACHED_LEDGERS = 32;

interface LedgerState {
  /** The inode the summary was folded from (a replaced file is reparsed). */
  ino: number;
  /** Bytes of the file already folded into `summary` (always a line end). */
  offset: number;
  summary: UsageSummary;
  /**
   * The timestamp `summary.lastFailure` was selected by. Fold bookkeeping, not
   * part of what the status block shows: it lets a later read compare new
   * failures against the newest one without reparsing the history.
   */
  lastFailureAt?: number;
}

const ledgers = new Map<string, LedgerState>();

export function emptyUsage(): UsageSummary {
  return {
    ok: 0,
    failed: 0,
    toolCounts: {},
  };
}

function usagePath(dir: string): string {
  return path.join(dir, USAGE_NAME);
}

/**
 * Append one complete call record. The timestamp always comes from the writer's
 * clock: a caller cannot supply one, because the ledger records what a real call
 * cost. Ledger failures never fail a tool call.
 */
export function appendUsage(dir: string, record: Omit<UsageRecord, "ts">): void {
  try {
    ensureIndexDir(dir);
    const line: UsageRecord = {
      ts: new Date().toISOString(),
      tool: record.tool,
      ok: record.ok,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      duration_ms: record.duration_ms,
      chars: record.chars,
    };
    fs.appendFileSync(usagePath(dir), `${JSON.stringify(line)}\n`, "utf-8");
  } catch {
    // Usage is advisory. Never fail a codegraph call over its ledger.
  }
}

/**
 * The index directory the ledger lives in, created when it does not exist.
 * A directory this module creates gets its self-ignore file with it: without
 * one, the ledger of a worktree with no index shows up in `git status` and is
 * staged by `git add -A`. An ignore file that is already there (the library's
 * own, or the user's) is never touched.
 */
function ensureIndexDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, IGNORE_NAME);
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, IGNORE_CONTENT, "utf-8");
  }
}

function isRecord(value: unknown): value is UsageRecord {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<UsageRecord>;
  return (
    typeof item.ts === "string" &&
    typeof item.tool === "string" &&
    typeof item.ok === "boolean" &&
    typeof item.duration_ms === "number" &&
    typeof item.chars === "number"
  );
}

/** Fold one parsed complete record into a running summary. */
function fold(state: LedgerState, parsed: UsageRecord, at: number): void {
  const summary = state.summary;
  const shortName = parsed.tool.replace(/^codegraph_/, "");
  summary.toolCounts[shortName] = (summary.toolCounts[shortName] ?? 0) + 1;
  if (parsed.ok) {
    summary.ok += 1;
  } else {
    summary.failed += 1;
    // Pick the last failure by the same order as `lastAt` (newest timestamp,
    // later file position breaking a tie): concurrent sessions interleave
    // their appends, so file order alone can disagree with the clock.
    if (state.lastFailureAt === undefined || at >= state.lastFailureAt) {
      state.lastFailureAt = at;
      summary.lastFailure = parsed.reason ?? "unknown failure";
    }
  }
  if (summary.lastAt === undefined || at >= summary.lastAt) {
    summary.lastAt = at;
  }
}

/** Read `length` bytes of `file` from `offset` (undefined when it failed). */
function readBytes(file: string, offset: number, length: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** Parse complete lines and fold them; return the bytes consumed. */
function foldNewLines(state: LedgerState, text: string): number {
  // Only whole lines count: a trailing fragment is a torn write or a write in
  // flight, and is read again on the next call.
  const end = text.lastIndexOf("\n");
  if (end < 0) return 0;
  const complete = text.slice(0, end + 1);
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const at = Date.parse(parsed.ts);
    if (Number.isNaN(at)) continue;
    fold(state, parsed, at);
  }
  return Buffer.byteLength(complete, "utf-8");
}

/** A copy callers cannot mutate into the cached running summary. */
function snapshot(summary: UsageSummary): UsageSummary {
  return { ...summary, toolCounts: { ...summary.toolCounts } };
}

/**
 * Read the ledger of the index directory `dir` and return its cumulative
 * summary. Only the lines appended since the last read are parsed.
 */
export function readUsage(dir: string): UsageSummary {
  const file = usagePath(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    // No ledger (fresh worktree, or the index directory was removed with it).
    ledgers.delete(file);
    return emptyUsage();
  }

  let state = ledgers.get(file);
  if (!state || state.ino !== stat.ino || stat.size < state.offset) {
    // New, replaced, or truncated file: fold it from the start.
    if (state) ledgers.delete(file);
    state = { ino: stat.ino, offset: 0, summary: emptyUsage() };
    ledgers.set(file, state);
    if (ledgers.size > MAX_CACHED_LEDGERS) {
      const oldest = ledgers.keys().next().value;
      if (oldest !== undefined) ledgers.delete(oldest);
    }
  }
  if (state.offset === stat.size) return snapshot(state.summary);

  const text = readBytes(file, state.offset, stat.size - state.offset);
  if (text === undefined) {
    ledgers.delete(file);
    return emptyUsage();
  }
  state.offset += foldNewLines(state, text);
  return snapshot(state.summary);
}
