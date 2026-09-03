#!/usr/bin/env node
/**
 * Compatibility patch for @colbymchenry/codegraph 1.6.0.
 *
 * pi is a Bun-compiled binary. Two things in codegraph break under it:
 *
 * 1. codegraph opens databases with Node's built-in `node:sqlite`, which the
 *    Bun version pi embeds does not have (bun < 1.4). We rewrite those
 *    requires to this repo's shim (extensions/codegraph/sqlite-shim.cjs),
 *    which uses the real node:sqlite on Node and emulates it over
 *    bun:sqlite on bun.
 *
 * 2. Worker threads inside a Bun-compiled binary cannot resolve bare
 *    specifiers from on-disk node_modules (the main thread can; plain bun
 *    can). codegraph's parse pool runs in a worker thread and requires
 *    `web-tree-sitter` and `tree-sitter-wasms` from codegraph's nested
 *    lib/node_modules directory, so the workers crash on startup. We
 *    rewrite every bare require of a nested package to an absolute file
 *    path. Absolute paths work everywhere: main thread, file-based workers,
 *    and eval-string workers (relative paths are unreliable in the last one,
 *    which is why the shim rewrite uses an absolute path too).
 *
 * The script is idempotent (patched files carry a marker comment) and
 * best-effort: a missing or re-laid-out codegraph package prints a warning
 * and exits 0. Unpatched codegraph still fails with codegraph's own clear
 * error, and the extension reports that as its standard unavailable line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const shimPath = path.join(
  root,
  "extensions",
  "codegraph",
  "sqlite-shim.cjs",
);
const MARKER =
  "/* codegraph compat patch: pi-extensions (sqlite shim + absolute worker requires) v2 */";
