/**
 * skill-migrate: the migration steps (ADR 0032).
 *
 * The registry is the extension's capability surface: a new structural
 * expectation is one new numbered step with its own preconditions and
 * postconditions. The runner (core.ts) never changes.
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Migration, MigrationContext } from "./core.ts";

/** The old and new domain-docs file names, as exact file names. */
export const OLD_GLOSSARY = "CONTEXT.md";
export const OLD_MAP = "CONTEXT-MAP.md";
export const OLD_FORMAT = "CONTEXT-FORMAT.md";
export const NEW_GLOSSARY = "GLOSSARY.md";
export const NEW_MAP = "GLOSSARY-MAP.md";
export const NEW_FORMAT = "GLOSSARY-FORMAT.md";

/**
 * The old file names and their replacements, longest name first. All three
 * root files are renamed (not just referenced), because the upstream layout
 * rename covers the format file too and a renamed reference to a file that
 * keeps its old name is a dangling reference (ADR 0032).
 */
const RENAMES: { from: string; to: string }[] = [
  { from: OLD_MAP, to: NEW_MAP },
  { from: OLD_FORMAT, to: NEW_FORMAT },
  { from: OLD_GLOSSARY, to: NEW_GLOSSARY },
];

/** Directory names the reference rewrite never enters. */
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".skill-cache",
]);

/** Lock file names the reference rewrite never touches. */
const LOCK_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
]);

/** Exact-token match of the three old file names (longest alternative first). */
const OLD_NAME_TOKEN = new RegExp(`(?<![A-Za-z0-9_-])(${RENAMES.map((r) => r.from.replace(".", "\\.")).join("|")})`, "g");
const REPLACEMENT = new Map(RENAMES.map((r) => [r.from, r.to]));

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function isExcludedPath(path: string, excluded: string[]): boolean {
  for (const excludedRoot of excluded) {
    const normalized = excludedRoot.endsWith(sep) ? excludedRoot : excludedRoot + sep;
    if (path === excludedRoot || path.startsWith(normalized)) return true;
  }
  return false;
}

/** Inline link targets: `[text](target)`, with optional `"title"` or `(title)`. */
const INLINE_LINK = /\[[^\]]*\]\(([^()]*)\)/g;
/** Reference-style definitions: `[label]: target`, one per line. */
const REFERENCE_DEF = /^\s{0,3}\[[^\]]*\]:\s*(\S+)/gm;

/** Strip optional angle brackets and a trailing title from a link target. */
function linkTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)).trim();
  }
  const bare = trimmed.match(/^[^\s(]+/);
  return bare ? bare[0] : trimmed;
}

/**
 * The local .md paths the root map names, exactly as written in the map.
 * Covers inline links (with titles and angle-bracketed targets) and
 * reference-style definitions. URLs, anchors, and non-.md targets are
 * skipped.
 */
export function mapReferences(repoRoot: string): string[] {
  for (const name of [OLD_MAP, NEW_MAP]) {
    const path = join(repoRoot, name);
    if (!isFile(path)) continue;
    const text = readFileSync(path, "utf8");
    const rawTargets: string[] = [];
    for (const match of text.matchAll(INLINE_LINK)) rawTargets.push(match[1]);
    for (const match of text.matchAll(REFERENCE_DEF)) rawTargets.push(match[1]);
    const refs: string[] = [];
    for (const raw of rawTargets) {
      const target = linkTarget(raw);
      if (target === "" || target.startsWith("#")) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, ...
      const pathOnly = target.split("#")[0];
      if (pathOnly === "" || !pathOnly.endsWith(".md")) continue;
      if (!refs.includes(pathOnly)) refs.push(pathOnly);
    }
    return refs;
  }
  return [];
}

function renameIfExists(from: string, to: string): boolean {
  if (!isFile(from)) return false;
  renameSync(from, to);
  return true;
}

/**
 * Rename the three root domain-docs files (glossary, map, format) when
 * present, plus each per-context glossary the map references, by the local
 * path exactly as written in the map. A reference that already carries the
 * new name but whose file still lives under the old name is renamed too, so
 * a half-finished rename completes instead of aborting.
 */
