/**
 * Dependency-source cache knowledge (spec 0009).
 *
 * The one module in the extension that names the opensrc tool. Everything
 * else talks about named roots, trusted roots, project labels, and fetch
 * hints without naming it. This module turns a cache home into:
 *
 * - the trusted roots (the home itself, plus the PATH-style
 *   `CODEGRAPH_PI_TRUSTED_ROOTS` entries);
 * - snapping: a named root inside a cache entry belongs to that entry's
 *   tree, so a sub-directory of a dependency serves the dependency's index;
 * - project labels ("name, name @version") read from the cache's own
 *   manifest, memoized until the manifest's mtime changes;
 * - the fetch name a `no such directory` failure can point at.
 *
 * The label lookup shells out to `opensrc list --json` - a supported
 * surface - rather than reading the cache manifest file directly, so a
 * manifest format change is the CLI's problem, not this extension's.
 * Every lookup degrades to "no label, no hint" when the CLI is missing
 * or fails: a dependency source still works, it just reads by path.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A directory an index may be built at, and where that fact came from. */
export interface TrustedRoot {
  /** The real, absolute path of the trusted directory. */
  root: string;
  /** "OPENSRC_HOME", "CODEGRAPH_PI_TRUSTED_ROOTS", or "add". */
  origin: string;
}

/** One manifest item: a name that resolves to one cached tree. */
interface ManifestItem {
  name: string;
  version: string;
  path: string;
}

/** The `opensrc list --json` shape this module depends on. */
interface Manifest {
  packages?: ManifestItem[];
  repos?: ManifestItem[];
}

/**
 * Label, snap, and fetch-name knowledge over one cache home. The reader
 * is injectable for tests; in production it is the cache's own CLI.
 */
export interface OpenSrc {
  /** The real path of the cache home. */
  readonly home: string;
  /** The cache entry containing `root` (longest path prefix), or undefined. */
  cacheRootFor(root: string): string | undefined;
  /** "name, name @version" for the entry containing `root`, or undefined. */
  labelFor(root: string): string | undefined;
  /**
   * The best-effort fetch name for a path under the home (which may not
   * exist yet - the `no such directory` hint), or undefined.
   */
  fetchNameFor(root: string): string | undefined;
}

export interface OpenSrcOptions {
  /** The manifest reader. Default: the cache's `list --json` CLI. */
  list?: () => Manifest;
  /**
   * The stat of the manifest file, the key the memo caches against.
   * Default: `<home>/sources.json`.
   */
  manifestStat?: () => { mtimeMs: number } | undefined;
}

/** One cached tree and the names that resolve to it. */
interface Entry {
  /** The real path of the cached tree. */
  path: string;
  names: string[];
  version: string;
}

const LIST_TIMEOUT_MS = 10_000;

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The default manifest reader: the cache's own CLI, a supported surface. */
function defaultList(): Manifest {
  const out = execFileSync("opensrc", ["list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: LIST_TIMEOUT_MS,
  });
  return JSON.parse(out) as Manifest;
}

/**
 * The cache home: `$OPENSRC_HOME` when set (an explicit setting that points
 * nowhere is reported as "no cache", not switched away from), else
 * `~/.opensrc` when it is a directory. Realpath'd; undefined when absent.
 */
export function cacheHome(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env.OPENSRC_HOME;
  if (explicit !== undefined && explicit !== "") {
    return isDir(explicit) ? realpath(explicit) : undefined;
  }
  const def = path.join(os.homedir(), ".opensrc");
  return isDir(def) ? realpath(def) : undefined;
}

/**
 * The trusted roots the environment provides: the cache home and the
 * `CODEGRAPH_PI_TRUSTED_ROOTS` entries (PATH-style, `:`-delimited). Only
 * existing directories count; each is realpath'd and deduplicated.
 */
export function trustedRootsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TrustedRoot[] {
  const out: TrustedRoot[] = [];
  const home = cacheHome(env);
  if (home) out.push({ root: home, origin: "OPENSRC_HOME" });
  const extra = env.CODEGRAPH_PI_TRUSTED_ROOTS;
  if (extra) {
    for (const piece of extra.split(":")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const real = realpath(trimmed);
      if (!isDir(real)) continue;
      if (!out.some((t) => t.root === real)) {
        out.push({ root: real, origin: "CODEGRAPH_PI_TRUSTED_ROOTS" });
      }
    }
  }
  return out;
}

