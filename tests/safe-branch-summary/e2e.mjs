/**
 * E2E for the Safe branch summary extension.
 *
 * Drives a real pi session in-process through the SDK (the seam is the SDK,
 * not RPC: pi's RPC mode has no tree-navigation command). Each scenario
 * builds a throwaway project and agent dir, registers a mock
 * OpenAI-compatible provider with a small context window, seeds an
 * abandoned branch into a session manager, and calls a real
 * navigateTree with summarize.
 *
 * The mock server enforces the physical window: it estimates the real
 * tokens of an incoming request as chars/2 (the worst case the Inflation
 * factor 2.0 models) and rejects with an exceed_context_size 400 above the
 * window. The overflow path is deterministic: the branch is large enough
 * that pi's built-in budget (window - reserve, chars/4 estimate) would
 * select content whose real request exceeds the window, while the safe
 * budget ((window - reserve) / 2) selects content that fits. A passing run
 * proves the request fit.
 *
 * Scenarios:
 *   1. overflow path: a code-heavy branch overflows the built-in budget
 *      and fits the safe budget; the summary entry is written, marked as
 *      extension-provided, carries the label, the file sections, and the
 *      request usage
 *   2. custom focus: the custom-instructions variant is appended to the
 *      default prompt
 *   3. replace variant: the custom instructions replace the default prompt
 *   4. soft-skip: a model that cannot be reached (dead endpoint) completes
 *      the navigation without a summary entry and without an extension
 *      error
 *   5. degenerate window: a window at or below the reserve completes the
 *      navigation without a summary entry and without any request
 *   6. disabled: with the extension off, the built-in writes the summary
 *      for a fitting branch (entry not marked as extension-provided)
 *
 * Any extension error or assertion failure fails the run.
 *
 *   node tests/safe-branch-summary/e2e.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "extensions", "safe-branch-summary", "index.ts");
const WINDOW = 8192;
const RESERVE = 2048;
const TIMEOUT_MS = 120_000;

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

// ---------------------------------------------------------------------------
// Mock OpenAI-compatible provider
// ---------------------------------------------------------------------------

function startMockServer(window) {
	const requests = [];
	const server = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				const realTokens = Math.ceil(body.length / 2);
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch {
					parsed = null;
				}
				requests.push({ bodyChars: body.length, realTokens, maxTokens: parsed?.max_tokens, body });
				if (realTokens > window) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(
						JSON.stringify({
							error: {
								message: `Request exceeds context size: estimated ${realTokens} tokens exceeds the ${window}-token window`,
								type: "exceed_context_size_error",
							},
						}),
					);
					return;
				}
				res.writeHead(200, { "content-type": "text/event-stream" });
				const summary = "## Goal\nSummarize the abandoned branch work.\n\n## Next Steps\n1. Continue the work.";
				res.write(`data: ${JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, delta: { content: summary } }] })}\n\n`);
				res.write(
					`data: ${JSON.stringify({ id: "cmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 12, total_tokens: Math.ceil(body.length / 4) + 12 } })}\n\n`,
				);
				res.write("data: [DONE]\n\n");
				res.end();
			});
		} else {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route: ${req.url}` } }));
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				port,
				requests,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// Session scaffolding
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

function writeCall(targetPath, content) {
	return { type: "toolCall", id: `call-${clock}`, name: "write", arguments: { path: targetPath, content } };
}

async function makeSession({ project, agentDir, mockPort, window: modelWindow, seed }) {
	// The CLI exports PI_CODING_AGENT_DIR; the in-process SDK does not. The
	// extension resolves global settings from that variable, so set it the
	// way the CLI would.
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
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: modelWindow,
				maxTokens: 4096,
				compat: { maxTokensField: "max_tokens" },
			},
		],
	});
	const model = modelRuntime.getModel("mock", "mock-model");
	if (!model) throw new Error("mock model not registered");

	const resourceLoader = new DefaultResourceLoader({
		cwd: project,
		agentDir,
		additionalExtensionPaths: [extensionPath],
	});
	await resourceLoader.reload();

	const sm = SessionManager.inMemory(project);
	const seedResult = seed(sm);

	const { session } = await createAgentSession({
		cwd: project,
		agentDir,
		modelRuntime,
		model,
		sessionManager: sm,
		resourceLoader,
		noTools: "all",
		thinkingLevel: "off",
	});
	return { session, sm, seedResult };
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

/** A code-heavy abandoned branch: five assistant replies of 4500 chars
 * (chars/4 estimate: 1125 each), the newest carrying a write tool call
 * with a 500-char file argument. The whole branch is 5774 estimated
 * tokens: above the safe budget (3072), below the built-in budget (6144).
 * The built-in's request would be about 12300 real tokens against the
 * 8192 window; the safe selection's request is about 5600. */
