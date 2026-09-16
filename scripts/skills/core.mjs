// Shared logic for the skill tools:
//
//   scripts/skills/update.mjs  - skill sync (npm run skills:update)
//   scripts/skills/add.mjs     - adopt a new upstream skill (npm run skills:add)
//
// planSource() is a pure planning function: given the local tree, the
// upstream tree at the Source pin, and the fetched upstream tree, it returns
// the plan (writes, keeps, conflicts, offers, orphans, pin advance). The
// CLI layer does the git fetch, the tree reads, and the file writes.
//
// The tool never commits, pushes, deletes, or renames.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const MANIFEST_NAME = "skills-manifest.json";
export const CACHE_DIR_NAME = ".skill-cache";

export const GIT_TIMEOUT_MS = 300_000;
export const MAX_BUFFER = 512 * 1024 * 1024;

export function git(args, options = {}) {
	return execFileSync("git", args, {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: MAX_BUFFER,
		...options,
	});
}

// --- manifest ------------------------------------------------------------

/**
 * Load the skill manifest (one entry per Skill source: repo, local root,
 * upstream root, Source pin).
 *
 * @param {string} repoRoot
 * @returns {Record<string, {repo: string, root: string, upstreamRoot: string, pin: string}>}
 */
export function loadManifest(repoRoot) {
	const path = join(repoRoot, MANIFEST_NAME);
	if (!existsSync(path)) throw new Error(`no skill manifest at ${path}`);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (Object.keys(manifest).length === 0) throw new Error(`skill manifest at ${path} has no sources`);
	for (const [slug, source] of Object.entries(manifest)) {
		if (!source?.repo || !source?.root || !source?.pin) {
			throw new Error(`manifest entry ${slug} must have repo, root, and pin`);
		}
		if (!source.upstreamRoot) source.upstreamRoot = "skills";
	}
	return manifest;
}

/**
 * Save the skill manifest, pretty-printed with a trailing newline.
 *
 * @param {string} repoRoot
 * @param {Record<string, object>} manifest
 */