function renameGlossaryFiles(repoRoot: string): void {
  const refs = mapReferences(repoRoot);
  for (const rename of RENAMES) {
    renameIfExists(join(repoRoot, rename.from), join(repoRoot, rename.to));
  }
  for (const ref of refs) {
    const refPath = join(repoRoot, ref);
    const dir = dirname(refPath);
    const base = basename(refPath);
    if (base === OLD_GLOSSARY) {
      renameIfExists(refPath, join(dir, NEW_GLOSSARY));
    } else if (base === NEW_GLOSSARY) {
      renameIfExists(join(dir, OLD_GLOSSARY), refPath);
    }
  }
}

/** Both the old and the new file present in one location: the runner must not guess. */
function ambiguityProblems(repoRoot: string): string[] {
  const problems: string[] = [];
  for (const rename of RENAMES) {
    if (isFile(join(repoRoot, rename.from)) && isFile(join(repoRoot, rename.to))) {
      problems.push(`ambiguous state: both ${rename.from} and ${rename.to} are present at the repo root`);
    }
  }
  for (const ref of mapReferences(repoRoot)) {
    const refPath = join(repoRoot, ref);
    const oldPath = join(dirname(refPath), OLD_GLOSSARY);
    const newPath = join(dirname(refPath), NEW_GLOSSARY);
    if (isFile(oldPath) && isFile(newPath)) {
      problems.push(`ambiguous state: both ${oldPath} and ${newPath} are present for the map reference ${ref}`);
    }
  }
  return problems;
}

/** True when the first 8 KB of the file carry a null byte. Reads only that window. */
function isBinary(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return true;
  }
  try {
    const chunk = Buffer.alloc(8192);
    const bytes = readSync(fd, chunk, 0, chunk.length, 0);
    for (let i = 0; i < bytes; i++) {
      if (chunk[i] === 0) return true;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace the three old file names, as exact tokens, across the repo's
 * text files. Skips .git, dependency and build directories, binary files,
 * lock files, and the paths the caller excludes (the running tool's own
 * source trees, where the names are migration data, not references).
 */
function rewriteReferences(repoRoot: string, excludedPaths: string[]): { files: number; replacements: number } {
  let files = 0;
  let replacements = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !isExcludedPath(path, excludedPaths)) walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (LOCK_FILES.has(entry.name)) continue;
      if (isExcludedPath(path, excludedPaths)) continue;
      if (isBinary(path)) continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      let count = 0;
      const out = text.replace(OLD_NAME_TOKEN, (match) => {
        count += 1;
        return REPLACEMENT.get(match) ?? match;
      });
      if (count > 0) {
        writeFileSync(path, out);
        files += 1;
        replacements += count;
      }
    }
  };
  walk(repoRoot);
  return { files, replacements };
}

function glossaryRenamePostconditions(repoRoot: string): string[] {
  const problems: string[] = [];
  for (const rename of RENAMES) {
    if (isFile(join(repoRoot, rename.from))) {
      problems.push(`the root ${rename.from} is still present`);
    }
  }
  for (const ref of mapReferences(repoRoot)) {
    const refPath = join(repoRoot, ref);
    const base = basename(refPath);
    if (base === OLD_GLOSSARY) {
      problems.push(`the map still references ${ref} under the old name`);
    } else if (base === NEW_GLOSSARY && isFile(join(dirname(refPath), OLD_GLOSSARY))) {
      problems.push(`the old per-context file ${join(dirname(refPath), OLD_GLOSSARY)} is still present next to the referenced ${ref}`);
    }
  }
  return problems;
}

/**
 * The full registry, in version order.
 *
 * 1. create-changelog (void to 1): the runner's own record creates the
 *    changelog; nothing else changes.
 * 2. glossary-rename (1 to 2): rename the domain-docs files the skills
 *    reference, then rewrite every reference to the old names.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "create-changelog",
    preconditions: () => [],
    apply: () => {
      // The runner appends this migration's own record, which creates the
      // changelog carrying only itself.
    },
    postconditions: () => [],
  },
  {
    version: 2,
    name: "glossary-rename",
    preconditions: (repoRoot) => ambiguityProblems(repoRoot),
    apply: (repoRoot, ctx: MigrationContext) => {
      renameGlossaryFiles(repoRoot);
      rewriteReferences(repoRoot, (ctx.excludedPaths ?? []).map((p) => resolve(p)));
    },
    postconditions: (repoRoot) => glossaryRenamePostconditions(repoRoot),
  },
];
