#!/usr/bin/env node
// Skill sync (npm run skills:update).
//
// For every Skill source in the manifest: fetch the upstream repo, read the
// upstream tree at the Source pin and at the fetched commit, scan the local
// root, plan the three-way merge of every tracked skill, apply the writes,
// report per skill, and advance the Source pin iff the sync completed with
// no conflict and no orphan.
//
// The tool never commits, pushes, deletes, or renames. A failed run (bad
// repo, network) exits 1 and leaves the tree and the pin untouched.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CACHE_DIR_NAME,
	ensureCommitCached,
	gitMergeFile,
	loadManifest,
	planSource,
	readUpstreamTree,
	refreshCache,
	saveManifest,
	scanLocalSkills,
} from "./core.mjs";

function fail(message) {
	console.error(`skill sync: ${message}`);
	process.exit(1);
}

function short(hash) {
	return hash.slice(0, 10);
}

const repoRoot = process.env.SKILL_SYNC_ROOT ?? process.cwd();

let manifest;
try {
	manifest = loadManifest(repoRoot);
} catch (err) {
	fail(err.message);
}

let failed = false;
for (const [slug, source] of Object.entries(manifest)) {
	try {
		syncSource(repoRoot, slug, source);
	} catch (err) {
		failed = true;
		console.error(`skill sync: ${slug}: ${err.message}`);
	}
}
process.exit(failed ? 1 : 0);

function syncSource(repoRoot, slug, source) {
	const cacheDir = join(repoRoot, CACHE_DIR_NAME, slug);
	const head = refreshCache(cacheDir, source.repo);
	ensureCommitCached(cacheDir, source.pin);

	const pinTree = readUpstreamTree(cacheDir, source.pin, source.upstreamRoot);
	const fetchedTree = readUpstreamTree(cacheDir, head.commit, source.upstreamRoot);
	const localRoot = join(repoRoot, source.root);
	const localSkills = scanLocalSkills(localRoot);

	const plan = planSource({
		pin: source.pin,
		fetched: head.commit,
		localSkills,
		pinTree,
		fetchedTree,
		mergeFile: gitMergeFile,
	});

	// Apply the writes only after the whole plan is computed. Clean merges
	// and conflict markers both land here; the manifest pin lands last.
	for (const [name, files] of Object.entries(plan.writes)) {
		for (const [path, content] of Object.entries(files)) {
			const abs = join(localRoot, name, path);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}
	}
	let pinLine;
	if (plan.advancePin) {
		const oldPin = source.pin;
		source.pin = head.commit;
		saveManifest(repoRoot, manifest);
		pinLine = `  pin: ${short(oldPin)} -> ${short(head.commit)}`;
	} else if (source.pin !== head.commit) {
		const conflicts = plan.skills.filter((s) => s.status === "conflict").map((s) => s.name);
		const conflictPart = conflicts.length > 0 ? `conflict: ${conflicts.join(", ")}` : "no conflict";
		const orphanPart = plan.orphans.length > 0 ? `orphan: ${plan.orphans.join(", ")}` : "no orphan";
		pinLine = `  pin held at ${short(source.pin)} (${conflictPart}; ${orphanPart})`;
	} else {
		pinLine = `  pin: ${short(source.pin)} (no upstream change)`;
	}

	console.log(`skill sync: ${slug} (${source.repo})`);
	console.log(pinLine);
	for (const skill of plan.skills) {
		if (skill.status === "offer" || skill.status === "orphan") continue;
		console.log(`  ${skill.name}: ${skill.status}`);
		for (const file of skill.files) {
			if (file.action === "keep") continue;
			console.log(`    ${file.action} ${skill.name}/${file.path}`);
		}
		for (const note of skill.notes) console.log(`    note: ${note}`);
	}
	if (plan.offers.length > 0) {
		console.log("  offers (adopt with skills:add):");
		for (const name of plan.offers) console.log(`    ${name}`);
	}
	if (plan.orphans.length > 0) {
		console.log("  orphans (upstream deleted or renamed; kept in place):");
		for (const name of plan.orphans) console.log(`    ${name}`);
	}
}
