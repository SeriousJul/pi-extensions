/**
 * Project root resolution.
 *
 * A call's index is the nearest initialized ancestor of its anchor: the
 * call's working directory, or, when a file argument anchors the call
 * (`codegraph_node` file mode; see "Anchor" in the repository CONTEXT.md), that
 * file's location.
 * A borrowed index is never served: inside a git worktree the root is always
 * the worktree itself, so an index that belongs to another worktree is
 * treated as absent and a local index is created (seeded from a sibling).
 *
 * This module also decides what a file argument means once the root is known:
 * `resolveRoot` returns the file's root-relative form beside the root, so no
 * caller re-derives it. The root policy (`resolveRootPolicy`) and the file
 * form (`rootRelativeFile`) are computed apart and joined once, in
 * `resolveRoot`. `ResolvedRoot.file` is then the only carrier of that form on
 * its way to a tool: the session copies it, unchanged, onto the ready result.
 */
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
  /**
   * The file argument expressed relative to `root`, when a file argument was
   * given. This is the one carrier of that form: `CodegraphSession.ensureReady`
   * copies it to `ReadyInfo.file`, and no consumer re-derives it.
   *
   * A form that would leave `root` is refused and the caller's own argument is
   * kept instead. That happens on a real escape (a path outside the project,
   * so the indexed-file lookup reports it absent rather than reading across the
   * project boundary) and on an apparent one, when `startDir` and `root` reach
   * the same directory by different paths (see `rootRelativeFile`). An
   * argument that names `root` itself is `"."`, which the indexed-file lookup
   * reports as absent: a directory is never a file.
   */
  file?: string;
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
 * Express `fileArg` (a path relative to the call's `startDir`, or absolute)
 * as a path relative to `root`. The one rule behind `ResolvedRoot.file`, and
 * the rule a caller must not re-implement: root resolution applies it, and the
 * ready result carries the answer.
 *
 * When the relative form would escape `root` the original argument is kept,
 * so a file the root does not contain is reported as absent by the index
 * lookup instead of pointing outside the project. The escape is real for a
 * path outside the project, and only apparent when `startDir` and `root`
 * reach the same directory by different paths (a symlinked working
 * directory, where git reports the physical toplevel while the file argument
 * stays logical): there the caller's own relative form is still the right
 * one for the index.
 */
export function rootRelativeFile(
  root: string,
  startDir: string,
  fileArg: string,
): string {
  const absolute = path.resolve(startDir, fileArg);
  const relative = path.relative(root, absolute);
  const escapesRoot =
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  return escapesRoot ? fileArg : relative || ".";
}

/**
 * The root policy alone: which root serves the call, and what its index
 * needs. The file form is attached once, by `resolveRoot`.
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
 * The nearest-initialized-ancestor lookup is injected (the Index
 * adapter's factory, spec 0003); when omitted, the lookup reports no
 * index, so a root without an index resolves to its manifest directory.
 *
 * @throws CodegraphUnavailable when no project can be resolved.
 */
function resolveRootPolicy(
  startDir: string,
  fileArg?: string,
  findNearest?: (startPath: string) => string | null | undefined,
): ResolvedRoot {
  const anchor =
    fileArg === undefined
      ? path.resolve(startDir)
      : path.resolve(startDir, fileArg);
  let base: string;
  try {
    base = fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor);
  } catch {
    base = path.dirname(anchor);
  }

  const worktree = gitWorktreeRoot(base);
  if (worktree) {
    const mainCheckout = listWorktrees(worktree)[0]?.path;
    const nearest = findNearest?.(base) ?? null;
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

  const nearest = findNearest?.(base) ?? null;
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

/**
 * Resolve the project root a call must be served from, plus what its file
 * argument means inside that root.
 *
 * The root comes from the root policy above. When a file argument is given,
 * the result carries its root-relative form (`ResolvedRoot.file`); with no
 * file argument the result is the root policy's alone. See
 * `rootRelativeFile` for the escape rule.
 *
 * @throws CodegraphUnavailable when no project can be resolved.
 */
export function resolveRoot(
  startDir: string,
  fileArg?: string,
  findNearest?: (startPath: string) => string | null | undefined,
): ResolvedRoot {
  const resolved = resolveRootPolicy(startDir, fileArg, findNearest);
  if (fileArg === undefined) return resolved;
  return {
    ...resolved,
    file: rootRelativeFile(resolved.root, startDir, fileArg),
  };
}
