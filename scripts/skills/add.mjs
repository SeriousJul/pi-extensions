#!/usr/bin/env node
// Adopt a new upstream skill into the tree (npm run skills:add <bucket>/<name>).
//
// Copies the chosen skill from the upstream repo at its fetched commit into
// the local root at the mirrored path, so the next sync tracks it. A source
// slug prefix is accepted when the manifest holds more than one source:
// <slug>/<bucket>/<name>.
//
// The tool never commits, pushes, or overwrites a skill that is already in
// the tree.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_DIR_NAME, git, loadManifest, MAX_BUFFER, refreshCache } from "./core.mjs";

function fail(message) {
	console.error(`skill add: ${message}`);
	process.exit(1);
}

const repoRoot = process.env.SKILL_SYNC_ROOT ?? process.cwd();

let manifest;
try {
	manifest = loadManifest(repoRoot);
} catch (err) {
	fail(err.message);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith("--")) {
	fail("usage: npm run skills:add -- <bucket>/<name>");
}
const parts = args[0].split("/");
let slug;
let path;
if (Object.keys(manifest).length === 1 && parts.length === 2) {
	[slug] = Object.keys(manifest);
	path = args[0];
} else if (parts.length === 3) {
	slug = parts[0];
	path = parts.slice(1).join("/");
	if (!manifest[slug]) fail(`unknown source ${slug}`);
} else {
	fail("usage: npm run skills:add -- <bucket>/<name>");
}
const source = manifest[slug];
let commit;
try {
	const cacheDir = join(repoRoot, CACHE_DIR_NAME, slug);
	({ commit } = refreshCache(cacheDir, source.repo));

	const upstreamPath = `${source.upstreamRoot}/${path}`;
	try {
		git(["-C", cacheDir, "cat-file", "-e", `${commit}:${upstreamPath}/SKILL.md`], { stdio: "pipe" });
	} catch {
		fail(`no skill ${path} in ${slug} at ${commit.slice(0, 10)}`);
	}

	const localTarget = join(repoRoot, source.root, path);
	if (existsSync(localTarget)) fail(`${path} is already in the tree at ${source.root}/${path}`);

	// Stage inside the repo so the rename below always lands on the same
	// filesystem as the target (a rename across devices throws EXDEV).
	const stage = mkdtempSync(join(repoRoot, CACHE_DIR_NAME, "add-"));
	try {
		const archive = git(["-C", cacheDir, "archive", commit, upstreamPath], { encoding: "buffer" });
		execFileSync("tar", ["-x", "-C", stage], { input: archive, maxBuffer: MAX_BUFFER });
		const staged = join(stage, ...upstreamPath.split("/"));
		if (!existsSync(join(staged, "SKILL.md"))) fail(`adoption of ${path} did not land a SKILL.md`);
		mkdirSync(dirname(localTarget), { recursive: true });
		renameSync(staged, localTarget);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
} catch (err) {
	fail(err.message);
}

console.log(`adopted ${path} from ${slug} @ ${commit.slice(0, 10)} -> ${source.root}/${path}`);
