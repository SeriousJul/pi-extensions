/**
 * The trustworthy source section (spec 0005): the one module that owns
 * the contract for the source a renderer may emit for a file
 * (upstream point-of-emission check, codegraph's isFileStaleOnDisk,
 * issue #1474).
 *
 * The renderers slice CURRENT on-disk bytes at INDEXED line ranges. When
 * a file changed after its last index sync - inside the watcher's
 * debounce window, or after a sync that was locked or missed - those
 * ranges can point at a DIFFERENT symbol's code, served under the
 * requested name. The pre-query reconcile narrows the drift window; the
 * last word is at emission, and this module is where it is made.
 *
 * Single entry: sourceSection(). Input: the live index, the project
 * root, a file path, and the indexed line ranges of the symbols of
 * interest. Output: a structured section, one of four kinds:
 *
 *   slice   - fresh file: numbered current bytes at the indexed ranges.
 *   whole   - drifted file within the whole-file caps: the full current
 *             source, numbered from line 1 (Read parity).
 *   omitted - drifted file beyond the caps: no source is served.
 *   missing - file gone from disk.
 *
 * The entry returns structure, not text: the stale/omitted notices are
 * wording that differs between symbol mode and explore mode, so the
 * wording stays with the renderers. The renderers keep layout and
 * wording only; the contract - the gate, its memo, and the whole-file
 * caps - lives here. A drifted file never emits a slice, and a slice is
 * only obtainable through this entry, so a new source renderer inherits
 * the guarantee by construction.
 *
 * The gate's failure semantics: any failure (no indexed record, missing
 * file, stat or read error) reports the file as fresh; the not-found and
 * missing paths handle those cases. A wrong "stale" answer would push
 * the agent to re-read a fine file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CodegraphUnavailable } from "./root";
import type { IndexAdapter } from "./indexAdapter";

// ---------------------------------------------------------------------------
// The drift gate
// ---------------------------------------------------------------------------

// Memoized for a short TTL: one response that slices the same file in
// several sections pays for the check once.
const DRIFT_TTL_MS = 2000;
const driftCache = new Map<string, { at: number; stale: boolean }>();

/**
 * True when the on-disk file differs from its indexed record - i.e. the
 * indexed line ranges for it are NOT trustworthy and a slice of current
 * bytes at those ranges must not be emitted.
 *
 * Cheap and precise, mirroring the upstream gate: one stat() per file
 * (size + floored mtime, the same comparison the sync fast path uses);
 * only on a stat mismatch is the content hashed (sha256 over the utf-8
 * string, byte-identical to codegraph's hashContent) so a checkout that
 * rewrote identical bytes never false-positives.
 */
export function isFileStaleOnDisk(
  cg: IndexAdapter,
  root: string,
  relPath: string,
): boolean {
  const key = `${root}\0${relPath}`;
  const now = Date.now();
  const hit = driftCache.get(key);
  if (hit && now - hit.at < DRIFT_TTL_MS) return hit.stale;
  let stale = false;
  try {
    const rec = cg.getFile(relPath);
    if (rec) {
      const abs = path.resolve(root, relPath);
      if (
        (abs === root || abs.startsWith(root + path.sep)) &&
        fs.existsSync(abs)
      ) {
        const st = fs.statSync(abs);
        if (
          st.size !== rec.size ||
          Math.floor(st.mtimeMs) !== Math.floor(rec.modifiedAt)
        ) {
          const data = fs.readFileSync(abs, "utf-8");
          stale =
            crypto.createHash("sha256").update(data).digest("hex") !==
            rec.contentHash;
        }
      }
    }
  } catch {
    stale = false;
  }
  if (driftCache.size > 256) driftCache.clear();
  driftCache.set(key, { at: now, stale });
  return stale;
}

/** Drop memoized results (test hook: drift state can change mid-test). */
export function clearDriftCache(): void {
  driftCache.clear();
}

// ---------------------------------------------------------------------------
// The whole-file caps
// ---------------------------------------------------------------------------

/** A drifted file within these bounds is served whole (Read-parity). */
export const STALE_WHOLE_FILE_MAX_LINES = 300;
export const STALE_WHOLE_FILE_MAX_CHARS = 12000;

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/**
 * The one source section that is safe to emit for a file at its indexed
 * line ranges. Numbered lines use the read-tool shape (`<n>\t<line>`).
 */
export type SourceSection =
  /** Fresh file: numbered current bytes at the given indexed ranges. */
  | { kind: "slice"; lines: string[] }
  /** Drifted file within the caps: full current source, numbered from 1. */
  | { kind: "whole"; lines: string[] }
  /** Drifted file beyond the caps: the source is withheld. */
  | { kind: "omitted" }
  /** File gone from disk. */
  | { kind: "missing" };

/** Absolute path of a result file, guarded to stay inside the index root. */
function absFile(root: string, filePath: string): string {
  const abs = path.resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new CodegraphUnavailable(`index entry escapes the project root: ${filePath}`);
  }
  return abs;
}

/** Numbered current bytes at one 1-based, inclusive line range. */
function sliceLines(
  fileLines: string[],
  startLine: number,
  endLine: number,
): string[] {
  const out: string[] = [];
  for (let i = startLine - 1; i < Math.min(endLine, fileLines.length); i++) {
    if (i >= 0) out.push(`${i + 1}\t${fileLines[i]}`);
  }
  return out;
}

/**
 * The full CURRENT source of a drifted file, numbered from line 1
 * (Read-parity), or undefined when the file is beyond the whole-file
 * caps.
 */
function wholeSource(content: string): string[] | undefined {
  const body = content.replace(/\n+$/, "");
  const lines = body.split("\n");
  if (
    lines.length > STALE_WHOLE_FILE_MAX_LINES ||
    body.length > STALE_WHOLE_FILE_MAX_CHARS
  ) {
    return undefined;
  }
  return lines.map((line, i) => `${i + 1}\t${line}`);
}

/**
 * The single entry of the trustworthy source section.
 *
 * `ranges` are 1-based inclusive line ranges, emitted in the given
 * order: the renderer decides which ranges it asks for and how it caps
 * them (layout), this entry decides whether any source may be served at
 * all (contract).
 */
export function sourceSection(
  cg: IndexAdapter,
  root: string,
  relPath: string,
  ranges: Array<[number, number]>,
): SourceSection {
  const abs = absFile(root, relPath);
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    // The file is gone (or unreadable): the not-found / missing paths
    // own that case, and the gate would report it fresh anyway.
    return { kind: "missing" };
  }
  if (!isFileStaleOnDisk(cg, root, relPath)) {
    const fileLines = content.split("\n");
    const lines: string[] = [];
    for (const [start, end] of ranges) {
      lines.push(...sliceLines(fileLines, start, end));
    }
    return { kind: "slice", lines };
  }
  // Drifted: never a slice. A small file is served whole (Read-parity);
  // a large one is withheld.
  const whole = wholeSource(content);
  if (whole !== undefined) return { kind: "whole", lines: whole };
  return { kind: "omitted" };
}
