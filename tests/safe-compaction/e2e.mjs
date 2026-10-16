/**
 * E2E for the Safe compaction extension.
 *
 * Drives a real pi agent session in-process against a mock
 * OpenAI-compatible server that emulates the engine behavior recorded in
 * issue #140's ninfer logs: a summarization request that carries thinking
 * runs to the request's output cap without finishing (finish_reason
 * "length", completion_tokens = max_tokens), while the same request with
 * thinking disabled completes with a short summary. The session mirrors the
 * reporter's configuration: a reasoning model with a large window,
 * compaction.reserveTokens 32768 (pi's summary budgets are 0.8x and 0.5x
 * that figure), and the session's thinking level at xhigh, so the
 * threshold compaction fires only after the context is big and the content
 * to summarize is big.
 *
 * Scenarios:
 *   1. native failure baseline (the bug, locked in): no guard loaded,
 *      thinking on. The native summarization inherits the session's
 *      thinking, runs to the cap, and pi fails the compaction with
 *      "generation hit the token cap and the summary is incomplete".
 *   2. guard takeover: the guard re-runs the compaction with thinking off;
 *      no summarization request carries thinking, the compaction entry is
 *      extension-provided, and the session keeps serving prompts.
 *   3. thinking off: the native call is already the safe path, so the guard
 *      stands aside and pi's built-in summarizer writes the entry.
 *   4. checkpoint fallback: even the thinking-free run cannot write a
 *      summary (the engine fails every summarization). The guard degrades
 *      to the deterministic checkpoint: the compaction completes, carries
 *      the previous summary verbatim and the file sections, and the
 *      session keeps serving prompts.
 *   5. non-reasoning model: the guard stands aside and the built-in
 *      summarizer writes the entry without any thinking on the wire.
 *   6. retry honored: a transient stream drop in the thinking-free run
 *      spends the user's retry budget from settings.json; the re-run
 *      retries the summarization and the compaction completes with the
 *      LLM summary, not the checkpoint.
 *   7. retry disabled: the same drop with `retry.enabled: false` lands
 *      the re-run on the deterministic checkpoint after one attempt.
 *
 *   node tests/safe-compaction/e2e.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "extensions", "safe-compaction", "index.ts");
const WINDOW = 65536;
const RESERVE = 32768;
const KEEP_RECENT = 4000;
const MAX_OUTPUT = 32768;

let failures = 0;

function fail(message) {
	failures += 1;
	console.error(`FAIL: ${message}`);
}

function check(condition, message) {
	if (condition) {
		console.log(`ok: ${message}`);
	} else {
		fail(message);
	}
}

function scenario(name, fn) {
	console.log(`\n${name}:`);
	return Promise.resolve()
		.then(fn)
		.then(() => console.log(`${name}: pass`))
		.catch((err) => fail(`${name}: ${err instanceof Error ? err.stack : String(err)}`));
}

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible provider
// ---------------------------------------------------------------------------

/**
 * `mode`:
 *   "normal" - a summarization request with thinking enabled runs to the
 *     output cap (finish_reason "length"); with thinking disabled it
 *     completes. The engine behavior recorded in the issue.
 *   "always-fail" - every summarization request runs to the cap, so even
 *     the guard's thinking-free run cannot write a summary.
 *   "fail-then-succeed" - the first thinking-free summarization request
 *     fails with a transient 502; later requests complete. Agent requests
 *     always complete.
 */
function messageText(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("");
	return "";
}