const NODE_SQLITE_RE = /require\((['"])node:sqlite\1\)/g;
const OLD_SHIM_RE = /require\((["'])[^"']+sqlite-shim\.cjs\1\)/g;
const BARE_REQUIRE_RE = /require\((["'])([^"'\n]+)\1\)/g;
const WASM_RESOLVE_RE =
  /require\.resolve\(\s*`tree-sitter-wasms\/out\/\$\{([^}]+)\}`\s*\)/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve a nested package's CJS entry file, or null if it has none. */
function resolveEntry(pkgDir) {
  const manifest = readJson(path.join(pkgDir, "package.json"));
  if (!manifest) return null;
  const candidates = [];
  const exp = manifest.exports;
  if (exp && typeof exp === "object") {
    const dot = exp["."];
    if (typeof dot === "string") candidates.push(dot);
    else if (dot && typeof dot === "object") {
      if (typeof dot.require === "string") candidates.push(dot.require);
      if (typeof dot.default === "string") candidates.push(dot.default);
    }
  }
  if (typeof manifest.main === "string") candidates.push(manifest.main);
  candidates.push("index.js");
  for (const rel of candidates) {
    const full = path.join(pkgDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/** Map of nested package name -> absolute entry file. */
function nestedPackageMap(pkgRoot) {
  const map = new Map();
  const nm = path.join(pkgRoot, "lib", "node_modules");
  if (!fs.existsSync(nm)) return map;
  for (const entry of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(nm, entry.name), {
        withFileTypes: true,
      })) {
        if (!sub.isDirectory()) continue;
        const name = `${entry.name}/${sub.name}`;
        const dir = path.join(nm, entry.name, sub.name);
        const file = resolveEntry(dir);
        if (file) map.set(name, file);
      }
    } else {
      const dir = path.join(nm, entry.name);
      const file = resolveEntry(dir);
      if (file) map.set(entry.name, file);
    }
  }
  return map;
}

function patchFile(file, pkgMap, wasmOutDir) {
  const src = fs.readFileSync(file, "utf8");
  if (src.includes(MARKER)) return false;
  let out = src;
  let changed = false;

  // 1) node:sqlite -> shim (absolute path: also valid inside the
  //    eval-string workers codegraph spawns for WAL checkpoints).
  //    Also migrates files written by the first patch version, which used
  //    a relative shim path.
  NODE_SQLITE_RE.lastIndex = 0;
  OLD_SHIM_RE.lastIndex = 0;
  if (NODE_SQLITE_RE.test(out) || OLD_SHIM_RE.test(out)) {
    NODE_SQLITE_RE.lastIndex = 0;
    OLD_SHIM_RE.lastIndex = 0;
    out = out.replace(NODE_SQLITE_RE, `require(${JSON.stringify(shimPath)})`);
    out = out.replace(OLD_SHIM_RE, `require(${JSON.stringify(shimPath)})`);
    changed = true;
  }

  // 2) bare requires of nested packages -> absolute entry paths.
  const bareRewrite = (match, _q, spec) => {
    if (
      spec.startsWith(".") ||
      spec.startsWith("/") ||
      spec.startsWith("node:")
    ) {
      return match;
    }
    const target = pkgMap.get(spec);
    if (!target) return match;
    changed = true;
    return `require(${JSON.stringify(target)})`;
  };
  out = out.replace(BARE_REQUIRE_RE, bareRewrite);

  // 3) dynamic wasm subpath resolution -> absolute directory join.
  //    tree-sitter-wasms publishes only its out/ dir (no entry file), so it
  //    is not in pkgMap; locate the dir directly.
  WASM_RESOLVE_RE.lastIndex = 0;
  if (wasmOutDir && fs.existsSync(wasmOutDir) && WASM_RESOLVE_RE.test(out)) {
    WASM_RESOLVE_RE.lastIndex = 0;
    out = out.replace(WASM_RESOLVE_RE, (_m, varName) => {
      changed = true;
      return `${JSON.stringify(wasmOutDir)} + "/" + ${varName}`;
    });
  }

  if (!changed) return false;
  fs.writeFileSync(file, MARKER + "\n" + out);
  return true;
}

function walkJs(dir, out, depth = 0) {
  if (depth > 12 || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
}

function collectDirs() {
  const dirs = [];
  // 1) The npm-installed platform bundles next to this repo.
  const scope = path.join(root, "node_modules", "@colbymchenry");
  if (fs.existsSync(scope)) {
    for (const entry of fs.readdirSync(scope, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("codegraph")) {
        dirs.push(path.join(scope, entry.name));
      }
    }
  }
  // 2) Bundles the codegraph CLI self-healed into ~/.codegraph/bundles.
  const cache = path.join(os.homedir(), ".codegraph", "bundles");
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(cache, entry.name));
    }
  }
  return dirs;
}

function main() {
  if (!fs.existsSync(shimPath)) {
    console.warn(
      "codegraph patch: shim not found at",
      shimPath,
      "- skipping",
    );
    return;
  }
  let patched = 0;
  const scanned = [];
  for (const dir of collectDirs()) {
    const pkgMap = nestedPackageMap(dir);
    const wasmOutDir = path.join(
      dir,
      "lib",
      "node_modules",
      "tree-sitter-wasms",
      "out",
    );
    const files = [];
    walkJs(dir, files);
    scanned.push(...files);
    for (const file of files) {
      try {
        if (patchFile(file, pkgMap, wasmOutDir)) patched++;
      } catch (err) {
        console.warn(
          "codegraph patch: failed on",
          file,
          ":",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  if (patched > 0) {
    console.log(
      `codegraph patch: rewrote ${patched} file(s) ` +
        `(sqlite shim + absolute worker requires; scanned ${scanned.length} .js files)`,
    );
  } else if (scanned.length > 0) {
    console.log(
      "codegraph patch: already patched or nothing to do " +
        `(scanned ${scanned.length} .js files)`,
    );
  } else {
    console.warn(
      "codegraph patch: no @colbymchenry/codegraph package found - " +
        "skipping. On a runtime without node:sqlite, codegraph will fail " +
        "with its own clear error until the package is installed and this " +
        "script has run (npm install).",
    );
  }
}

main();
