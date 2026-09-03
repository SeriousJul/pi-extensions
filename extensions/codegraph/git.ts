/**
 * Git worktree helpers.
 *
 * Sibling discovery is git-native: worktrees of the same repository share a
 * common git dir, and `git worktree list` enumerates exactly that set. No
 * path heuristics are involved.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export interface Worktree {
  /** Absolute path of the worktree top-level directory. */
  path: string;
  head: string;
  branch?: string;
  gitDir: string;
  detached: boolean;
  prunable: boolean;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Absolute path of the git worktree top-level directory that contains `dir`,
 * or undefined when `dir` is not inside a git worktree.
 */
export function gitWorktreeRoot(dir: string): string | undefined {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top ? path.resolve(dir, top) : undefined;
}

/**
 * Absolute path of the common git dir (the .git directory shared by all
 * worktrees of the repository), or undefined when `dir` is not inside a git
 * worktree.
 */
export function gitCommonDir(dir: string): string | undefined {
  const out = git(dir, ["rev-parse", "--git-common-dir"]);
  return out ? path.resolve(dir, out) : undefined;
}

/** True when `dir` is inside a git worktree. */
export function isGitWorktree(dir: string): boolean {
  return gitWorktreeRoot(dir) !== undefined;
}

/**
 * All worktrees of the repository that contains `root`, parsed from
 * `git worktree list --porcelain`. The first entry is the main checkout.
 * Returns [] when `root` is not a git worktree.
 */
export function listWorktrees(root: string): Worktree[] {
  const out = git(root, ["worktree", "list", "--porcelain"]);
  if (out === undefined) return [];
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  const push = (): void => {
    if (current) worktrees.push(current);
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      push();
      current = {
        path: line.slice("worktree ".length),
        head: "",
        gitDir: "",
        detached: false,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line.startsWith("gitdir ")) {
      current.gitDir = line.slice("gitdir ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "prunable") {
      current.prunable = true;
    }
  }
  push();
  return worktrees;
}
