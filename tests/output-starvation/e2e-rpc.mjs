/**
 * E2E for the output-starvation guard (ADR 0028).
 *
 * Spawns a real pi process in RPC mode in a throwaway agent directory,
 * points it at this repository's extension and at the shared mock llama.cpp
 * router (tests/shared/llama-mock-router.mjs), and asserts what a live
 * session does when the request's output budget collapses to pi's floor:
 *
 *   1. healthy turn: a request whose budget pi clamped to a real number
 *      goes out untouched, and the guard says nothing
 *   2. starved turn: a request whose budget is pi's floor is refused -
 *      the report line arrives verbatim, the provider is never contacted,
 *      and the turn ends as an abort instead of a one-token `length` turn
 *   3. at most once per turn: a second starved request in the same turn
 *      adds nothing, and the next turn refuses again on its own budget
 *   4. compaction still rescues: the same stale-usage session, but with
 *      auto-compaction on - pi compacts the session on load, the first
 *      request goes out with a healthy budget, and the guard stays silent
 *   5. starved with pruning loaded: the stale-usage session with
 *      auto-compaction off and Pruning loaded. Pruning's first level stays
 *      out (the resumed session's runtime system prompt breaks its entry
 *      alignment), yet the request is still starved on the usage the clamp
 *      reads - the guard refuses and the provider is never contacted
 *
 * Any extension_error event fails the run.
 *
 *   node tests/output-starvation/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { startLlamaMockRouter } from "../shared/llama-mock-router.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const guardExtension = join(repoRoot, "extensions", "output-starvation", "index.ts");
const pruningExtension = join(repoRoot, "extensions", "pruning", "index.ts");
const TIMEOUT_MS = 60_000;
const MODEL = "m1";

const running = [];
function fail(message) {
	console.error(`FAIL: ${message}`);
	for (const closer of running) Promise.resolve(closer()).catch(() => undefined);
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, what, timeoutMs = TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probe()) return;
		if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

/** One line per refusal, in the glossary's vocabulary (guard.ts builds it). */
const starvedLine = (estimate, window, budget) =>
	`output starvation: refused (llama.cpp/${MODEL}): context estimate ${estimate}, Effective window ${window}, output budget ${budget}`;

function prepareAgentDir(url, { compactionEnabled = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "output-starvation-e2e-"));
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
		}),
	);
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			defaultProvider: "llama.cpp",
			defaultModel: MODEL,
			defaultThinkingLevel: "off",
			// A refused turn must not sit through request retries.
			retry: { enabled: false },
			compaction: { enabled: compactionEnabled },
		}),
	);
	return dir;
}

/** The big prompt of scenarios 1-3: ~13.7k tokens of plain text. */
const BIG_PROMPT = "filler ".repeat(11000);

/** Build the scenario-5 session: one old turn with a big prunable tool
 * output and a final assistant message whose provider usage carries the
 * big context (36500 tokens), over the saturation edge of the 40192 window
 * (window minus 4096 = 36096). Written with the child's cwd so pi's session
 * cwd check passes. */
function prebuildStaleSession(agentDir) {
	const builder = SessionManager.create(agentDir, join(agentDir, "sessions"));
	const clock = 1_000_000;
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	builder.appendMessage({ role: "user", content: "Run the test suite and tell me what failed.", timestamp: clock });
	builder.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
		api: "openai-completions",
		provider: "llama.cpp",
		model: MODEL,
		usage: { input: 0, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zeroCost },
		stopReason: "toolUse",
		timestamp: clock + 1,
	});
	// ~590k characters of log output: 147k tokens, the kind of thing Pruning
	// replaces with a marker on every outgoing request.
	builder.appendMessage({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: Array.from({ length: 14000 }, (_, i) => `test log line ${i + 1} with a little padding`).join("\n") }],
		isError: false,
		timestamp: clock + 2,
	});
	builder.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "The suite finished; 3 specs failed." }],
		api: "openai-completions",
		provider: "llama.cpp",
		model: MODEL,
		usage: { input: 36480, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 36500, cost: zeroCost },
		stopReason: "stop",
		timestamp: clock + 3,
	});
	return builder.getSessionFile();
}