/** Seeds a fork under the root message.
 *
 *   root ┬─ a1 → a2 → a3 → a4 → a5   (branch A: the code-heavy branch)
 *        └─ b1 → b2                   (branch B: the navigation target)
 *
 * The session starts on branch A (the leaf is moved back to a5); navigating
 * to b2 abandons branch A and summarizes exactly a1..a5. */
function seedCodeHeavyBranch(sm) {
	const root = sm.appendMessage(user("start the refactor"));
	const a1 = sm.appendMessage(assistant(`alpha ${"a".repeat(4492)}`));
	const a2 = sm.appendMessage(assistant(`beta ${"b".repeat(4492)}`));
	const a3 = sm.appendMessage(assistant(`gamma ${"c".repeat(4492)}`));
	const a4 = sm.appendMessage(assistant(`delta ${"d".repeat(4492)}`));
	const a5 = sm.appendMessage(
		assistant(`final ${"e".repeat(4492)}`, [writeCall("src/app.ts", "x".repeat(500))]),
	);
	// Branch B, forked from the root.
	sm.branch(root);
	sm.appendMessage(user("alternate direction"));
	const b2 = sm.appendMessage(assistant("b reply"));
	// Start the session on branch A, so navigating to b2 abandons branch A.
	sm.branch(a5);
	void a1;
	void a2;
	void a3;
	void a4;
	return { targetId: b2 };
}

function seedSmallBranch(sm) {
	const root = sm.appendMessage(user("hello"));
	sm.appendMessage(assistant("a short reply"));
	sm.appendMessage(user("second task"));
	const lastReply = sm.appendMessage(assistant("another short reply"));
	sm.branch(root);
	sm.appendMessage(user("alternate"));
	const b2 = sm.appendMessage(assistant("b reply"));
	sm.branch(lastReply);
	return { targetId: b2 };
}

