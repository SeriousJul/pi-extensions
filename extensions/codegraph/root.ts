/**
 * Project root resolution.
 *
 * A call's index is the nearest initialized ancestor of the call's working
 * directory (a file argument anchors the lookup to that file's location).
 * A borrowed index is never served: inside a git worktree the root is always
 * the worktree itself, so an index that belongs to another worktree is
 * treated as absent and a local index is created (seeded from a sibling).
 */
import "./env";
import { findNearestCodeGraphRoot } from "./codegraph";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitWorktreeRoot, listWorktrees } from "./git";

/** Error whose `reason` becomes the parenthesized reason in the standard fallback line. */
export class CodegraphUnavailable extends Error {
  constructor(
    readonly reason: string,
    readonly structural = false,
  ) {
    super(reason);
    this.name = "CodegraphUnavailable";
  }
}

export interface ResolvedRoot {
  /** The project root the call must be served from. */
  root: string;
  /** True when no index exists at `root` and one must be created. */
  needsCreate: boolean;
  /** Top-level path of the main checkout, when the root is a git worktree. */
  mainCheckout?: string;
  /** True when the root is the main checkout of its repository. */
  isMainCheckout: boolean;
}

/** Files that mark a directory as a project (non-git roots only). */
const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "composer.json",
  "mix.exs",
  "Gemfile",
  "Makefile",
];

/**
 * Reason `root` must never be indexed, or undefined when it is safe.
 * Indexing the home directory or the filesystem root would index the whole
 * machine.
 */
export function unsafeRootReason(root: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    return undefined;
  }
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }
  if (real === home) {
    return `refusing to index the home directory (${root})`;
  }
  if (real === path.parse(real).root) {
    return `refusing to index the filesystem root (${root})`;
  }
  return undefined;
}

/**
 * Nearest ancestor of `dir` (including itself) that contains a build
 * manifest. Never returns the home directory or the filesystem root.
 */
export function nearestManifestDir(dir: string): string | undefined {
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    return undefined;
  }
  let cur = path.resolve(dir);
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(cur);
    } catch {
      return undefined;
    }
    if (real === home || real === path.parse(real).root) return undefined;
    for (const manifest of MANIFESTS) {
      try {
        if (fs.statSync(path.join(cur, manifest)).isFile()) return cur;
      } catch {
        // not present
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * Resolve the project root a call must be served from.
 *
 * - A file argument anchors the lookup to that file's directory, so a file
 *   in a monorepo sub-project resolves to that sub-project's index.
 * - Inside a git worktree the root is always the worktree itself. The
 *   nearest initialized ancestor is served only when it lives inside the
 *   same worktree (a nested monorepo sub-project); an index of another
 *   worktree is borrowed and must never be served, so the worktree is marked
 *   for local index creation.
 * - Outside git, the root is the nearest initialized ancestor (a sub-
 *   directory inherits its parent project's index), else the nearest
 *   ancestor that looks like a project.
 *
 * @throws CodegraphUnavailable when no project can be resolved.
 */
export function resolveRoot(startDir: string, fileArg?: string): ResolvedRoot {
  const anchor = fileArg ? path.resolve(startDir, fileArg) : path.resolve(startDir);
  let base: string;
  try {
    base = fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor);
  } catch {
    base = path.dirname(anchor);
  }

  const worktree = gitWorktreeRoot(base);
  if (worktree) {
    const mainCheckout = listWorktrees(worktree)[0]?.path;
    const nearest = findNearestCodeGraphRoot(base);
    const insideOwnWorktree =
      typeof nearest === "string" &&
      (nearest === worktree || nearest.startsWith(worktree + path.sep));
    if (insideOwnWorktree) {
      return {
        root: nearest,
        needsCreate: false,
        mainCheckout,
        isMainCheckout: mainCheckout === nearest,
      };
    }
    return {
      root: worktree,
      needsCreate: true,
      mainCheckout,
      isMainCheckout: mainCheckout === worktree,
    };
  }

  const nearest = findNearestCodeGraphRoot(base);
  if (nearest) {
    return { root: nearest, needsCreate: false, isMainCheckout: false };
  }

  const manifest = nearestManifestDir(base);
  if (!manifest) {
    throw new CodegraphUnavailable(
      `no git repository or build manifest found at or above ${base}`,
    );
  }
  return { root: manifest, needsCreate: true, isMainCheckout: false };
}