function startMockServer(mode) {
	const requests = [];
	let thinkingFreeSummaries = 0;
	const server = createServer((req, res) => {
		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route: ${req.url}` } }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = null;
			}
			// pi wraps the conversation it summarizes in <conversation> tags
			// in the prompt text, so the marker identifies a summarization
			// request by content. A shape guess (message count) misclassifies
			// the first prompt of a fresh session, which is also a
			// two-message, toolless request.
			const isSummarization = parsed !== null && Array.isArray(parsed.messages) && parsed.messages.some((m) => messageText(m).includes("<conversation>"));
			const thinkingOn = parsed?.enable_thinking === true || typeof parsed?.reasoning_effort === "string";
			const transientDrop = mode === "fail-then-succeed" && isSummarization && !thinkingOn && thinkingFreeSummaries === 0;
			if (isSummarization && !thinkingOn) thinkingFreeSummaries += 1;
			const record = {
				isSummarization,
				thinkingOn,
				transientDrop,
				maxTokens: parsed?.max_tokens,
				bodyChars: body.length,
			};
			requests.push(record);

			if (transientDrop) {
				// A gateway-style transient failure: the retry policy should
				// spend the user's budget here, not the checkpoint.
				res.writeHead(502, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Bad Gateway" } }));
				return;
			}

			if (!isSummarization) {
				// Agent request: short complete answer, no tools.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ id: "cmpl-a", choices: [{ index: 0, delta: { content: "done." } }] })}\n\n`);
				const promptTokens = Math.ceil(body.length / 4);
				res.write(
					`data: ${JSON.stringify({ id: "cmpl-a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 6, total_tokens: promptTokens + 6 } })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			// Summarization request.
			const runaway = mode === "always-fail" || thinkingOn;
			const cap = record.maxTokens;
			if (runaway) {
				// The generation runs to the output cap without finishing.
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify({ id: "cmpl-s", choices: [{ index: 0, delta: { content: "## Goal\n" } }] })}\n\n`);
				res.write(
					`data: ${JSON.stringify({ id: "cmpl-s", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: cap, total_tokens: Math.ceil(body.length / 4) + cap } })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}
			const summary = "## Goal\nSummarize the prior work.\n\n## Next Steps\n1. Continue the work.";
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ id: "cmpl-s", choices: [{ index: 0, delta: { content: summary } }] })}\n\n`);
			res.write(
				`data: ${JSON.stringify({ id: "cmpl-s", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 40, total_tokens: Math.ceil(body.length / 4) + 40 } })}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ port, requests, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

// ---------------------------------------------------------------------------
// Session scaffolding (pattern: tests/safe-branch-summary/e2e.mjs)
// ---------------------------------------------------------------------------

let clock = 0;
function user(text) {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}
function assistant(text, extraBlocks = []) {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...extraBlocks],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: clock,
	};
}
function writeCall(targetPath) {
	return { type: "toolCall", id: `call-${clock}`, name: "write", arguments: { path: targetPath, content: "x" } };
}
function toolResult(text) {
	clock += 1000;
	return { role: "toolResult", toolCallId: `call-${clock - 1000}`, toolName: "write", content: [{ type: "text", text }], isError: false, timestamp: clock };
}

function seedHistory(sm) {
	// Two big old turns (~20k and ~16k provider tokens, the mock counts
	// chars/4) then the current turn of ~4k: total ~40k > window - reserve
	// (32768), so the threshold compaction fires after the current turn's
	// answer, with the keep cut (4000) inside the old content. One old turn
	// carries a write tool call, so the compaction's file tracking has
	// content.
	sm.appendMessage(user("old task one"));
	sm.appendMessage(assistant("a".repeat(80000)));
	sm.appendMessage(user("old task two"));
	sm.appendMessage(assistant(`modified src/app.ts\n${"b".repeat(63900)}`, [writeCall("src/app.ts")]));
	sm.appendMessage(toolResult("written"));
	sm.appendMessage(user("new task in progress"));
	sm.appendMessage(assistant("c".repeat(16000)));
}

async function makeSession({ project, agentDir, mockPort, reasoning, thinkingLevel, guard, settings, prior }) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowNetwork: false,
	});
	modelRuntime.registerProvider("mock", {
		name: "Mock Provider",
		baseUrl: `http://127.0.0.1:${mockPort}/v1`,
		apiKey: "test-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-model",
				name: "Mock Model",
				reasoning,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: WINDOW,
				maxTokens: MAX_OUTPUT,
				// Mirror the reporter's rk4v4-e8 entry: qwen thinking
				// format, xhigh available, no explicit off key.
				compat: {
					thinkingFormat: "qwen",
					supportsDeveloperRole: false,
					supportsStore: false,
					supportsReasoningEffort: true,
					maxTokensField: "max_tokens",
				},
				thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: "xhigh", max: null },
			},
		],
	});
	const model = modelRuntime.getModel("mock", "mock-model");
	if (!model) throw new Error("mock model not registered");

	const resourceLoader = new DefaultResourceLoader({
		cwd: project,
		agentDir,
		additionalExtensionPaths: guard ? [extensionPath] : [],
	});
	await resourceLoader.reload();

	const sm = SessionManager.inMemory(project);
	if (prior) {
		// Turn A, then a prior compaction that summarized it away, then a
		// big turn B (~30k tokens) with tracked file activity, then the
		// current turn C (~4k). Live context = prior summary + B + C, which
		// clears window - reserve, so the threshold compaction fires.
		const turnAStart = sm.appendMessage(user("old task one"));
		sm.appendMessage(assistant("a".repeat(80000)));
		sm.appendCompaction("## Prior\nThe earlier work stood on the named controls.", turnAStart.id, 20000);
		sm.appendMessage(user("old task two"));
		sm.appendMessage(assistant(`modified src/app.ts\n${"b".repeat(119900)}`, [writeCall("src/app.ts")]));
		sm.appendMessage(toolResult("written"));
		sm.appendMessage(user("new task in progress"));
		sm.appendMessage(assistant("c".repeat(16000)));
	} else {
		seedHistory(sm);
	}

	const sessionConfig = {
		cwd: project,
		agentDir,
		modelRuntime,
		model,
		sessionManager: sm,
		resourceLoader,
		noTools: "all",
		thinkingLevel,
	};
	const { session } = await createAgentSession(sessionConfig);
	return { session, sm };
}

