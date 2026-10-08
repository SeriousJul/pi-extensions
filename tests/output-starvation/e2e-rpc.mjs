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
 *   6. output overrun: a session whose Reported context plus one dense
 *      trailing tool result overruns the window. The request goes out with
 *      a fitted max_tokens and the provider is contacted (pi's own estimate
 *      leaves the budget inside the window, so today this request is a 400
 *      from the provider), the fit line names the figures, and pi's own
 *      compaction then fires on the count the provider reported for the
 *      fitted request
 *   7. overrun with no answer room: the same shape with the anchor pushed
 *      past the window. The guard refuses rather than fitting, with the
 *      refusal line it already uses, the provider is never contacted, and
 *      the turn ends aborted
 *   8. the fit repeats: a tool-calling turn whose every request is fitted,
 *      each on its own Corrected estimate, with the notice capped at one
 *      line per turn
 *   9. the same shape with the guard off: the provider enforces its window,
 *      refuses the unfitted request, and pi takes its compaction path
 *  10. a fresh session with no Reported context to anchor on: the guard's
 *      own guess says nothing fits, and it still leaves the request alone;
 *      the provider answers it
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

/** Build a session whose last answer reports a big Reported context and
 * whose newest content is one dense tool result the provider has not
 * counted yet: the shape of the incident the guard's Fit answers. The
 * optional history sits before that answer, so it is inside the Reported
 * context and changes nothing about the estimate. */
function prebuildDenseSession(agentDir, { anchorTokens, denseChars, historyTurns = 0, historyChars = 4000 }) {
	const builder = SessionManager.create(agentDir, join(agentDir, "sessions"));
	const clock = 1_000_000;
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (let turn = 0; turn < historyTurns; turn++) {
		builder.appendMessage({ role: "user", content: `History question ${turn}.`, timestamp: clock + turn * 10 });
		builder.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "h".repeat(historyChars) }],
			api: "openai-completions",
			provider: "llama.cpp",
			model: MODEL,
			usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000, cost: zeroCost },
			stopReason: "stop",
			timestamp: clock + turn * 10 + 1,
		});
	}
	builder.appendMessage({ role: "user", content: "Run the test suite.", timestamp: clock + historyTurns * 10 });
	// The answer the provider counted: its usage is the Reported context the
	// guard anchors its Corrected estimate at.
	builder.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }],
		api: "openai-completions",
		provider: "llama.cpp",
		model: MODEL,
		usage: { input: anchorTokens - 20, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: anchorTokens, cost: zeroCost },
		stopReason: "toolUse",
		timestamp: clock + historyTurns * 10 + 1,
	});
	builder.appendMessage({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "t".repeat(denseChars) }],
		isError: false,
		timestamp: clock + historyTurns * 10 + 2,
	});
	return builder.getSessionFile();
}

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

