#!/usr/bin/env node
// Adopt a new upstream skill into the tree (npm run skills:add <slug>/<path>).
//
// Copies the chosen skill from the upstream repo at its fetched commit into
// the local root at the mirrored path, so the next sync tracks it. The first
// segment is the source slug from the manifest; the rest is the upstream
// path, bucketed (<slug>/<bucket>/<name>) or bucket-less (<slug>/<name>).
// skills:update prints its offers in exactly this form.
//
// The tool never commits, pushes, or overwrites a skill that is already in
// the tree.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_DIR_NAME, git, loadManifest, MAX_BUFFER, parseAddTarget, refreshCache } from "./core.mjs";

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
let slug;
let path;
try {
	if (args.length !== 1 || args[0].startsWith("--")) {
		throw new Error("usage: npm run skills:add -- <slug>/<path>");
	}
	({ slug, path } = parseAddTarget(args[0], manifest));
} catch (err) {
	fail(err.message);
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