function makeDirs(prefix) {
	const tmp = mkdtempSync(join(tmpdir(), prefix));
	const project = join(tmp, "project");
	const agentDir = join(tmp, "agent");
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { tmp, project, agentDir };
}

function writeAgentSettings(agentDir, settings) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function compactionEvents(session) {
	const events = [];
	session.subscribe((event) => {
		if (event.type === "compaction_start" || event.type === "compaction_end") events.push(event);
	});
	return events;
}

function compactionEntries(sm) {
	return sm.getEntries().filter((entry) => entry.type === "compaction");
}

const BASE_SETTINGS = { compaction: { enabled: true, reserveTokens: RESERVE, keepRecentTokens: KEEP_RECENT } };

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runNativeFailure() {
	// The baseline: pi's built-in summarizer with the session's thinking
	// level runs to the cap and the compaction fails. The guard is not
	// loaded, so this is the reporter's exact failure, pinned so an upstream
	// change to the failure signature is loud.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-native-");
	try {
		writeAgentSettings(agentDir, BASE_SETTINGS);
		const mock = await startMockServer("normal");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "xhigh", guard: false });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(mock.requests.length > 0, "agent request reached the provider");
		check(summarization.length > 0, `compaction issued a summarization request (${summarization.length} found)`);
		check(summarization.some((r) => r.thinkingOn), "the native request carried the session's thinking level");
		check(
			summarization.every((r) => r.maxTokens <= 0.8 * RESERVE && r.maxTokens < MAX_OUTPUT),
			`the budget is pi's reserve-derived figure [${summarization.map((r) => r.maxTokens).join(",")} vs ${0.8 * RESERVE}]`,
		);
		const failed = compactionEnds.find((e) => e.errorMessage);
		check(failed !== undefined, `the compaction failed: ${failed?.errorMessage ?? "<no failure>"}`);
		check(
			failed?.errorMessage?.includes("generation hit the token cap and the summary is incomplete") ?? false,
			"the failure is the reporter's exact symptom",
		);
		check(compactionEntries(sm).length === 0, "no compaction entry survived the failure");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runGuardTakeover() {
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-takeover-");
	try {
		writeAgentSettings(agentDir, BASE_SETTINGS);
		const mock = await startMockServer("normal");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "xhigh", guard: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		const before = mock.requests.length;
		await session.prompt("one more turn");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(summarization.length > 0, `the guard issued summarization requests (${summarization.length} found)`);
		check(summarization.every((r) => !r.thinkingOn), "no summarization request carried thinking (the guard re-ran it with thinking off)");
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction succeeded");
		check(!compactionEnds.some((e) => e.errorMessage), "no compaction failure surfaced");
		const entries = compactionEntries(sm);
		check(entries.length === 1, "one compaction entry recorded");
		check(entries[0]?.fromHook === true, "the entry is extension-provided");
		check(mock.requests.length > before, "the session keeps serving prompts after the compaction");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runThinkingOffNative() {
	// With the session's thinking level off the native call is already the
	// safe path: the guard must stand aside and let pi's built-in write the
	// entry.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-off-");
	try {
		writeAgentSettings(agentDir, BASE_SETTINGS);
		const mock = await startMockServer("normal");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "off", guard: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(summarization.length > 0, `the built-in issued summarization requests (${summarization.length} found)`);
		check(summarization.every((r) => !r.thinkingOn), "the requests carried no thinking");
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction succeeded");
		const entries = compactionEntries(sm);
		check(entries.length === 1 && entries[0]?.fromHook !== true, "the entry is pi's own, not the extension's");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runCheckpointFallback() {
	// The engine fails every summarization, thinking-free and all. The guard
	// degrades to the deterministic checkpoint: the compaction completes, the
	// previous summary rides through verbatim, and the session continues.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-checkpoint-");
	try {
		writeAgentSettings(agentDir, BASE_SETTINGS);
		const mock = await startMockServer("always-fail");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "xhigh", guard: true, prior: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		const before = mock.requests.length;
		await session.prompt("one more turn");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(summarization.some((r) => !r.thinkingOn), "the guard tried the thinking-free run first");
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction completed via the checkpoint");
		check(!compactionEnds.some((e) => e.errorMessage), "no compaction failure surfaced");
		const entries = compactionEntries(sm);
		check(entries.length === 2, "the checkpoint entry was recorded after the prior one");
		const checkpoint = entries[1];
		check(checkpoint?.fromHook === true, "the checkpoint entry is extension-provided");
		check(checkpoint?.summary?.includes("Checkpoint (deterministic)") ?? false, "the checkpoint is labeled as extractive");
		check(checkpoint?.summary?.includes("The earlier work stood on the named controls.") ?? false, "the previous summary rides through verbatim");
		check(checkpoint?.summary?.includes("old task two") ?? false, "the original request is recorded");
		check(checkpoint?.summary?.includes("src/app.ts") ?? false, "the file sections carry the tracked paths");
		check(mock.requests.length > before, "the session keeps serving prompts after the checkpoint");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runNonReasoningNative() {
	// A non-reasoning model's native call is the safe path: the guard stands
	// aside and nothing with thinking ever goes on the wire.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-nonreason-");
	try {
		writeAgentSettings(agentDir, BASE_SETTINGS);
		const mock = await startMockServer("normal");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: false, thinkingLevel: "xhigh", guard: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(summarization.length > 0, `the built-in issued summarization requests (${summarization.length} found)`);
		check(summarization.every((r) => !r.thinkingOn), "no request carried thinking");
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction succeeded");
		const entries = compactionEntries(sm);
		check(entries.length === 1 && entries[0]?.fromHook !== true, "the entry is pi's own, not the extension's");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runRetryHonored() {
	// A transient stream drop in the thinking-free run. The retry budget
	// from the same settings.json pi reads carries the re-run through it:
	// the summarization is re-sent and the compaction completes with the
	// LLM summary instead of the checkpoint.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-retry-");
	try {
		writeAgentSettings(agentDir, {
			...BASE_SETTINGS,
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 50, maxAgentDelayMs: 1000 },
		});
		const mock = await startMockServer("fail-then-succeed");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "xhigh", guard: true, prior: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		const before = mock.requests.length;
		await session.prompt("one more turn");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const thinkingFree = summarization.filter((r) => !r.thinkingOn);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(thinkingFree.some((r) => r.transientDrop), "the thinking-free run hit a transient stream drop");
		check(thinkingFree.length >= 2, `the retry budget re-sent the summarization (${thinkingFree.length} attempts)`);
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction completed after the retry");
		check(!compactionEnds.some((e) => e.errorMessage), "no compaction failure surfaced");
		const entries = compactionEntries(sm);
		check(entries.length === 2, "one compaction entry after the prior one");
		const entry = entries[1];
		check(entry?.fromHook === true, "the entry is extension-provided");
		check(entry?.summary?.includes("Summarize the prior work.") ?? false, "the retried run wrote the LLM summary");
		check(!(entry?.summary?.includes("Checkpoint (deterministic)") ?? false), "no checkpoint was needed");
		check(mock.requests.length > before, "the session keeps serving prompts after the retry");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function runRetryDisabledCheckpoint() {
	// The same transient drop, with the user's retry disabled. The re-run
	// honors the empty budget: one attempt, then the deterministic
	// checkpoint completes the compaction.
	const { tmp, project, agentDir } = makeDirs("safe-compaction-e2e-noretry-");
	try {
		writeAgentSettings(agentDir, { ...BASE_SETTINGS, retry: { enabled: false } });
		const mock = await startMockServer("fail-then-succeed");
		const { session, sm } = await makeSession({ project, agentDir, mockPort: mock.port, reasoning: true, thinkingLevel: "xhigh", guard: true, prior: true });
		const events = compactionEvents(session);
		await session.prompt("continue the work");
		const before = mock.requests.length;
		await session.prompt("one more turn");
		await mock.close();

		const summarization = mock.requests.filter((r) => r.isSummarization);
		const thinkingFree = summarization.filter((r) => !r.thinkingOn);
		const compactionEnds = events.filter((e) => e.type === "compaction_end");
		check(thinkingFree.some((r) => r.transientDrop), "the thinking-free run hit the transient stream drop");
		check(thinkingFree.length === 1, `no retry was attempted (${thinkingFree.length} attempt)`);
		check(compactionEnds.some((e) => e.result !== undefined), "the compaction completed via the checkpoint");
		check(!compactionEnds.some((e) => e.errorMessage), "no compaction failure surfaced");
		const entries = compactionEntries(sm);
		const entry = entries[entries.length - 1];
		check(entry?.fromHook === true, "the checkpoint entry is extension-provided");
		check(entry?.summary?.includes("Checkpoint (deterministic)") ?? false, "the checkpoint is labeled as extractive");
		check(mock.requests.length > before, "the session keeps serving prompts after the checkpoint");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await scenario("native failure baseline", runNativeFailure);
await scenario("guard takeover", runGuardTakeover);
await scenario("thinking off", runThinkingOffNative);
await scenario("checkpoint fallback", runCheckpointFallback);
await scenario("non-reasoning model", runNonReasoningNative);
await scenario("retry honored", runRetryHonored);
await scenario("retry disabled", runRetryDisabledCheckpoint);

if (failures > 0) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall scenarios pass");