function findSummaryEntry(sm) {
	return sm.getEntries().find((entry) => entry.type === "branch_summary");
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioOverflow() {
	console.log("\n== overflow path: safe budget fits where the built-in would overflow ==");
	const mock = await startMockServer(WINDOW);
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-overflow-");
	writeAgentSettings(agentDir, { branchSummary: { reserveTokens: RESERVE } });
	let made;
	try {
		made = await makeSession({ project, agentDir, mockPort: mock.port, window: WINDOW, seed: seedCodeHeavyBranch });
		const { session, sm, seedResult } = made;
		const result = await session.navigateTree(seedResult.targetId, { summarize: true, label: "checkpoint-A" });
		check(result.cancelled === false, "navigation completes");

		const summaryEntry = findSummaryEntry(sm);
		check(summaryEntry !== undefined, "a branch summary entry is written");
		check(summaryEntry?.fromHook === true, "the entry is marked as extension-provided");
		check(typeof summaryEntry?.summary === "string" && summaryEntry.summary.startsWith("The user explored a different conversation branch"), "the summary carries the branch preamble");
		check(summaryEntry?.summary.includes("## Goal") === true, "the summary keeps pi's standard structure");
		check(summaryEntry?.summary.includes("<modified-files>") && summaryEntry?.summary.includes("src/app.ts") === true, "the modified file section lists the written file");
		check(summaryEntry?.usage !== undefined && summaryEntry.usage.totalTokens > 0, "the summary usage is recorded on the entry");
		check(
			JSON.stringify(summaryEntry?.details) === JSON.stringify({ readFiles: [], modifiedFiles: ["src/app.ts"] }),
			"the file lists are stored in the entry details",
		);
		check(sm.getEntries().some((entry) => entry.type === "label" && entry.label === "checkpoint-A") === true, "the label lands on the summary entry");

		check(mock.requests.length === 1, "exactly one summary request was sent");
		const request = mock.requests[0];
		check(request.realTokens <= WINDOW, `the request fit the window (${request.realTokens} <= ${WINDOW})`);
		check(request.maxTokens === 4096, "the output is capped at 4096 tokens");
		check(request.body.includes("final "), "the newest branch content is summarized");
		check(!request.body.includes("alpha "), "the oldest branch content beyond the safe budget is dropped");

		// The built-in premise: the full branch, as pi's built-in budget
		// would select it, overflows the window.
		const fullChars = 4500 * 5 + 500 + 30 + 1300; // branch text + tool args + wrappers + prompts
		check(Math.ceil(fullChars / 2) > WINDOW, `the built-in selection would overflow (${Math.ceil(fullChars / 2)} > ${WINDOW})`);

		await session.dispose();
	} finally {
		await mock.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioCustomFocus() {
	console.log("\n== custom focus: the custom-instructions variant is appended ==");
	const mock = await startMockServer(WINDOW);
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-focus-");
	writeAgentSettings(agentDir, { branchSummary: { reserveTokens: RESERVE } });
	try {
		const { session, sm, seedResult } = await makeSession({ project, agentDir, mockPort: mock.port, window: WINDOW, seed: seedSmallBranch });
		const result = await session.navigateTree(seedResult.targetId, { summarize: true, customInstructions: "Focus on the performance work" });
		check(result.cancelled === false, "navigation completes");
		check(findSummaryEntry(sm) !== undefined, "the summary entry is written");
		check(mock.requests.length === 1, "exactly one summary request was sent");
		check(mock.requests[0].body.includes("Additional focus: Focus on the performance work"), "the custom focus is appended to the default prompt");
		check(mock.requests[0].body.includes("Create a structured summary"), "the default prompt is kept in the append variant");
		await session.dispose();
	} finally {
		await mock.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioReplaceInstructions() {
	console.log("\n== replace variant: the custom instructions replace the default prompt ==");
	const mock = await startMockServer(WINDOW);
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-replace-");
	writeAgentSettings(agentDir, { branchSummary: { reserveTokens: RESERVE } });
	try {
		const { session, sm, seedResult } = await makeSession({ project, agentDir, mockPort: mock.port, window: WINDOW, seed: seedSmallBranch });
		const result = await session.navigateTree(seedResult.targetId, { summarize: true, customInstructions: "Just list the file changes.", replaceInstructions: true });
		check(result.cancelled === false, "navigation completes");
		check(mock.requests.length === 1, "exactly one summary request was sent");
		check(mock.requests[0].body.includes("Just list the file changes."), "the replacement instructions are sent");
		check(!mock.requests[0].body.includes("Create a structured summary"), "the default prompt is not sent in the replace variant");
		await session.dispose();
	} finally {
		await mock.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioSoftSkip() {
	console.log("\n== soft-skip: a dead endpoint completes the navigation without a summary ==");
	// A port nothing listens on: the request must fail, the extension must
	// absorb it, and the navigation must still complete.
	const dead = await startMockServer(WINDOW);
	const closedPort = dead.port;
	await dead.close();
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-softskip-");
	writeAgentSettings(agentDir, { branchSummary: { reserveTokens: RESERVE } });
	try {
		const { session, sm, seedResult } = await makeSession({ project, agentDir, mockPort: closedPort, window: WINDOW, seed: seedSmallBranch });
		const result = await session.navigateTree(seedResult.targetId, { summarize: true });
		check(result.cancelled === false, "the navigation completes");
		check(findSummaryEntry(sm) === undefined, "no branch summary entry is written");
		check(sm.getEntries().some((entry) => entry.type === "message") === true, "the session keeps its entries");
		await session.dispose();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioWindowBelowReserve() {
	console.log("\n== degenerate window: at or below the reserve, no request is sent ==");
	const mock = await startMockServer(RESERVE);
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-small-window-");
	writeAgentSettings(agentDir, { branchSummary: { reserveTokens: RESERVE } });
	try {
		const { session, sm, seedResult } = await makeSession({ project, agentDir, mockPort: mock.port, window: RESERVE, seed: seedSmallBranch });
		const result = await session.navigateTree(seedResult.targetId, { summarize: true });
		check(result.cancelled === false, "the navigation completes");
		check(findSummaryEntry(sm) === undefined, "no branch summary entry is written");
		check(mock.requests.length === 0, "no summary request was sent");
		await session.dispose();
	} finally {
		await mock.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function scenarioDisabled() {
	console.log("\n== disabled: the built-in writes the summary for a fitting branch ==");
	const mock = await startMockServer(WINDOW);
	const { tmp, project, agentDir } = makeDirs("safe-branch-summary-e2e-disabled-");
	writeAgentSettings(agentDir, {
		branchSummary: { reserveTokens: RESERVE },
		safeBranchSummary: { enabled: false },
	});
	try {
		const { session, sm, seedResult } = await makeSession({ project, agentDir, mockPort: mock.port, window: WINDOW, seed: seedSmallBranch });
		const result = await session.navigateTree(seedResult.targetId, { summarize: true, label: "builtin-check" });
		check(result.cancelled === false, "navigation completes");
		const summaryEntry = findSummaryEntry(sm);
		check(summaryEntry !== undefined, "the built-in wrote a branch summary entry");
		check(summaryEntry?.fromHook !== true, "the entry is not marked as extension-provided");
		check(mock.requests.length === 1, "exactly one (built-in) summary request was sent");
		check(mock.requests[0].realTokens <= WINDOW, "the built-in request fit the window");
		await session.dispose();
	} finally {
		await mock.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const watchdog = setTimeout(() => {
	fail(`timed out after ${TIMEOUT_MS}ms`);
	process.exit(1);
}, TIMEOUT_MS);

try {
	await scenarioOverflow();
	await scenarioCustomFocus();
	await scenarioReplaceInstructions();
	await scenarioSoftSkip();
	await scenarioWindowBelowReserve();
	await scenarioDisabled();
} catch (err) {
	fail(`uncaught: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
	clearTimeout(watchdog);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall e2e checks passed");
