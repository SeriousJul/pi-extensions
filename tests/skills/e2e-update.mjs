/**
 * E2E for the skill sync tools (scripts/skills/update.mjs and add.mjs).
 *
 * Runs the real tools against a fixture upstream git repo (created in a
 * temp dir, cloned by path) and a fixture local tree. No network, no real
 * upstream repo. Covers:
 *
 *   - no-op re-run
 *   - clean upstream change (pin advances)
 *   - local-only change preserved
 *   - both-sides conflict (git conflict markers, pin held)
 *   - resolve-then-resync (pin advances)
 *   - new-skill offer and adopt (adopted skill tracked by the next sync)
 *   - a bucket-less second source: offers printed as <slug>/<name>, adopted
 *     by skills:add, rejected without the slug
 *   - orphan report (skill kept, pin held, cleared when the local dir goes)
 *   - local-only skills under skills/local never read, merged, or reported
 *   - failed fetch leaves the tree and the pin untouched
 *
 *   node tests/skills/e2e-update.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
function check(cond, label) {
	if (cond) console.log(`  ok ${label}`);
	else {
		failures++;
		console.error(`  FAIL ${label}`);
	}
}

// --- sandbox -----------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "skills-e2e-"));
const upstream = join(sandbox, "upstream");
const upstreamFlat = join(sandbox, "upstream-flat");
const root = join(sandbox, "repo");
const localRoot = join(root, "skills", "fixture");
const localFlatRoot = join(root, "skills", "flat");
const localOnly = join(root, "skills", "local", "myskill", "SKILL.md");

console.log(`sandbox: ${sandbox}`);
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function commitUpstream(message, files, repo = upstream) {
	for (const [rel, content] of Object.entries(files ?? {})) {
		const abs = join(repo, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	git(["-C", repo, "add", "-A"]);
	git(["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "--quiet", "-m", message]);
	return git(["-C", repo, "rev-parse", "HEAD"]);
}

function runTool(script, args = []) {
	return spawnSync("node", [join(repoRoot, "scripts", "skills", script), ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			SKILL_SYNC_ROOT: root,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
		},
	});
}

let c2, c3, c4, c5, c6, c7b;

function manifest() {
	return JSON.parse(readFileSync(join(root, "skills-manifest.json"), "utf8"));
}

function treeFingerprint() {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of execFileSync("find", [dir, "-type", "f"]).toString().trim().split("\n").filter(Boolean)) {
			out.push(`${entry}=${readFileSync(entry, "utf8")}`);
		}
	};
	walk(join(root, "skills"));
	return out.sort().join("\n");
}

// --- fixture ------------------------------------------------------------------

execFileSync("git", ["init", "--quiet", "-b", "main", upstream], { encoding: "utf8" });
const c1 = commitUpstream("initial", {
	"skills/engineering/alpha/SKILL.md": "alpha v1\n",
	"skills/engineering/beta/SKILL.md": "beta v1\n",
	"skills/engineering/beta/refs.md": "refs v1\n",
	"skills/productivity/gamma/SKILL.md": "gamma v1\n",
	"LICENSE": "MIT License (fixture)\n",
});

// A second, bucket-less upstream repo: its skills sit directly under its
// skills/ root, so its local paths carry no bucket segment.
execFileSync("git", ["init", "--quiet", "-b", "main", upstreamFlat], { encoding: "utf8" });
const c1b = commitUpstream("initial", {
	"skills/one/SKILL.md": "one v1\n",
	"skills/two/SKILL.md": "two v1\n",
	"LICENSE": "MIT License (flat fixture)\n",
}, upstreamFlat);

mkdirSync(root, { recursive: true });
writeFileSync(join(root, "skills-manifest.json"), JSON.stringify({
	fixture: {
		repo: upstream,
		root: "skills/fixture",
		upstreamRoot: "skills",
		pin: c1,
	},
	flat: {
		repo: upstreamFlat,
		root: "skills/flat",
		upstreamRoot: "skills",
		pin: c1b,
	},
}, null, 2) + "\n");

const stage = join(sandbox, "stage");
mkdirSync(stage, { recursive: true });
const archive = execFileSync("git", ["-C", upstream, "archive", c1, "skills"], { encoding: "buffer" });
execFileSync("tar", ["-x", "-C", stage], { input: archive });
mkdirSync(join(root, "skills"), { recursive: true });
renameSync(join(stage, "skills"), localRoot);

// Adopt only `one` from the flat source at the start; `two` stays an offer
// so the first run can be checked for its offer form.
const flatStage = join(sandbox, "flat-stage");
mkdirSync(flatStage, { recursive: true });
const flatArchive = execFileSync("git", ["-C", upstreamFlat, "archive", c1b, "skills/one"], { encoding: "buffer" });
execFileSync("tar", ["-x", "-C", flatStage], { input: flatArchive });
mkdirSync(localFlatRoot, { recursive: true });
renameSync(join(flatStage, "skills", "one"), join(localFlatRoot, "one"));
rmSync(flatStage, { recursive: true, force: true });

mkdirSync(dirname(localOnly), { recursive: true });
writeFileSync(localOnly, "local only skill\n");
const localOnlyContent = readFileSync(localOnly, "utf8");

// 1. first run: everything agrees, no writes, pin stays, the unadopted
// flat skill is offered as <slug>/<name>.
console.log("\n1. first run (no-op, one offer)");
{
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(manifest().fixture.pin === c1, "fixture pin unchanged");
	check(manifest().flat.pin === c1b, "flat pin unchanged");
	for (const name of ["engineering/alpha: unchanged", "engineering/beta: unchanged", "productivity/gamma: unchanged", "one: unchanged"]) {
		check(r.stdout.includes(`  ${name}`), `reports ${name}`);
	}
	check(r.stdout.includes("offers (adopt with skills:add):"), "offers header printed");
	check(r.stdout.includes("    flat/two"), "bucket-less offer printed as <slug>/<name>");
	check(!existsSync(join(localFlatRoot, "two")), "offer never adopted on its own");
}

// 2. re-run with no changes anywhere: still a no-op.
console.log("\n2. no-op re-run");
{
	const before = treeFingerprint();
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(manifest().fixture.pin === c1, "pin unchanged");
	check(treeFingerprint() === before, "tree byte-identical");
}

// 3. clean upstream change applies, pin advances.
console.log("\n3. clean upstream change");
{
	c2 = commitUpstream("alpha v2", { "skills/engineering/alpha/SKILL.md": "alpha v2\n" });
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(readFileSync(join(localRoot, "engineering/alpha/SKILL.md"), "utf8") === "alpha v2\n", "alpha updated to upstream content");
	check(manifest().fixture.pin === c2, "pin advanced to the fetched commit");
	check(r.stdout.includes("engineering/alpha: clean"), "alpha reported clean");
}

// 4. local-only change preserved while an unrelated upstream file moves.
console.log("\n4. local-only change preserved");
{
	writeFileSync(join(localRoot, "productivity/gamma/SKILL.md"), "gamma local tweak\n");
	c3 = commitUpstream("refs v2", { "skills/engineering/beta/refs.md": "refs v2\n" });
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(readFileSync(join(localRoot, "productivity/gamma/SKILL.md"), "utf8") === "gamma local tweak\n", "gamma keeps the local tweak");
	check(readFileSync(join(localRoot, "engineering/beta/refs.md"), "utf8") === "refs v2\n", "beta/refs.md updated");
	check(manifest().fixture.pin === c3, "pin advanced");
}

// 5. both-sides change: markers in place, pin held.
console.log("\n5. both-sides conflict");
{
	writeFileSync(join(localRoot, "engineering/beta/SKILL.md"), "beta local tweak\n");
	c4 = commitUpstream("beta v2", { "skills/engineering/beta/SKILL.md": "beta v2 upstream\n" });
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	const content = readFileSync(join(localRoot, "engineering/beta/SKILL.md"), "utf8");
	check(content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>"), "file carries git conflict markers");
	check(content.includes("beta local tweak") && content.includes("beta v2 upstream"), "both sides visible in the markers");
	check(manifest().fixture.pin === c3, "pin held at the previous commit");
	check(r.stdout.includes("engineering/beta: conflict"), "beta reported conflict");
}

// 6. resolve the conflict, resync: pin advances.
console.log("\n6. resolve-then-resync");
{
	writeFileSync(join(localRoot, "engineering/beta/SKILL.md"), "beta v2 upstream\n");
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(!readFileSync(join(localRoot, "engineering/beta/SKILL.md"), "utf8").includes("<<<<<<<"), "markers gone after resolution");
	check(manifest().fixture.pin === c4, "pin advanced past the conflict");
}

// 7. new upstream skills offered in the add form, adopted, then tracked.
// Covers both shapes: a bucketed skill on the bucketed source and a
// bucket-less skill on the flat source.
console.log("\n7. offer and adopt");
{
	c5 = commitUpstream("add delta", { "skills/engineering/delta/SKILL.md": "delta v1\n" });
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(r.stdout.includes("    fixture/engineering/delta"), "bucketed offer printed as <slug>/<bucket>/<name>");
	check(r.stdout.includes("    flat/two"), "bucket-less offer still printed as <slug>/<name>");
	check(!existsSync(join(localRoot, "engineering/delta")), "offer never adopted on its own");
	check(manifest().fixture.pin === c5, "pin advances past an offer");

	const a = runTool("add.mjs", ["fixture/engineering/delta"]);
	check(a.status === 0, `skills:add exit 0 (got ${a.status})`);
	check(readFileSync(join(localRoot, "engineering/delta/SKILL.md"), "utf8") === "delta v1\n", "adopted skill copied at the mirrored path");

	const flatAdd = runTool("add.mjs", ["flat/two"]);
	check(flatAdd.status === 0, `skills:add on a bucket-less skill exit 0 (got ${flatAdd.status})`);
	check(readFileSync(join(localFlatRoot, "two/SKILL.md"), "utf8") === "two v1\n", "bucket-less skill adopted at the mirrored path");

	const bare = runTool("add.mjs", ["two"]);
	check(bare.status === 1, "a bare bucket-less name is rejected");
	const unslugged = runTool("add.mjs", ["engineering/delta"]);
	check(unslugged.status === 1, "a bucketed path without its source slug is rejected");

	const again = runTool("add.mjs", ["fixture/engineering/delta"]);
	check(again.status === 1, "re-adopting an existing skill fails");

	c6 = commitUpstream("delta v2", { "skills/engineering/delta/SKILL.md": "delta v2\n" });
	const r2 = runTool("update.mjs");
	check(r2.status === 0, `exit 0 (got ${r2.status})`);
	check(readFileSync(join(localRoot, "engineering/delta/SKILL.md"), "utf8") === "delta v2\n", "adopted skill tracked by the next sync");
	check(readFileSync(join(localFlatRoot, "two/SKILL.md"), "utf8") === "two v1\n", "flat adopted skill untouched by the sync");
	check(manifest().fixture.pin === c6, "pin advanced");
}

// 8. upstream deletion: orphan reported, skill kept, pin held, then cleared.
console.log("\n8. orphan");
{
	git(["-C", upstream, "rm", "-r", "--quiet", "skills/productivity/gamma"]);
	git(["-C", upstream, "-c", "user.name=fixture", "-c", "user.email=fixture@local", "commit", "--quiet", "-m", "delete gamma"]);
	c7b = git(["-C", upstream, "rev-parse", "HEAD"]);
	const r = runTool("update.mjs");
	check(r.status === 0, `exit 0 (got ${r.status})`);
	check(r.stdout.includes("productivity/gamma") && r.stdout.toLowerCase().includes("orphan"), "gamma reported as an orphan");
	check(existsSync(join(localRoot, "productivity/gamma/SKILL.md")), "orphan skill kept in place");
	check(manifest().fixture.pin === c6, "pin held while the orphan is unresolved");

	rmSync(join(localRoot, "productivity/gamma"), { recursive: true, force: true });
	const r2 = runTool("update.mjs");
	check(r2.status === 0, `exit 0 (got ${r2.status})`);
	check(!r2.stdout.toLowerCase().includes("orphan"), "no orphan once the local dir is gone");
	check(manifest().fixture.pin === c7b, "pin advanced after the orphan was resolved");
}

// 9. local-only skills are never read, merged, or reported.
console.log("\n9. local-only skills invisible to sync");
{
	check(readFileSync(localOnly, "utf8") === localOnlyContent, "skills/local/myskill untouched");
	const r = runTool("update.mjs");
	check(!r.stdout.includes("myskill"), "myskill never in the report");
}

// 10. failed fetch: plain error, tree and pin untouched.
console.log("\n10. failed fetch");
{
	const manifestPath = join(root, "skills-manifest.json");
	const original = readFileSync(manifestPath, "utf8");
	const before = treeFingerprint();
	const m = manifest();
	m.fixture.repo = join(sandbox, "does-not-exist");
	writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
	const r = runTool("update.mjs");
	check(r.status === 1, `exit 1 (got ${r.status})`);
	check(r.stderr.includes("skill sync"), "plain error on stderr");
	check(readFileSync(manifestPath, "utf8") === JSON.stringify(m, null, 2) + "\n", "manifest untouched");
	check(treeFingerprint() === before, "tree untouched");
	writeFileSync(manifestPath, original);
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall e2e checks passed");
