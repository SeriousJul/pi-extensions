/**
 * Point-of-emission staleness gate (codegraph's isFileStaleOnDisk,
 * upstream issue #1474).
 *
 * The symbol-mode and explore renderers slice CURRENT on-disk bytes at
 * INDEXED line ranges. When a file changed after its last index sync -
 * inside the watcher's debounce window, or after a sync that was locked
 * or missed - those ranges can point at a DIFFERENT symbol's code,
 * served under the requested name. The pre-query reconcile removes most
 * of the risk, but the last word is at emission, so the freshness of
 * every file being sliced is verified from data the index already
 * stores.
 *
 * Cheap and precise, mirroring the upstream gate: one stat() per file
 * (size + floored mtime, the same comparison the sync fast path uses);
 * only on a stat mismatch is the content hashed (sha256 over the utf-8
 * string, byte-identical to codegraph's hashContent) so a checkout that
 * rewrote identical bytes never false-positives. Results are memoized
 * for a short TTL so one response that slices the same file in several
 * sections pays for the check once.
 *
 * Any failure (no files-table row, missing file, stat or read error)
 * reports false: those cases are handled by the existing not-found /
 * missing-on-disk paths, and a wrong "stale" flag would needlessly push
 * the agent to re-read a file that is fine.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IndexAdapter } from "./indexAdapter";

const DRIFT_TTL_MS = 2000;
const driftCache = new Map<string, { at: number; stale: boolean }>();

/** A drifted file within these bounds is served whole (Read-parity). */
export const STALE_WHOLE_FILE_MAX_LINES = 300;
export const STALE_WHOLE_FILE_MAX_CHARS = 12000;

/**
 * True when the on-disk file differs from its indexed record - i.e. the
 * indexed line ranges for it are NOT trustworthy and a slice of current
 * bytes at those ranges must not be emitted.
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

/**
 * The full CURRENT source of a small drifted file, numbered from line 1
 * (Read-parity), or undefined when the file is beyond the whole-file
 * caps or unreadable.
 */
export function staleWholeFile(abs: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
  const body = content.replace(/\n+$/, "");
  const lines = body.split("\n");
  if (
    lines.length > STALE_WHOLE_FILE_MAX_LINES ||
    body.length > STALE_WHOLE_FILE_MAX_CHARS
  ) {
    return undefined;
  }
  return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
}