export function saveManifest(repoRoot, manifest) {
	writeFileSync(join(repoRoot, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");
}

// --- upstream cache -------------------------------------------------------

/**
 * Clone the upstream repo into cacheDir (or fetch it if already cloned) and
 * report the remote default-branch tip.
 *
 * @param {string} cacheDir
 * @param {string} repo - upstream repo URL or local path
 * @returns {{commit: string, branch: string}}
 */
export function refreshCache(cacheDir, repo) {
	if (!existsSync(join(cacheDir, ".git"))) {
		mkdirSync(dirname(cacheDir), { recursive: true });
		git(["clone", "--quiet", "--no-checkout", repo, cacheDir]);
	} else {
		git(["-C", cacheDir, "fetch", "--quiet", "origin"]);
	}
	const out = git(["ls-remote", "--symref", repo, "HEAD"]);
	const lines = out.trim().split("\n");
	const refLine = lines.find((line) => line.startsWith("ref: "));
	const headLine = lines.find((line) => !line.startsWith("ref: ") && line.endsWith("\tHEAD"));
	if (!headLine || !refLine) throw new Error(`cannot resolve the remote HEAD of ${repo}`);
	const commit = headLine.split("\t")[0];
	const ref = refLine.replace(/^ref: /, "").split("\t")[0];
	if (!ref.startsWith("refs/heads/")) throw new Error(`remote HEAD of ${repo} is not a branch (${ref})`);
	const branch = ref.slice("refs/heads/".length);
	const local = git(["-C", cacheDir, "rev-parse", `refs/remotes/origin/${branch}`]).trim();
	if (local !== commit) {
		git(["-C", cacheDir, "fetch", "--quiet", "origin"]);
	}
	return { commit, branch };
}

/**
 * Make sure a commit exists in the cache (the pin may predate the clone).
 *
 * @param {string} cacheDir
 * @param {string} commit
 */
export function ensureCommitCached(cacheDir, commit) {
	try {
		git(["-C", cacheDir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "pipe" });
	} catch {
		git(["-C", cacheDir, "fetch", "--quiet", "origin", commit]);
		git(["-C", cacheDir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "pipe" });
	}
}

// --- tree reads ------------------------------------------------------------

/**
 * Read the upstream tree at one commit under upstreamRoot.
 *
 * @param {string} cacheDir
 * @param {string} commit
 * @param {string} upstreamRoot - the upstream directory mirrored by the local root
 * @returns {Record<string, {files: Record<string, string>}>} keyed by skill path
 */
export function readUpstreamTree(cacheDir, commit, upstreamRoot) {
	try {
		git(["-C", cacheDir, "cat-file", "-e", `${commit}:${upstreamRoot}`], { stdio: "pipe" });
	} catch {
		return {};
	}
	const dir = mkdtempSync(join(tmpdir(), "skill-tree-"));
	try {
		const archive = git(["-C", cacheDir, "archive", commit, upstreamRoot], { encoding: "buffer" });
		execFileSync("tar", ["-x", "-C", dir], { input: archive, maxBuffer: MAX_BUFFER });
		return scanLocalSkills(join(dir, upstreamRoot));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Scan a skills root. A skill is any directory that contains a SKILL.md;
 * every file under it (references, scripts) belongs to it. Files outside
 * any skill (for example the LICENSE at a source root) are ignored.
 *
 * @param {string} rootDir
 * @returns {Record<string, {files: Record<string, string>}>} keyed by skill path relative to rootDir
 */
export function scanLocalSkills(rootDir) {
	if (!existsSync(rootDir)) return {};
	const rels = new Set();
	const walk = (dir, rel) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(abs, r);
			else if (entry.isFile()) rels.add(r);
		}
	};
	walk(rootDir, "");

	const hasSkillMd = (dirRel) => rels.has(dirRel === "" ? "SKILL.md" : `${dirRel}/SKILL.md`);
	const skillOf = (fileRel) => {
		let dir = fileRel.includes("/") ? fileRel.slice(0, fileRel.lastIndexOf("/")) : "";
		while (!hasSkillMd(dir)) {
			if (dir === "") return null;
			dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
		}
		return dir;
	};

	const tree = {};
	for (const rel of rels) {
		const key = skillOf(rel);
		if (key === null) continue;
		const skillRel = key === "" ? rel : rel.slice(key.length + 1);
		tree[key] ??= { files: {} };
		tree[key].files[skillRel] = readFileSync(join(rootDir, rel), "utf8");
	}
	return tree;
}

// --- merge ------------------------------------------------------------------

/**
 * Three-way line-level merge with `git merge-file` (base, ours, theirs).
 *
 * @param {string|null} base
 * @param {string|null} ours - null means the file is absent locally
 * @param {string|null} theirs - null means the file is absent upstream
 * @returns {{clean: boolean, content: string}} content has git conflict markers when not clean
 */
export function gitMergeFile(base, ours, theirs) {
	const dir = mkdtempSync(join(tmpdir(), "skill-merge-"));
	try {
		const basePath = join(dir, "base");
		const oursPath = join(dir, "local");
		const theirsPath = join(dir, "upstream");
		writeFileSync(basePath, base ?? "");
		writeFileSync(oursPath, ours ?? "");
		writeFileSync(theirsPath, theirs ?? "");
		try {
			const out = git(["merge-file", "--stdout", oursPath, basePath, theirsPath], { encoding: "utf8" });
			return { clean: true, content: out };
		} catch (err) {
			// git merge-file exits with the number of conflicts when the merge
			// is not clean, and 128 on error. The merged (marked) content is
			// on stdout in both cases.
			// A killed or timed-out run (err.killed, status null) is a hard
			// failure: the captured stdout is not a usable merge result.
			if (err.killed || err.status == null || err.status === 128) {
				throw new Error(`git merge-file failed: ${String(err.stderr ?? err.message).trim()}`);
			}
			return { clean: false, content: String(err.stdout ?? "") };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- plan -------------------------------------------------------------------

/**
 * Pure planning function (the unit seam). Given the local root state, the
 * pin, and the fetched upstream tree, returns the plan.
 *
 * A skill is tracked iff its directory exists locally and at its upstream
 * path in the fetched tree. Skills absent upstream are orphans; upstream
 * skills absent locally are offers. The Source pin advances iff the fetched
 * commit differs from the pin and no tracked skill came back as conflict
 * or orphan.
 *
 * @param {object} input
 * @param {string} input.pin
 * @param {string} input.fetched
 * @param {Record<string, {files: Record<string, string>}>} input.localSkills
 * @param {Record<string, {files: Record<string, string>}>} input.pinTree
 * @param {Record<string, {files: Record<string, string>}>} input.fetchedTree
 * @param {function} input.mergeFile - (base, ours, theirs) => {clean, content}
 * @returns {object} {skills, writes, offers, orphans, advancePin}
 */
export function planSource(input) {
	const { localSkills, pinTree, fetchedTree, mergeFile } = input;
	const skills = [];
	const writes = {};
	const offers = [];
	const orphans = [];

	const localNames = Object.keys(localSkills).sort();
	for (const name of localNames) {
		const local = localSkills[name];
		const pin = pinTree[name];
		const fetched = fetchedTree[name];
		if (!fetched) {
			orphans.push(name);
			skills.push({ name, status: "orphan", files: [], notes: ["absent at the fetched upstream commit; kept in place"] });
			continue;
		}
		const files = [];
		const skillWrites = {};
		const notes = [];
		let conflict = false;
		let written = 0;

		const paths = new Set([
			...Object.keys(local.files),
			...Object.keys(pin?.files ?? {}),
			...Object.keys(fetched.files),
		]);
		for (const path of [...paths].sort()) {
			const base = pin?.files[path] ?? null;
			const ours = local.files[path] ?? null;
			const theirs = fetched.files[path] ?? null;

			if (theirs != null) {
				const merged = mergeFile(base, ours, theirs);
				if (merged.clean) {
					if (ours === null && merged.content === "") {
						files.push({ path, action: "keep" });
						notes.push(`kept the local deletion of ${name}/${path} (unchanged upstream)`);
					} else if (ours === null || merged.content !== ours) {
						skillWrites[path] = merged.content;
						files.push({ path, action: "write" });
						written++;
					} else {
						files.push({ path, action: "keep" });
					}
				} else {
					conflict = true;
					skillWrites[path] = merged.content;
					files.push({ path, action: "conflict" });
				}
			} else if (ours != null) {
				if (base != null && ours !== base) {
					conflict = true;
					files.push({ path, action: "conflict" });
					notes.push(`upstream deleted ${name}/${path}; the local copy has local changes`);
				} else if (base != null) {
					files.push({ path, action: "keep" });
					notes.push(`upstream deleted ${name}/${path}; kept the local copy`);
				} else {
					files.push({ path, action: "keep" });
				}
			}
		}

		if (Object.keys(skillWrites).length > 0) writes[name] = skillWrites;
		skills.push({
			name,
			status: conflict ? "conflict" : written > 0 ? "clean" : "unchanged",
			files,
			notes,
		});
	}

	for (const name of Object.keys(fetchedTree).sort()) {
		if (!(name in localSkills)) {
			offers.push(name);
			skills.push({ name, status: "offer", files: [], notes: ["new upstream skill; adopt with skills:add"] });
		}
	}

	skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

	return {
		skills,
		writes,
		offers,
		orphans,
		advancePin: input.pin !== input.fetched && !skills.some((s) => s.status === "conflict" || s.status === "orphan"),
	};
}