/**
 * The path-form label for a root: the last two path segments joined by the
 * separator, or the basename when there are fewer. Names no tool: the label
 * of a tree outside any cache is just where it is.
 */
export function pathLabel(root: string): string {
  const parts = root.split(path.sep).filter(Boolean);
  if (parts.length <= 2) return path.basename(root) || root;
  return parts.slice(-2).join(path.sep);
}

/** The relative form of `target` under `base`, or undefined when not under it. */
function relativeUnder(base: string, target: string): string | undefined {
  if (target === base) return "";
  if (target.startsWith(base + path.sep)) {
    return target.slice(base.length + path.sep.length);
  }
  return undefined;
}

export function createOpenSrc(
  home: string,
  opts: OpenSrcOptions = {},
): OpenSrc {
  const homeReal = realpath(home);
  const readManifest = opts.list ?? defaultList;
  const statManifest = opts.manifestStat ?? (() => {
    try {
      return fs.statSync(path.join(home, "sources.json"));
    } catch {
      return undefined;
    }
  });

  let cacheKey: number | undefined;
  let entries: Entry[] | undefined;

  /**
   * The manifest's entries, memoized against the manifest file's mtime. A
   * changed mtime forces a re-read; a failed read keeps the last good
   * entries (nothing when the first read fails), so the CLI staying down
   * costs one call per lookup, not a broken extension.
   */
  function readEntries(): Entry[] {
    const key = statManifest()?.mtimeMs;
    if (entries !== undefined && key !== undefined && key === cacheKey) {
      return entries;
    }
    try {
      const manifest = readManifest();
      const byPath = new Map<string, Entry>();
      for (const item of [
        ...(manifest.packages ?? []),
        ...(manifest.repos ?? []),
      ]) {
        const abs = realpath(path.join(home, item.path));
        const entry = byPath.get(abs) ?? {
          path: abs,
          names: [],
          version: item.version,
        };
        if (!entry.names.includes(item.name)) entry.names.push(item.name);
        byPath.set(abs, entry);
      }
      entries = [...byPath.values()];
    } catch {
      // The CLI is missing or failed: the labels degrade to paths.
      if (entries === undefined) entries = [];
    }
    cacheKey = key;
    return entries;
  }

  /** The entry whose tree is `root`'s longest path-prefix ancestor. */
  function entryFor(root: string): Entry | undefined {
    const real = realpath(root);
    let best: Entry | undefined;
    for (const entry of readEntries()) {
      if (
        real === entry.path ||
        real.startsWith(entry.path + path.sep)
      ) {
        if (!best || entry.path.length > best.path.length) best = entry;
      }
    }
    return best;
  }

  return {
    home: homeReal,

    cacheRootFor(root: string): string | undefined {
      return entryFor(root)?.path;
    },

    labelFor(root: string): string | undefined {
      const entry = entryFor(root);
      if (!entry) return undefined;
      return `${entry.names.join(", ")} @${entry.version}`;
    },

    fetchNameFor(root: string): string | undefined {
      const entry = entryFor(root);
      if (entry) return entry.names[0];
      // A path under the home that is not in the manifest: the fetch name
      // is the directory before a version-looking leaf. Best effort only -
      // it feeds a hint a human can edit, not a command that runs. The home
      // and the path are each matched in logical and real form, so a
      // symlinked home still names its dependencies.
      const rel =
        relativeUnder(home, root) ??
        relativeUnder(homeReal, root) ??
        relativeUnder(home, realpath(root)) ??
        relativeUnder(homeReal, realpath(root));
      if (rel === undefined || rel === "") return undefined;
      const parts = rel.split(path.sep);
      if (parts[0] === "repos") parts.shift();
      if (parts.length === 0) return undefined;
      const last = parts[parts.length - 1];
      if (/^v?\d/.test(last) && parts.length > 1) {
        return parts[parts.length - 2];
      }
      return last;
    },
  };
}
