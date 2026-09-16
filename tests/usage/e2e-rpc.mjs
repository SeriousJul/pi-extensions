/**
 * E2E for the usage extension.
 *
 * 1. The CLI scans a fixture session tree (via PI_SESSIONS_DIR) and reports
 *    the exact totals, in text and JSON form.
 * 2. A real pi process in RPC mode runs /usage against the same fixture and
 *    emits the report as a notify record.
 *
 * The pi run uses the real HOME so it starts with a working model config;
 * the extension's data path is the fixture, pointed to by PI_SESSIONS_DIR.
 *
 *   node tests/usage/e2e-rpc.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "usage", "index.ts");
const cliPath = join(repoRoot, "extensions", "usage", "cli.mjs");
const TIMEOUT_MS = 60_000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

// --- fixture ----------------------------------------------------------------
// One session: 1,700 tokens on the assistant message plus 15 tokens on a
// compaction entry (no provider of its own). Grand total: 1,715 tokens.
const now = Date.now();
const h = 3_600_000;
const m = 60_000;
const fixtureLines = [
	JSON.stringify({ type: "session", id: "e2e-sess1", version: 3, timestamp: new Date(now - 3 * h).toISOString(), cwd: "/e2e" }),
	JSON.stringify({ type: "model_change", id: "e2e00001", parentId: null, timestamp: new Date(now - 3 * h + 1_000).toISOString(), provider: "openai-codex", modelId: "gpt-5.6-luna" }),
	JSON.stringify({
		type: "message",
		id: "e2e00002",
		parentId: "e2e00001",
		timestamp: new Date(now - h).toISOString(),
		message: {
			role: "assistant",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 100, reasoning: 0, totalTokens: 1700, cost: { total: 0.05 } },
		},
	}),
	JSON.stringify({
		type: "compaction",
		id: "e2e00003",
		parentId: "e2e00002",
		timestamp: new Date(now - 30 * m).toISOString(),
		usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
	}),
];
const fixtureDir = mkdtempSync(join(tmpdir(), "usage-e2e-sessions-"));
const fixtureSlug = join(fixtureDir, "e2e");
mkdirSync(fixtureSlug, { recursive: true });
writeFileSync(join(fixtureSlug, "e2e0000001.jsonl"), fixtureLines.join("\n") + "\n");

function withFixtureEnv() {
	return { ...process.env, PI_SESSIONS_DIR: fixtureDir };
}

// --- 1: CLI -------------------------------------------------------------------

const textRun = spawnSync(process.execPath, [cliPath, "report", "--by", "day"], { env: withFixtureEnv(), encoding: "utf8" });
if (textRun.status !== 0) fail(`cli report: ${textRun.stderr}`);
if (!textRun.stdout.includes("1,715")) fail(`cli report missing total 1,715:\n${textRun.stdout}`);
if (!textRun.stdout.includes("gpt-5.6-luna")) fail(`cli report missing model:\n${textRun.stdout}`);
if (!textRun.stdout.includes("TOTAL")) fail(`cli report missing TOTAL row:\n${textRun.stdout}`);
console.log("ok: cli report renders the fixture totals");

const jsonRun = spawnSync(process.execPath, [cliPath, "report", "--json", "--by", "day"], { env: withFixtureEnv(), encoding: "utf8" });
if (jsonRun.status !== 0) fail(`cli report --json: ${jsonRun.stderr}`);
const json = JSON.parse(jsonRun.stdout);
if (json.total.total !== 1715) fail(`cli json total is ${json.total.total}, expected 1715`);
if (Math.abs(json.total.cost - 0.051) > 1e-9) fail(`cli json cost is ${json.total.cost}, expected 0.051`);
if (json.rows.length === 0) fail("cli json has no rows");
console.log("ok: cli report --json carries exact totals");

const sessionsRun = spawnSync(process.execPath, [cliPath, "sessions"], { env: withFixtureEnv(), encoding: "utf8" });
if (sessionsRun.status !== 0) fail(`cli sessions: ${sessionsRun.stderr}`);
if (!sessionsRun.stdout.includes("e2e0000001.jsonl")) fail(`cli sessions missing the fixture file:\n${sessionsRun.stdout}`);
console.log("ok: cli sessions lists the fixture session");

const badRun = spawnSync(process.execPath, [cliPath, "report", "--since", "3d"], { env: withFixtureEnv(), encoding: "utf8" });
if (badRun.status !== 1) fail(`cli bad flag should exit 1, got ${badRun.status}`);
console.log("ok: cli rejects an unknown window");

// --- 2: pi RPC -------------------------------------------------------------------

function startRpc() {
	const cwd = mkdtempSync(join(tmpdir(), "usage-e2e-"));
	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy and the duplicate command name
	// (usage:1) stops /usage resolving.
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extensionPath], {
		cwd,
		env: withFixtureEnv(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const notifies = [];
	const extensionErrors = [];
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (record.type === "extension_error") extensionErrors.push(record);
				if (record.type === "extension_ui_request" && record.method === "notify") notifies.push(record);
				if (record.type === "response" && record.id && pending.has(record.id)) {
					const waiter = pending.get(record.id);
					pending.delete(record.id);
					waiter(record);
				}
			} catch {
				// Non-JSONL startup noise; the protocol is JSONL after that.
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const request = (command, fields = {}) =>
		new Promise((resolve, reject) => {
			const id = `req-${nextId++}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timed out waiting for ${command}\nstderr:\n${stderr}`));
			}, TIMEOUT_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve(record);
			});
			child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n");
		});
	return {
		request,
		notifies,
		extensionErrors,
		getStderr: () => stderr,
		close() {
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

const rpc = startRpc();
try {
	const usage = await rpc.request("prompt", { message: "/usage" });
	if (!usage.success) fail(`/usage: ${JSON.stringify(usage)}`);

	// The scan takes a moment; poll for the notify record.
	let note;
	const deadline = Date.now() + 30_000;
	for (;;) {
		note = rpc.notifies[rpc.notifies.length - 1];
		if (note) break;
		if (Date.now() > deadline) fail(`no notify record from /usage within 30s; stderr:\n${rpc.getStderr()}`);
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	const message = note.message ?? "";
	if (!message.includes("1,715")) fail(`/usage notify missing total 1,715:\n${message}`);
	if (!message.includes("gpt-5.6-luna")) fail(`/usage notify missing model:\n${message}`);
	console.log("ok: /usage over RPC reports the fixture totals");
} finally {
	if (rpc.extensionErrors.length > 0) fail(`extension_error events: ${JSON.stringify(rpc.extensionErrors)}`);
	rpc.close();
}

rmSync(fixtureDir, { recursive: true, force: true });
console.log("usage E2E passed");
