/**
 * E2E for skill-migrate: drives the real CLI (extensions/skill-migrate/cli.mjs)
 * against fixture repos built in a temp dir. No network.
 *
 *   node tests/skill-migrate/e2e-migrate.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const cliPath = join(repoRoot, "extensions", "skill-migrate", "cli.mjs");
const CHANGELOG = ".pi/skill-migrate_changelog.json";

let failures = 0;
function check(cond, label) {
	if (cond) console.log(`  ok ${label}`);
	else {
		failures++;
		console.error(`  FAIL ${label}`);
	}
}

function fixture(name) {
	const dir = join(tmpdir(), `skill-migrate-e2e-${name}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFile(dir, rel, content) {
	const path = join(dir, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function run(args, cwd) {
	const result = spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: "utf8",
	});
	return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function expectedIdentity() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	} catch {
		return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	}
}

// ---------------------------------------------------------------------------
// 1. status on a void repo
// ---------------------------------------------------------------------------
console.log("status on a void repo");
{
	const dir = fixture("void");
	writeFile(dir, "CONTEXT.md", "# Glossary\n\nSee CONTEXT-MAP.md.\n");
	try {
		const result = run(["status"], dir);
		check(result.code === 0, "exit 0");
		check(result.out.includes("Current version: void"), "reports void");
		check(!existsSync(join(dir, CHANGELOG)), "changes nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 2. full migrate on a multi-context fixture
// ---------------------------------------------------------------------------
console.log("migrate void to 2 on a multi-context fixture");
{
	const dir = fixture("multi");
	writeFile(dir, "CONTEXT-MAP.md", ["# Context Map", "", "- [Ordering](./src/ordering/CONTEXT.md): orders", "- [Billing](./src/billing/CONTEXT.md): invoices", ""].join("\n"));
	writeFile(dir, "src/ordering/CONTEXT.md", "# Ordering\n\nOrdering emits events. See CONTEXT-FORMAT.md.\n");
	writeFile(dir, "src/billing/CONTEXT.md", "# Billing\n");
	writeFile(dir, "README.md", "The glossary is CONTEXT.md.\n");
	const identity = expectedIdentity();
	try {
		const migrated = run(["migrate"], dir);
		check(migrated.code === 0, "exit 0");
		check(existsSync(join(dir, "GLOSSARY-MAP.md")), "CONTEXT-MAP.md renamed");
		check(!existsSync(join(dir, "CONTEXT-MAP.md")), "old map gone");
		check(existsSync(join(dir, "src/ordering/GLOSSARY.md")), "per-context glossary renamed by the map's path");
		check(existsSync(join(dir, "src/billing/GLOSSARY.md")), "second per-context glossary renamed");
		check(readFileSync(join(dir, "README.md"), "utf8") === "The glossary is GLOSSARY.md.\n", "reference rewritten");
		check(readFileSync(join(dir, "GLOSSARY-MAP.md"), "utf8").includes("./src/ordering/GLOSSARY.md"), "map references rewritten");
		const changelog = JSON.parse(readFileSync(join(dir, CHANGELOG), "utf8"));
		check(changelog.migrations.length === 2, "two records");
		check(changelog.migrations[0].version === 1 && changelog.migrations[0].migration === "create-changelog", "record 1 is create-changelog");
		check(changelog.migrations[1].version === 2 && changelog.migrations[1].migration === "glossary-rename", "record 2 is glossary-rename");
		check(changelog.migrations.every((r) => r.identity === identity), `records carry the checkout identity ${identity.slice(0, 7)}`);
		check(changelog.migrations.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.dateTime)), "date times are ISO-8601 UTC");

		const after = run(["status"], dir);
		check(after.code === 0 && after.out.includes("Current version: 2"), "status reports version 2");
		check(after.out.includes("Up to date"), "status reports up to date");

		const reRun = run(["migrate"], dir);
		check(reRun.code === 0 && reRun.out.includes("Up to date"), "re-run is a no-op");
		check(JSON.parse(readFileSync(join(dir, CHANGELOG), "utf8")).migrations.length === 2, "re-run appends nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 3. ambiguous root state aborts and appends nothing
// ---------------------------------------------------------------------------
console.log("ambiguous root state aborts");
{
	const dir = fixture("ambiguous");
	writeFile(dir, "CONTEXT.md", "# old\n");
	writeFile(dir, "GLOSSARY.md", "# new\n");
	writeFile(dir, CHANGELOG, JSON.stringify({ migrations: [{ version: 1, migration: "create-changelog", identity: "x", dateTime: "2026-01-01T00:00:00.000Z" }] }, null, 2) + "\n");
	const before = readFileSync(join(dir, CHANGELOG), "utf8");
	try {
		const result = run(["migrate"], dir);
		check(result.code === 1, "exit 1");
		check(result.err.includes("ambiguous state"), "names the ambiguity");
		check(readFileSync(join(dir, CHANGELOG), "utf8") === before, "changelog untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 4. malformed changelog is rejected with a clear error
// ---------------------------------------------------------------------------
console.log("malformed changelog is rejected");
{
	const dir = fixture("malformed");
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(join(dir, ".pi", "skill-migrate_changelog.json"), "not json");
	try {
		const result = run(["status"], dir);
		check(result.code === 1, "status exit 1");
		check(result.err.includes("Malformed migration changelog"), "clear error message");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 5. usage errors
// ---------------------------------------------------------------------------
console.log("usage errors");
{
	const dir = fixture("usage");
	try {
		check(run([], dir).code === 2, "no command exits 2");
		check(run(["frobnicate"], dir).code === 2, "unknown command exits 2");
		check(run(["migrate", "a", "b"], dir).code === 2, "two repo paths exit 2");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 6. --identity override is recorded
// ---------------------------------------------------------------------------
console.log("identity override");
{
	const dir = fixture("identity");
	writeFile(dir, "CONTEXT.md", "# glossary\n");
	try {
		const result = run(["migrate", "--identity", "pkg-0.1.0"], dir);
		check(result.code === 0, "exit 0");
		const changelog = JSON.parse(readFileSync(join(dir, CHANGELOG), "utf8"));
		check(changelog.migrations.every((r) => r.identity === "pkg-0.1.0"), "override recorded in every record");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall e2e checks passed");
