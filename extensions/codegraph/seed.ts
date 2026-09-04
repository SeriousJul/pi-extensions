/**
 * Seed sources and index seeding.
 *
 * A seed copies a sibling worktree's index DB into the new worktree's index
 * directory before the first reconcile. The copy uses SQLite's online backup
 * API (checkpoint + file copy on Node 22.5-22.15, which lack the backup
 * API), so it is a consistent snapshot even while another process has the
 * sibling's index open.
 */
import "./env";
import { getDatabasePath, isInitialized } from "./codegraph";
import fs from "node:fs";
import shim from "./sqlite-shim.cjs";
import { listWorktrees } from "./git";

export interface SeedSource {
  /** Absolute path of the sibling worktree to seed from. */
  path: string;
  /** True when the source is the main checkout. */
  main: boolean;
}

/**
 * Find a sibling worktree of `root` whose index can be seeded. Siblings are
 * worktrees of the same repository (shared common git dir), discovered via
 * `git worktree list`. Siblings whose path is missing or prunable are
 * skipped. An incomplete (interrupted-build) sibling index is still
 * accepted: the post-seed reconcile converges it. Preference: the main
 * checkout when indexed, else any indexed sibling.
 */
export function findSeedSource(root: string): SeedSource | undefined {
  const worktrees = listWorktrees(root);
  if (worktrees.length === 0) return undefined;
  const mainPath = worktrees[0].path;
  const candidates = worktrees.filter(
    (w) =>
      w.path !== root &&
      !w.prunable &&
      fs.existsSync(w.path) &&
      isInitialized(w.path),
  );
  if (candidates.length === 0) return undefined;
  const preferred = candidates.find((w) => w.path === mainPath) ?? candidates[0];
  return { path: preferred.path, main: preferred.path === mainPath };
}

/**
 * Copy `sourceRoot`'s index DB over `targetRoot`'s index DB as a
 * consistent snapshot (online backup where the node:sqlite backup API
 * exists, serialize+write on bun, checkpoint+file copy on Node 22.5-22.15 -
 * see sqlite-shim.cjs). The target's existing db file and WAL sidecars are
 * removed first, so the destination ends as exactly the source's snapshot.
 */
export async function seedDb(targetRoot: string, sourceRoot: string): Promise<void> {
  const srcPath = getDatabasePath(sourceRoot);
  const dstPath = getDatabasePath(targetRoot);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(dstPath + suffix, { force: true });
  }
  const src = new shim.DatabaseSync(srcPath, { readOnly: true });
  try {
    if (shim.backup) {
      await shim.backup(src, dstPath);
    } else {
      // Node 22.5-22.15: no node:sqlite backup API. The checkpoint + file
      // copy fallback yields a consistent snapshot at the checkpoint moment.
      await shim.backupFile(srcPath, dstPath);
    }
  } finally {
    src.close();
  }
}
