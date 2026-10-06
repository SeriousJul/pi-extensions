#!/usr/bin/env node
/**
 * Security patch for the brace-expansion copy under
 * @earendil-works/pi-coding-agent (CVE-2026-102277, Dependabot alert #9).
 *
 * Why a patch instead of a plain version bump: pi-coding-agent ships an
 * npm-shrinkwrap.json inside its published tarball, pinning
 * brace-expansion@5.0.9 (vulnerable: quadratic-time `{a},b}` expansion,
 * CPU denial of service). npm inflates that subtree from the bundled
 * shrinkwrap on every install, and the shrinkwrap wins over the root
 * lockfile and over `overrides` - verified against npm 11. No published
 * pi-coding-agent version (up to 0.99.1) carries a patched shrinkwrap,
 * so the 5.0.12 fix is unreachable through normal npm resolution.
 *
 * What this script does (best-effort, idempotent, exit 0):
 *
 * 1. Replaces any vulnerable brace-expansion copy under
 *    node_modules/@earendil-works/pi-coding-agent/ with the registry's
 *    5.0.12 files, taken from the committed
 *    scripts/patches/brace-expansion-5.0.12.tgz (sha512-verified).
 *
 * 2. Removes the bundled npm-shrinkwrap.json from the installed
 *    pi-coding-agent so in-place npm runs read the patched subtree
 *    instead of the vulnerable pin.
 *
 * 3. Re-points package-lock.json at brace-expansion 5.0.12 wherever the
 *    shrinkwrap re-wrote it back to 5.0.9, so the committed lockfile -
 *    the artifact Dependabot scans and `npm ci` installs - stays on the
 *    patched version.
 *
 * Remove this script (and the postinstall entry) once pi-coding-agent
 * publishes a shrinkwrap that pins brace-expansion >= 5.0.12.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const PATCHED_VERSION = "5.0.12";
const EXPECTED_INTEGRITY =
  "sha512-YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ==";
const TARBALL = path.join(root, "scripts", "patches", "brace-expansion-5.0.12.tgz");

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

function isVulnerable(version) {
  const v = parseVersion(version);
  const p = parseVersion(PATCHED_VERSION);
  for (let i = 0; i < 3; i++) {
    if (v[i] !== p[i]) return v[i] < p[i];
  }
  return false;
}

/** Return the installed version of a node_modules package dir, or null. */
function installedVersion(pkgDir) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    return manifest.version || null;
  } catch {
    return null;
  }
}

/** Verify and extract the committed 5.0.12 tarball into targetDir. */
function extractPatched(targetDir) {
  const buf = fs.readFileSync(TARBALL);
  const actual = "sha512-" + crypto.createHash("sha512").update(buf).digest("base64");
  if (actual !== EXPECTED_INTEGRITY) {
    throw new Error(
      `brace-expansion patch tarball integrity mismatch: ` +
        `got ${actual}, want ${EXPECTED_INTEGRITY}`,
    );
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  execFileSync("tar", ["-xzf", TARBALL, "--strip-components=1", "-C", targetDir]);
}

/** Find installed pi-coding-agent package dirs. */
function findPiDirs() {
  const dirs = [];
  let dir = root;
  for (;;) {
    const pi = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(pi)) dirs.push(pi);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Re-point a brace-expansion entry in package-lock.json at 5.0.12.
 * Surgical text edit: replaces the version/resolved/integrity lines inside
 * the block for `entryKey` so npm's lockfile formatting stays untouched.
 * Returns true when the file changed.
 */
function fixLockEntry(entryKey) {
  const lockPath = path.join(root, "package-lock.json");
  let text;
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  const keyLine = `"${entryKey}": {`;
  const start = text.indexOf(keyLine);
  if (start === -1) return false;
  const end = text.indexOf("}", text.indexOf("\n", start));
  if (end === -1) return false;
  const block = text.slice(start, end);
  if (block.includes(`"version": "${PATCHED_VERSION}",`)) return false;
  const newBlock = block
    .replace(/"version": "[^"]*"/, `"version": "${PATCHED_VERSION}"`)
    .replace(
      /"resolved": "[^"]*"/,
      `"resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-${PATCHED_VERSION}.tgz"`,
    )
    .replace(/"integrity": "[^"]*"/, `"integrity": "${EXPECTED_INTEGRITY}"`);
  if (newBlock === block) return false;
  fs.writeFileSync(lockPath, text.slice(0, start) + newBlock + text.slice(end));
  return true;
}

function main() {
  if (!fs.existsSync(TARBALL)) {
    console.warn(
      "brace-expansion patch: tarball not found at",
      TARBALL,
      "- skipping",
    );
    return;
  }
  const piDirs = findPiDirs();
  if (piDirs.length === 0) {
    // dev-only dependency (e.g. installed with --omit dev): nothing to do
    return;
  }
  let swapped = 0;
  let removedShrinkwraps = 0;
  for (const piDir of piDirs) {
    const candidates = [
      path.join(piDir, "node_modules", "brace-expansion"),
      path.resolve(piDir, "..", "brace-expansion"),
    ];
    for (const beDir of candidates) {
      const version = installedVersion(beDir);
      if (!version) continue;
      if (!isVulnerable(version)) continue;
      try {
        extractPatched(beDir);
        swapped++;
      } catch (err) {
        console.warn(
          "brace-expansion patch: failed on",
          beDir,
          ":",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const sw = path.join(piDir, "npm-shrinkwrap.json");
    if (fs.existsSync(sw)) {
      try {
        fs.rmSync(sw);
        removedShrinkwraps++;
      } catch (err) {
        console.warn(
          "brace-expansion patch: could not remove",
          sw,
          ":",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  const lockFixed =
    fixLockEntry("node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion") ||
    fixLockEntry("node_modules/brace-expansion");
  if (swapped > 0 || removedShrinkwraps > 0 || lockFixed) {
    console.log(
      `brace-expansion patch: ${swapped} vulnerable copy(ies) -> ${PATCHED_VERSION}, ` +
        `${removedShrinkwraps} bundled shrinkwrap(s) removed, ` +
        `lockfile re-pointed: ${lockFixed}`,
    );
  }
}

main();
