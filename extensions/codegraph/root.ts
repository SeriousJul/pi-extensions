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
 * The session root is the anchor of record for a call: it is resolved from
 * the call's working directory first, and an anchored root may be the session
 * root or a descendant of it (a monorepo sub-project with its own index),
 * never another project (spec 0008). The refusal writes nothing: no index,
 * no ledger, no directory in a tree the user did not ask about.
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

/**
 * Error whose `reason` becomes the parenthesized reason in the standard
 * fallback line.
 *
 * `noLedger` marks the refusal that writes nothing: the named-root
 * failures of spec 0009 (no such directory, the trust bound, a file
 * outside the named root, and a seed without a worktree) record no usage
 * line, because recording one would create the very directory the refusal
 * refuses to create.
 */
export class CodegraphUnavailable extends Error {
  /**
   * A key for the one warning per session the ready seam emits on the
   * error's behalf. Set only by structural failures raised where no UI is
   * reachable (the session-root refusal in `resolveRoot`, spec 0008); every
   * other structural failure warns at its own site and leaves this
   * undefined.
   */
  warnKey?: string;

  constructor(
    readonly reason: string,
    readonly structural = false,
    readonly noLedger = false,
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
  /** True when the call named its own root (spec 0009) instead of resolving one. */
  named?: boolean;
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
 * The path rule for an argument that names a location (a `projectRoot`, and
 * a `file` argument once it is resolved): an absolute path stays as it is,
 * `~` and `~/x` expand against the home directory, and everything else
 * resolves against `baseDir`. One place, so `projectRoot` and `file` cannot
 * drift; applying it to `file` also closes a pre-existing gap, because Node
 * does not expand `~`.
 */
export function expandPathArg(arg: string, baseDir: string): string {
  if (path.isAbsolute(arg)) return arg;
  const home = os.homedir();
  if (arg === "~") return home;
  if (arg.startsWith("~/")) return path.join(home, arg.slice(2));
  return path.resolve(baseDir, arg);
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
  const absolute = expandPathArg(fileArg, startDir);
  const relative = path.relative(root, absolute);
  const escapesRoot =
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  return escapesRoot ? fileArg : relative || ".";
}

/**
 * The directory root resolution starts from for a call: the call's own
 * directory, or the directory that holds its file argument (the anchor; see
 * "Anchor" in the repository CONTEXT.md). A file argument runs through the
 * path rule (`expandPathArg`), so `~` forms expand here too.
 */
function anchorBaseDir(startDir: string, fileArg?: string): string {
  const anchor =
    fileArg === undefined
      ? path.resolve(startDir)
      : expandPathArg(fileArg, startDir);
  try {
    return fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor);
  } catch {
    return path.dirname(anchor);
  }
}

/**
 * The containment rule (spec 0008): an anchored root must be the session's
 * own root or a descendant of it, never another project. It is expressed
 * against the resolved session root, not the raw working directory, and
 * compared on realpaths, so a symlinked working directory and the directory
 * it points at do not look like two projects.
 *
 * Returns the refusal reason, or undefined when the root stays inside.
 * The reason carries the caller's own forms, not canonicalized paths, so
 * the agent recognizes the argument it passed and the project the call came
 * from.
 */
function outsideSessionRootReason(
  sessionRoot: string,
  anchoredRoot: string,
  fileArg: string,
): string | undefined {
  const outer = safeRealpath(sessionRoot);
  const inner = safeRealpath(anchoredRoot);
  let contained: boolean;
  if (outer !== undefined && inner !== undefined) {
    contained = inner === outer || inner.startsWith(outer + path.sep);
  } else {
    // One side could not be realpathed; compare the resolved logical forms.
    const o = path.resolve(sessionRoot);
    const i = path.resolve(anchoredRoot);
    contained = i === o || i.startsWith(o + path.sep);
  }
  if (contained) return undefined;
  return `file ${fileArg} is outside this project (${sessionRoot})`;
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** The structural refusal of a file that points outside the session root. */
function outsideProjectRefusal(reason: string): CodegraphUnavailable {
  // The refusal is raised where no UI is reachable, so it carries its
  // warning key: the ready seam emits the one warning per session.
  const refusal = new CodegraphUnavailable(reason, true);
  refusal.warnKey = "outside-session-root";
  return refusal;
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
 * The containment rule is not part of this policy: it constrains where an
 * anchored root may resolve, which `resolveRoot` enforces against the
 * session's own root.
 *
 * @throws CodegraphUnavailable when no project can be resolved.
 */
function resolveRootPolicy(
  startDir: string,
  fileArg?: string,
  findNearest?: (startPath: string) => string | null | undefined,
): ResolvedRoot {
  const base = anchorBaseDir(startDir, fileArg);

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
 * The session root is resolved first, from the call's working directory, and
 * is the anchor of record for the call. When a file argument anchors the
 * call, the anchored root must stay inside the session root (the containment
 * rule, spec 0008): a file in a monorepo sub-project that has its own index
 * still resolves to that sub-project, and a file that points at any other
 * project is refused with a structural `CodegraphUnavailable` that names both
 * paths. A call with no file argument anchors on the working directory alone
 * and so cannot cross.
 *
 * When a file argument is given, the result carries its root-relative form
 * (`ResolvedRoot.file`); with no file argument the result is the root
 * policy's alone. See `rootRelativeFile` for the escape rule.
 *
 * @throws CodegraphUnavailable when no project can be resolved, or when an
 * anchored root would leave the session root.
 */
export function resolveRoot(
  startDir: string,
  fileArg?: string,
  findNearest?: (startPath: string) => string | null | undefined,
): ResolvedRoot {
  if (fileArg === undefined) {
    return resolveRootPolicy(startDir, undefined, findNearest);
  }
  const sessionRoot = resolveRootPolicy(startDir, undefined, findNearest);
  let resolved: ResolvedRoot;
  try {
    resolved = resolveRootPolicy(startDir, fileArg, findNearest);
  } catch (err) {
    // The anchor's own tree has no project to resolve. When that tree is
    // outside the session root, name the boundary instead: the file is not
    // in this project, and the other tree's missing manifest is not the
    // reason the call cannot be served.
    const outside = outsideSessionRootReason(
      sessionRoot.root,
      anchorBaseDir(startDir, fileArg),
      fileArg,
    );
    if (outside !== undefined) throw outsideProjectRefusal(outside);
    throw err;
  }
  const outside = outsideSessionRootReason(
    sessionRoot.root,
    resolved.root,
    fileArg,
  );
  if (outside !== undefined) throw outsideProjectRefusal(outside);
  return {
    ...resolved,
    file: rootRelativeFile(resolved.root, startDir, fileArg),
  };
}

/**
 * The options a named root resolves against (spec 0009). The session hands
 * them in; this module stays free of the Index adapter.
 */
export interface NamedRootOptions {
  /**
   * Snapping: the cache entry containing the named directory, or undefined
   * when it sits outside any entry (the directory is then honored as-is).
   */
  snap?: (root: string) => string | undefined;
  /** The nearest-initialized-ancestor lookup, as in `resolveRoot`. */
  findNearest?: (startPath: string) => string | null | undefined;
  /** True when an index already exists at `root`. */
  hasIndex?: (root: string) => boolean;
  /** The extra text a missing directory reports (the fetch hint), or undefined. */
  fetchHint?: (abs: string) => string | undefined;
}

/**
 * Express a `file` argument of a named-root call as a path relative to the
 * named root: the argument applies the path rule with the named root as its
 * base, so a relative form names a file inside the named project (the
 * working directory plays no part). The named root is a hard boundary: a
 * form that escapes it is refused, because outside it there is no index
 * that could answer - unlike `rootRelativeFile`, which keeps the caller's
 * form and lets the index report the file absent.
 *
 * @throws CodegraphUnavailable when the form leaves the named root.
 */
export function namedRootFile(root: string, fileArg: string): string {
  const absolute = expandPathArg(fileArg, root);
  const relative = path.relative(root, absolute);
  const escapes =
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  if (escapes) {
    throw new CodegraphUnavailable(
      `file ${absolute} is outside the named project root (${root})`,
      true,
      true,
    );
  }
  return relative || ".";
}

/**
 * Resolve a call that named its own project root (spec 0009): the directory
 * the argument names (through the path rule) is the call's anchor, a file
 * argument is relative to it, and the file never moves the named root.
 *
 * - A named path that is a file resolves to its directory.
 * - A missing directory fails with `no such directory (<abs>)` and the fetch
   * hint when one can be given. The failure writes nothing (`noLedger`).
 * - A named directory inside a cache entry snaps to that entry's tree
 *   (longest path prefix); the entry's index is the one served, and its
 *   presence decides whether one must be created.
 * - A named directory outside any entry is honored as-is and runs the normal
 *   root policy (nearest initialized ancestor, else the manifest directory),
 *   so a sub-project of a second repository serves that repository's index.
 *   The file argument is then relative to the finally resolved root.
 *
 * @throws CodegraphUnavailable when the directory is missing or the file
 *   argument escapes the named root.
 */
export function resolveNamedRoot(
  projectRootArg: string,
  fileArg: string | undefined,
  startDir: string,
  opts: NamedRootOptions = {},
): ResolvedRoot {
  const abs = expandPathArg(projectRootArg, startDir);
  let base: string;
  try {
    base = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  } catch {
    const hint = opts.fetchHint?.(abs) ?? "";
    throw new CodegraphUnavailable(
      `no such directory (${abs})${hint}`,
      true,
      true,
    );
  }
  const real = safeRealpath(base);
  const snapped = real !== undefined ? opts.snap?.(real) : undefined;
  let root: string;
  let needsCreate: boolean;
  if (snapped !== undefined) {
    root = safeRealpath(snapped) ?? path.resolve(snapped);
    needsCreate = !opts.hasIndex?.(root);
  } else {
    const resolved = resolveRootPolicy(abs, undefined, opts.findNearest);
    root = resolved.root;
    needsCreate = resolved.needsCreate;
  }
  if (fileArg === undefined) {
    return { root, needsCreate, isMainCheckout: false, named: true };
  }
  return {
    root,
    file: namedRootFile(root, fileArg),
    needsCreate,
    isMainCheckout: false,
    named: true,
  };
}
