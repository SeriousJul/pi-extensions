/**
 * Seed sources.
 *
 * A seed copies a sibling worktree's index DB into the new worktree's
 * index directory before the first reconcile. Finding the sibling is
 * git-native and lives here; the copy itself is an Index adapter operation
 * (spec 0003): it opens the library's database through the runtime stack,
 * which this module never touches.
 */
import fs from "node:fs";
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
 *
 * The initialization check is injected: it is the Index adapter's (spec
 * 0003), and this module stays library-free.
 */
export function findSeedSource(
  root: string,
  isInitialized: (path: string) => boolean,
): SeedSource | undefined {
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