function startRpc(agentDir, extraArgs = [], extraExtensions = [], { guard = true } = {}) {
	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy of every extension and the
	// duplicate flag registration stops the session starting. It also turns
	// off pi's built-in extensions, and since pi 1.0 the llama.cpp provider
	// is one, so the run re-enables exactly that built-in.
	const child = spawn(
		process.execPath,
		[
			piCli,
			"--mode",
			"rpc",
			"--no-extensions",
			"--extension",
			"builtin:llama.cpp",
			...(guard ? ["--extension", guardExtension] : []),
			...extraExtensions,
			...extraArgs,
		],
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

/** Start a mock + a pi session on it, and wait until the session resolves the model at the expected window. With `prebuild`, the child
 * starts from a pre-built session: the stale-usage one by default, or one
 * built by the function passed for it. With `guard: false`, the child runs
 * without the guard extension, which is how a scenario shows what pi and
 * the provider do on their own. With `enforceWindow`, the mock refuses a
 * request whose prompt plus its ceiling exceeds the window. */
async function startSession(
	window,
	{
		compactionEnabled = true,
		extraExtensions = [],
		prebuild = false,
		buildSession = prebuildStaleSession,
		guard = true,
		enforceWindow,
		mockOptions = {},
	} = {},
) {
	const mock = await startLlamaMockRouter({
		models: { [MODEL]: { nCtx: window, status: "loaded" } },
		...(enforceWindow ? { enforceWindow: { nCtx: window, ...enforceWindow } } : {}),
		...mockOptions,
	});
	const agentDir = prepareAgentDir(mock.url, { compactionEnabled });
	// The pre-built session must record the child's cwd, so build it after
	// the agent dir exists and pass it through --session.
	const sessionArgs = prebuild ? ["--session", buildSession(agentDir)] : [];
	const rpc = startRpc(agentDir, sessionArgs, extraExtensions, { guard });
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

const starvedNotifies = (rpc) => rpc.notifies.filter((line) => line.startsWith("output starvation: refused"));
const overrunNotifies = (rpc) => rpc.notifies.filter((line) => line.startsWith("output overrun:"));
const mockBudgets = (mock) => mock.requests.map((request) => request.maxTokens);

/** The characters one wire message contributes, as the guard counts them. */
function wireChars(message) {
	if (typeof message?.content === "string") return message.content.length;
	if (Array.isArray(message?.content)) {
		return message.content.reduce((sum, block) => sum + (block.type === "image" || block.type === "image_url" ? 4800 : (block.text?.length ?? 0)), 0);
	}
	return 0;
}

/**
 * The Fit the guard owes one recorded request, computed independently of the
 * extension from what actually went over the wire: the Reported context the
 * session's last answer carries, plus the recorded payload's content after
 * the anchored answer at pi's chars/4 rate times the Inflation factor, and
 * pi's own 4096 margin. `answersAfterAnchor` is how many answers the session
 * holds after the one the provider counted; the boundary sits at that
 * anchored answer, not at the payload's last one.
 */
function expectedFit(body, anchor, window, { inflation = 2, bytesPerChar = 4, margin = 4096, answersAfterAnchor = 0 } = {}) {
	const messages = body.messages ?? [];
	let seen = 0;
	let anchorIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue;
		if (seen === answersAfterAnchor) {
			anchorIndex = i;
			break;
		}
		seen += 1;
	}
	let chars = 0;
	for (let i = anchorIndex + 1; i < messages.length; i++) chars += wireChars(messages[i]);
	const estimate = anchor + Math.ceil((chars * inflation) / bytesPerChar);
	return { estimate, fit: window - estimate - margin, trailingChars: chars };
}

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
	if (overrunNotifies(rpc).length !== 0) fail(`the guard spoke on a healthy turn: ${overrunNotifies(rpc)}`);
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

// ---------------------------------------------------------------------------
// 6. Output overrun: the request is fitted, not rejected. The session's
//    Reported context (150,020) plus one dense trailing tool result leaves
//    the Corrected estimate 180,031 of the 200,000 window, while pi's own
//    chars/4 estimate sees about 165,000 and leaves a budget of about
//    30,900. The mock enforces the window at the incident's measured rate
//    (2 characters per token), so that request is a real 400 from the
//    provider; the guard lowers the budget to the room the Corrected
//    estimate leaves, the request goes out, and the answer comes back. That
//    answer reports a Reported context past pi's compaction threshold, so
//    pi's own threshold compaction fires in the same run: the Fit is the
//    last thing the operator sees before pi's normal recovery path runs.
//
//    The history before the anchored answer carries twice its token count in
//    characters, which is what that 2-characters-per-token rate means for a
//    real session: the payload the guard screens on and the count the
//    provider made then describe the same content.
// ---------------------------------------------------------------------------
{
	const window = 200_000;
	const anchor = 150_020;
	const denseChars = 60_000;
	// History before the answer, so pi's cut-point search has something to
	// summarize when the fitted turn's reported count pushes the session past
	// the compaction threshold, and so the payload carries the content the
	// Reported context counted.
	const { mock, rpc } = await startSession(window, {
		prebuild: true,
		buildSession: (dir) => prebuildDenseSession(dir, { anchorTokens: anchor, denseChars, historyTurns: 6, historyChars: 50_000 }),
		enforceWindow: { promptTokens: anchor, charsPerToken: 2, requests: 1 },
	});

	// The fitted answer reports the provider's real count: past pi's threshold
	// (window minus the 16,384 reserve), which is what makes the next turn compact.
	mock.scriptResponse({ content: "OK", finishReason: "stop", outputTokens: 3, promptTokens: 190_000 });
	await prompt(rpc, "Reply with exactly: OK");

	if (mock.requests.length < 1) fail(`the fitted request never reached the provider`);
	const body = mock.requests[0].body;
	const expected = expectedFit(body, anchor, window);
	if (expected.fit <= 1024) fail(`the expected fit ${expected.fit} is not a real answer budget`);
	if (body.max_tokens !== expected.fit) {
		fail(`the budget on the wire is ${body.max_tokens}, expected the fitted ${expected.fit} (estimate ${expected.estimate})`);
	}
	const lines = overrunNotifies(rpc);
	if (lines.length !== 1) fail(`expected exactly one fit notice, got ${JSON.stringify(lines)}`);
	const fit = /^output overrun: fitted budget \(llama\.cpp\/m1\): context estimate (\d+), Effective window 200000, output budget (\d+) -> (\d+)$/.exec(lines[0]);
	if (!fit) fail(`the fit notice is not the one-line report: ${lines[0]}`);
	if (Number(fit[1]) !== expected.estimate) fail(`the line's estimate ${fit[1]} is not the Corrected estimate ${expected.estimate}`);
	if (Number(fit[3]) !== expected.fit) fail(`the line's fitted budget ${fit[3]} is not the budget on the wire ${expected.fit}`);
	if (Number(fit[2]) <= expected.fit) fail(`the line's original budget ${fit[2]} is not above the fitted ${expected.fit}: the guard raised a budget`);
	if (starvedNotifies(rpc).length !== 0) fail(`the guard refused a request it should have fitted: ${JSON.stringify(rpc.notifies)}`);
	const reasons = stopReasons(rpc);
	if (!reasons.includes("stop")) fail(`the fitted turn did not end stop: ${reasons}`);

	// pi's own recovery path now runs on the count the provider reported for
	// the fitted request: the session compacts through pi's normal threshold
	// path, with the guard silent about the summarization requests.
	const entries = await rpc.request("get_entries");
	if (!entries.success) fail(`get_entries: ${JSON.stringify(entries)}`);
	if (!(entries.data?.entries ?? []).some((entry) => entry.type === "compaction")) {
		fail(`expected pi to compact on the provider's reported count after the fitted turn; entries: ${(entries.data?.entries ?? []).map((e) => e.type).join(",")}`);
	}
	rpc.close();
	await mock.close();
	console.log(`6. output overrun: the request went out fitted (${body.max_tokens} tokens, estimate ${expected.estimate}), the provider answered, and pi compacted on the reported count`);
}

// ---------------------------------------------------------------------------
// 7. Output overrun with no answer room: the same shape with the Reported
//    context pushed up, so the Corrected estimate sits past the window and
//    pi's margin leaves nothing a real answer fits in. The guard refuses
//    rather than sending a budget that cannot hold an answer, and the
//    provider is never contacted.
// ---------------------------------------------------------------------------
{
	const window = 200_000;
	const anchor = 170_000;
	const denseChars = 60_000;
	const { mock, rpc } = await startSession(window, {
		compactionEnabled: false,
		prebuild: true,
		buildSession: (dir) => prebuildDenseSession(dir, { anchorTokens: anchor, denseChars, historyTurns: 6, historyChars: 56_000 }),
	});

	await prompt(rpc, "Reply with exactly: OK");
	if (mock.requests.length !== 0) fail(`an overrun with no answer room reached the provider: budgets ${mockBudgets(mock)}`);
	// This branch refuses the way the collapsed budget is refused, with the
	// same line; the figures are what tell them apart.
	const lines = starvedNotifies(rpc);
	if (lines.length !== 1) fail(`expected exactly one refusal, got ${JSON.stringify(lines)}`);
	if (overrunNotifies(rpc).length !== 0) fail(`a request that could not be fitted reported a fit: ${JSON.stringify(overrunNotifies(rpc))}`);
	const refusal = /^output starvation: refused \(llama\.cpp\/m1\): context estimate (\d+), Effective window 200000, output budget (\d+)$/.exec(lines[0]);
	if (!refusal) fail(`the refusal is not the one-line report: ${lines[0]}`);
	// The Corrected estimate is the provider's own count plus the dense tool
	// result at the Inflation-corrected rate, and it is over the window.
	const estimate = Number(refusal[1]);
	if (estimate < window) fail(`the refusal names ${estimate}, expected a Corrected estimate over the ${window} window`);
	// And the budget is the one pi chose, not pi's floor: this is the overrun
	// branch refusing, not Output starvation.
	if (Number(refusal[2]) <= 1) fail(`the refusal names pi's floor as the budget, which is the starvation branch: ${lines[0]}`);
	const lastReason = stopReasons(rpc).at(-1);
	if (lastReason !== "aborted") fail(`the refused turn ended ${lastReason}, expected aborted`);
	rpc.close();
	await mock.close();
	console.log(`7. output overrun with no answer room: refused (${lines[0]}), the provider never heard`);
}

// ---------------------------------------------------------------------------
// 8. The Fit repeats across a turn that asks for a tool call: every request
//    goes out on its own fitted budget, never with the budget that just
//    failed, and the notice stays at one line per turn.
// ---------------------------------------------------------------------------
{
	const window = 200_000;
	const anchor = 150_020;
	const denseChars = 60_000;
	const toolAnswerTokens = 20;
	const { mock, rpc } = await startSession(window, {
		compactionEnabled: false,
		prebuild: true,
		buildSession: (dir) => prebuildDenseSession(dir, { anchorTokens: anchor, denseChars, historyTurns: 6, historyChars: 50_000 }),
	});

	// The first answer asks for a real tool call and reports the same Reported
	// context; the tool result it brings back is itself dense, so the second
	// request is a fresh overrun on a fresh estimate.
	mock.scriptResponse({
		toolCalls: [{ id: "c9", name: "bash", arguments: { command: "head -c 40000 /dev/zero | tr '\\0' 'x'" } }],
		finishReason: "tool_calls",
		outputTokens: toolAnswerTokens,
		promptTokens: anchor,
	});
	mock.scriptResponse({ content: "OK", finishReason: "stop", outputTokens: 3, promptTokens: anchor + toolAnswerTokens });
	await prompt(rpc, "Reply with exactly: OK");

	if (mock.requests.length !== 2) fail(`expected two provider requests (the tool call and its answer), got ${mock.requests.length}`);
	const turns = countEvents(rpc, "turn_end");
	if (turns !== 2) fail(`expected two turns (the tool-call step and its answer), got ${turns}`);
	const first = expectedFit(mock.requests[0].body, anchor, window);
	const second = expectedFit(mock.requests[1].body, anchor + toolAnswerTokens, window);
	if (mock.requests[0].maxTokens !== first.fit) fail(`the first request's budget is ${mock.requests[0].maxTokens}, expected the fitted ${first.fit}`);
	if (mock.requests[1].maxTokens !== second.fit) fail(`the second request's budget is ${mock.requests[1].maxTokens}, expected the fitted ${second.fit}`);
	if (second.fit <= 1024) fail(`the second fit ${second.fit} is not a real answer budget`);
	const lines = overrunNotifies(rpc);
	if (lines.length !== turns) fail(`expected one fit notice per turn (${turns}), got ${JSON.stringify(lines)}`);
	if (new Set(lines).size !== lines.length) fail(`a turn repeated its fit notice: ${JSON.stringify(lines)}`);
	if (starvedNotifies(rpc).length !== 0) fail(`the guard refused a request it should have fitted: ${JSON.stringify(rpc.notifies)}`);
	const lastReason = stopReasons(rpc).at(-1);
	if (lastReason !== "stop") fail(`the fitted turn ended ${lastReason}, expected stop`);
	rpc.close();
	await mock.close();
	console.log(`8. the fit repeats: both requests went out fitted (${first.fit}, ${second.fit}), one notice per turn`);
}

// ---------------------------------------------------------------------------
// 9. The same session shape with the guard off: the request goes out with
//    the budget pi's own estimate allowed, the provider refuses it, and pi
//    takes its destructive recovery path. This is the incident, reproduced
//    against a server that enforces its window; scenario 6 is the same run
//    with the guard loaded, where the request is answered instead.
// ---------------------------------------------------------------------------
{
	const window = 200_000;
	const anchor = 150_020;
	const denseChars = 60_000;
	const { mock, rpc } = await startSession(window, {
		prebuild: true,
		guard: false,
		buildSession: (dir) => prebuildDenseSession(dir, { anchorTokens: anchor, denseChars, historyTurns: 6, historyChars: 50_000 }),
		enforceWindow: { promptTokens: anchor, charsPerToken: 2, requests: 1 },
	});

	await prompt(rpc, "Reply with exactly: OK");
	if (mock.requests.length < 1) fail("the unfitted request never reached the provider");
	const refused = mock.requests.find((request) => request.refused);
	if (!refused) fail(`the provider accepted an unfitted over-window request: budgets ${mockBudgets(mock)}`);
	if (refused.refused.nCtx !== window) fail(`the refusal names ${refused.refused.nCtx}, expected the ${window} window`);
	// The budget pi's own estimate chose is what the guard would have fitted.
	if (refused.maxTokens <= 1) fail(`the unfitted request carried pi's floor: ${refused.maxTokens}`);
	if (rpc.notifies.length !== 0) fail(`the guard spoke though it was not loaded: ${JSON.stringify(rpc.notifies)}`);
	// pi's own answer to the refusal is compaction: the session loses content.
	const entries = await rpc.request("get_entries");
	if (!entries.success) fail(`get_entries: ${JSON.stringify(entries)}`);
	if (!(entries.data?.entries ?? []).some((entry) => entry.type === "compaction")) {
		fail(`expected pi to take its overflow recovery path after the provider's refusal; entries: ${(entries.data?.entries ?? []).map((e) => e.type).join(",")}`);
	}
	rpc.close();
	await mock.close();
	console.log(`9. the same request without the guard: the provider refused it (${refused.refused.promptTokens} counted + ${refused.maxTokens} asked > ${window}) and pi compacted`);
}

// ---------------------------------------------------------------------------
// 10. A fresh session that is already large, with no answer to anchor on:
//     the guard's own Inflation-corrected guess over the payload puts the
//     request over the window, but the guess is not pi's arithmetic and not
//     the provider's, so the guard never refuses on it. The request goes out
//     as pi built it, and the server, which reads this content at pi's own
//     chars/4 rate, answers it. ADR 0028 refuses on pi's arithmetic; this is
//     the branch where the guard's arithmetic would have destroyed a turn
//     that works.
// ---------------------------------------------------------------------------
{
	const window = 200_000;
	const { mock, rpc } = await startSession(window, { compactionEnabled: false, enforceWindow: { promptTokens: 0, charsPerToken: 4, requests: 1 } });

	// 420,000 characters of prompt: the guard's guess reads it at 210,000
	// tokens, over the window, while the server reads it at 105,000.
	await prompt(rpc, "x".repeat(420_000));

	if (mock.requests.length < 1) fail("the guard stopped a request it should have left alone: no request reached the provider");
	const sent = mock.requests[0];
	if (sent.refused) fail(`the provider refused the request the guard left alone: ${JSON.stringify(sent.refused)}`);
	if (starvedNotifies(rpc).length !== 0) fail(`the guard refused on its own unanchored estimate: ${JSON.stringify(starvedNotifies(rpc))}`);
	if (overrunNotifies(rpc).length !== 0) fail(`the guard fitted on its own unanchored estimate: ${JSON.stringify(overrunNotifies(rpc))}`);
	// The server had room for the whole request: its own count plus the
	// budget pi chose sits inside the window.
	if (!(sent.counted + sent.maxTokens <= window)) fail(`the accepted request did not fit: ${sent.counted} + ${sent.maxTokens} > ${window}`);
	if (sent.maxTokens <= 1) fail(`the request that went out carried pi's floor: ${sent.maxTokens}`);
	const lastReason = stopReasons(rpc).at(-1);
	if (lastReason !== "stop") fail(`the turn the guard left alone ended ${lastReason}, expected stop`);
	rpc.close();
	await mock.close();
	console.log(`10. no anchor, no refusal: the guard stayed silent on its own guess, the provider answered (${sent.counted} counted + ${sent.maxTokens} asked)`);
}

console.log("output-starvation e2e: all scenarios passed");
process.exit(0);