function startRpc(agentDir, extraArgs = [], extraExtensions = []) {
	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy of every extension and the
	// duplicate flag registration stops the session starting.
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--no-extensions", "--extension", guardExtension, ...extraExtensions, ...extraArgs],
		{
			cwd: agentDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const notifies = [];
	const events = [];
	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				// Non-JSONL startup noise; the protocol is JSONL after that.
				continue;
			}
			if (record.type === "extension_error") {
				fail(`extension_error: ${JSON.stringify(record)}`);
			}
			if (record.type === "extension_ui_request" && record.method === "notify") {
				notifies.push(record.message);
			}
			if (record.type === "response" && record.id && pending.has(record.id)) {
				const waiter = pending.get(record.id);
				pending.delete(record.id);
				waiter(record);
				continue;
			}
			if (record.type) events.push(record);
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
		events,
		close() {
			child.kill();
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** Start a mock + a pi session on it, and wait until the session resolves the model at the expected window. With `prebuildStaleSession`, the child
 * starts from the pre-built stale-usage session (scenario 5). */
async function startSession(window, { compactionEnabled = true, extraExtensions = [], prebuild = false } = {}) {
	const mock = await startLlamaMockRouter({ models: { [MODEL]: { nCtx: window, status: "loaded" } } });
	const agentDir = prepareAgentDir(mock.url, { compactionEnabled });
	// The pre-built session must record the child's cwd, so build it after
	// the agent dir exists and pass it through --session.
	const sessionArgs = prebuild ? ["--session", prebuildStaleSession(agentDir)] : [];
	const rpc = startRpc(agentDir, sessionArgs, extraExtensions);
	running.push(() => rpc.close());
	await waitFor(async () => {
		const available = await rpc.request("get_available_models");
		return available.success && (available.data?.models ?? []).some((model) => model.provider === "llama.cpp" && model.id === MODEL);
	}, `catalog to list ${MODEL}`, 90_000);
	const selected = await rpc.request("set_model", { provider: "llama.cpp", modelId: MODEL });
	if (!selected.success) fail(`set_model: ${JSON.stringify(selected)}`);
	await waitFor(async () => {
		const state = await rpc.request("get_state");
		return state.success && state.data?.model?.id === MODEL && state.data.model.contextWindow === window;
	}, `session ${MODEL} at window ${window}`, 90_000);
	return { mock, rpc };
}

const countEvents = (rpc, type) => rpc.events.filter((event) => event.type === type).length;

/** The turn_end events' assistant stop reasons, in order. */
const stopReasons = (rpc) =>
	rpc.events
		.filter((event) => event.type === "turn_end")
		.map((event) => event.message?.stopReason)
		.filter((reason) => reason !== undefined);

/** Prompt and wait until the run has fully settled (agent_settled). */
async function prompt(rpc, message) {
	const settled = countEvents(rpc, "agent_settled");
	const result = await rpc.request("prompt", { message });
	if (!result.success) fail(`prompt: ${JSON.stringify(result)}`);
	// pi emits the agent_settled event only after the extension's settled
	// handler finishes, so by the time this observation lands the refusal
	// (or the response) is fully recorded.
	await waitFor(() => countEvents(rpc, "agent_settled") > settled, "the run to settle", TIMEOUT_MS);
}

const starvedNotifies = (rpc) => rpc.notifies.filter((line) => line.startsWith("output starvation:"));
const mockBudgets = (mock) => mock.requests.map((request) => request.maxTokens);

// ---------------------------------------------------------------------------
// 1-3. Refusal: a healthy turn goes out, a starved one is refused, and a
//      refusal happens at most once per turn (compaction off, so nothing
//      else is in the picture).
// ---------------------------------------------------------------------------
{
	const window = 16000;
	const { mock, rpc } = await startSession(window, { compactionEnabled: false });

	// 1. The healthy turn: the request goes out with a real budget and the
	// guard says nothing.
	await prompt(rpc, "Reply with exactly: OK");
	if (mock.requests.length !== 1) fail(`expected exactly one provider request after the healthy turn, got ${mock.requests.length}`);
	const healthyBudget = mock.requests[0].maxTokens;
	if (healthyBudget <= 1) fail(`the healthy request's budget is ${healthyBudget}, expected a real number above pi's floor`);
	if (starvedNotifies(rpc).length !== 0) fail(`the guard spoke on a healthy turn: ${starvedNotifies(rpc)}`);
	if (!stopReasons(rpc).includes("stop")) fail(`the healthy turn did not end stop: ${stopReasons(rpc)}`);

	// 2. The starved turn: the context estimate (the healthy turn's usage
	// plus this prompt's characters) leaves the clamp nothing, so the
	// budget is pi's floor and the guard refuses before the wire.
	const bigEstimate = 7 + Math.ceil(BIG_PROMPT.length / 4);
	await prompt(rpc, BIG_PROMPT);
	if (mock.requests.length !== 1) fail(`the starved request reached the provider: budgets ${mockBudgets(mock)}`);
	if (JSON.stringify(starvedNotifies(rpc)) !== JSON.stringify([starvedLine(bigEstimate, window, 1)])) {
		fail(`expected exactly [${starvedLine(bigEstimate, window, 1)}], got ${JSON.stringify(starvedNotifies(rpc))}`);
	}
	const reasons = stopReasons(rpc);
	if (reasons.includes("length")) fail(`a refused turn recorded a length stop: ${reasons}`);
	if (!reasons.includes("aborted")) fail(`the refused turn did not end aborted: ${reasons}`);

	// 3. The next turn is starved again and gets its own single refusal:
	// once per turn, never a storm, and the provider still never hears.
	const againEstimate = bigEstimate + Math.ceil("again".length / 4);
	await prompt(rpc, "again");
	if (mock.requests.length !== 1) fail(`the repeated starved request reached the provider: budgets ${mockBudgets(mock)}`);
	if (JSON.stringify(starvedNotifies(rpc)) !== JSON.stringify([starvedLine(bigEstimate, window, 1), starvedLine(againEstimate, window, 1)])) {
		fail(`expected one refusal per starved turn, got ${JSON.stringify(starvedNotifies(rpc))}`);
	}
	if (stopReasons(rpc).filter((reason) => reason === "aborted").length !== 2) {
		fail(`expected two aborted turns, got ${stopReasons(rpc)}`);
	}
	rpc.close();
	await mock.close();
	console.log("1-3. refusal: healthy turn silent, starved turns refused verbatim, once per turn, provider never contacted");
}

// ---------------------------------------------------------------------------
// 4. Compaction still rescues: the stale-usage session, but with
//    auto-compaction on. pi compacts the session on load (the summary
//    request and the compacted session both stay healthy), so the first
//    request goes out with a real budget and the guard stays silent.
// ---------------------------------------------------------------------------
{
	const window = 40192;
	const { mock, rpc } = await startSession(window, { prebuild: true });

	await prompt(rpc, "Reply with exactly: OK");
	const entries = await rpc.request("get_entries");
	if (!entries.success) fail(`get_entries: ${JSON.stringify(entries)}`);
	if (!(entries.data?.entries ?? []).some((entry) => entry.type === "compaction")) {
		fail(`expected pi to have compacted the stale session on load; entries: ${(entries.data?.entries ?? []).map((e) => e.type).join(",")}`);
	}
	if (mock.requests.length === 0) fail("expected at least one (healthy) provider request");
	for (const budget of mockBudgets(mock)) if (budget <= 1) fail(`a starved request reached the provider: budgets ${mockBudgets(mock)}`);
	if (starvedNotifies(rpc).length !== 0) fail(`the guard spoke though compaction rescued the session: ${starvedNotifies(rpc)}`);
	const lastReason = stopReasons(rpc).at(-1);
	if (lastReason !== "stop") fail(`the rescued turn ended ${lastReason}, expected stop`);
	rpc.close();
	await mock.close();
	console.log("4. compaction still rescues: stale session compacted on load, healthy requests, the guard silent");
}

// ---------------------------------------------------------------------------
// 5. Starved with pruning loaded: the same stale-usage session, with
//    auto-compaction off and Pruning loaded. Pruning's first level stays
//    out (the resumed session's runtime system prompt breaks its entry
//    alignment), yet the request is still starved on the usage the clamp
//    reads. The guard refuses; the provider is never contacted.
// ---------------------------------------------------------------------------
{
	const window = 40192;
	const { mock, rpc } = await startSession(window, { compactionEnabled: false, extraExtensions: [pruningExtension], prebuild: true });

	// The first request is starved on the stale usage: refused, not sent.
	// The estimate is the usage anchor (36500) plus whatever the session
	// carries after it, so pin the lower edge exactly and bound the upper
	// edge: far above the pruned character view (~3k) and far below the
	// raw character view (144k), which proves it is the usage-backed
	// estimate the clamp read.
	await prompt(rpc, "Reply with exactly: OK");
	if (mock.requests.length !== 0) fail(`the starved request reached the provider: budgets ${mockBudgets(mock)}`);
	const lines = starvedNotifies(rpc);
	if (lines.length !== 1) fail(`expected exactly one refusal, got ${JSON.stringify(lines)}`);
	const match = lines[0].match(/^output starvation: refused \(llama\.cpp\/m1\): context estimate (\d+), Effective window 40192, output budget 1$/);
	if (!match) fail(`the refusal is not the one-line report: ${lines[0]}`);
	const estimate = Number(match[1]);
	if (estimate < 36506 || estimate >= 60000) fail(`the estimate ${estimate} is not the usage-backed one (expected in [36506, 60000))`);
	// Pruning was loaded but its first level stayed out (no first-level
	// activation line): even a layer that prunes the outgoing context cannot
	// undo the usage the clamp reads.
	if (rpc.notifies.some((line) => line.startsWith("pruning: first level active"))) {
		fail(`unexpected pruning activation: ${JSON.stringify(rpc.notifies)}`);
	}
	const lastReason = stopReasons(rpc).at(-1);
	if (lastReason !== "aborted") fail(`the refused turn ended ${lastReason}, expected aborted`);
	rpc.close();
	await mock.close();
	console.log("5. starved with pruning loaded: the loaded pruning layer cannot undo the stale usage, the guard refused");
}

console.log("output-starvation e2e: all scenarios passed");
process.exit(0);
