/**
 * E2E for the llama-refresh extension (ADR 0027).
 *
 * Spawns a real pi process in RPC mode in a throwaway agent directory,
 * points it at this repository's extension and at the shared mock llama.cpp
 * router (tests/shared/llama-mock-router.mjs), and asserts what a live
 * session does when the catalog drifts:
 *
 *   1. pre-request heal: the catalog moves between the selection and the
 *      first request; the pre-request moment heals the window before the
 *      request is built and reports one line
 *   2. no drift: the catalog confirms the window; the session stays silent
 *   3. asleep at selection: the selection saw the Fallback window; the
 *      request wakes the model and the post-request moment heals
 *   4. shrink: the server came back with a smaller n_ctx; the session
 *      shrinks to it
 *   5. truncated turn: a turn that ends `length` with a near-empty answer
 *      spends an unspent Attempt on an extra compare, and never re-arms
 *   6. dead server: the pre-request failure degrades to silence, the
 *      refresh spends nothing, and the next turn heals
 *   7. context-cap: the cap keeps the session at the cap no matter how the
 *      catalog moves above it; drift that crosses below the cap still heals
 *   8. /llama-window: the command re-arms one Attempt, reports the heal,
 *      confirms an unchanged window, and reports a check failure
 *
 * Any extension_error event fails the run.
 *
 *   node tests/llama-refresh/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startLlamaMockRouter } from "../shared/llama-mock-router.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const refreshExtension = join(repoRoot, "extensions", "llama-refresh", "index.ts");
const capExtension = join(repoRoot, "extensions", "context-cap", "index.ts");
const TIMEOUT_MS = 60_000;
const MODEL = "m1";
const MODEL_B = "m2";

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

function prepareAgentDir(url) {
	const dir = mkdtempSync(join(tmpdir(), "llama-refresh-e2e-"));
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
			// A dead-server scenario must not sit through request retries.
			retry: { enabled: false },
		}),
	);
	return dir;
}

function startRpc(agentDir, extraArgs = []) {
	// --no-extensions: on a machine where this repo is installed as a pi
	// package, discovery loads a second copy of every extension and the
	// duplicate flag registration stops the session starting.
	const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", refreshExtension, ...extraArgs], {
		cwd: agentDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		stdio: ["pipe", "pipe", "pipe"],
	});
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

/** Start a mock + a pi session on it, and wait until the session resolves the model at the expected window. */
async function startSession(models, { cap = null, expectedWindow } = {}) {
	const mock = await startLlamaMockRouter({ models });
	const extraArgs = cap ? ["--extension", capExtension, "--context-window", String(cap)] : [];
	const agentDir = prepareAgentDir(mock.url);
	const rpc = startRpc(agentDir, extraArgs);
	running.push(() => rpc.close());
	// RPC mode has no model picker, and a CLI --model cannot be resolved
	// before the first catalog read, so select the model explicitly once the
	// catalog lists it. This also fires the model_select that re-arms.
	await waitFor(async () => {
		const available = await rpc.request("get_available_models");
		return available.success && (available.data?.models ?? []).some((model) => model.provider === "llama.cpp" && model.id === MODEL);
	}, `catalog to list ${MODEL}`, 90_000);
	const selected = await rpc.request("set_model", { provider: "llama.cpp", modelId: MODEL });
	if (!selected.success) fail(`set_model: ${JSON.stringify(selected)}`);
	await waitFor(async () => {
		const state = await rpc.request("get_state");
		return state.success && state.data?.model?.id === MODEL && state.data.model.contextWindow === expectedWindow;
	}, `session ${MODEL} at window ${expectedWindow}`, 90_000);
	return { mock, rpc };
}

const countEvents = (rpc, type) => rpc.events.filter((event) => event.type === type).length;

/** Prompt and wait until the run has fully settled (agent_settled). */
async function prompt(rpc, message) {
	const settled = countEvents(rpc, "agent_settled");
	const result = await rpc.request("prompt", { message });
	if (!result.success) fail(`prompt: ${JSON.stringify(result)}`);
	await waitFor(() => countEvents(rpc, "agent_settled") > settled, "the run to settle", TIMEOUT_MS);
	// The unattended moments (post-request compare, symptom compare) run
	// after agent_settled; give them a beat to finish.
	await sleep(800);
}

async function window(rpc) {
	const state = await rpc.request("get_state");
	if (!state.success) fail(`get_state: ${JSON.stringify(state)}`);
	return state.data?.model?.contextWindow;
}

async function modelChangeCount(rpc) {
	const entries = await rpc.request("get_entries");
	if (!entries.success) fail(`get_entries: ${JSON.stringify(entries)}`);
	return (entries.data?.entries ?? []).filter((entry) => entry.type === "model_change").length;
}

const healedLine = (from, to) => `llama window: ${from} -> ${to} (llama.cpp/${MODEL})`;

// ---------------------------------------------------------------------------
// 1. The pre-request moment heals drift before the first request is built.
// ---------------------------------------------------------------------------
{
	console.log("\n1. pre-request heal");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 40192, status: "loaded" } }, { expectedWindow: 40192 });
	const changes0 = await modelChangeCount(rpc);
	mock.setNCtx(MODEL, 160000);
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 160000) fail("1. window is not healed to 160000");
	console.log(`ok: window healed to 160000`);
	if (!rpc.notifies.includes(healedLine(40192, 160000))) fail(`1. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: one report line, verbatim");
	if ((await modelChangeCount(rpc)) !== changes0 + 1) fail("1. the heal did not add exactly one model change entry");
	console.log("ok: the heal added one model change entry");
	if (mock.requests.length !== 1) fail(`1. expected exactly one live request, saw ${mock.requests.length}`);
	console.log("ok: the live round trip completed");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 2. No drift: the catalog confirms the window and the session stays silent.
// ---------------------------------------------------------------------------
{
	console.log("\n2. no drift stays silent");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 40192, status: "loaded" } }, { expectedWindow: 40192 });
	const changes0 = await modelChangeCount(rpc);
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 40192) fail("2. the window moved without drift");
	console.log(`ok: window stays 40192`);
	if (rpc.notifies.length !== 0) fail(`2. expected silence, got: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: silent");
	if ((await modelChangeCount(rpc)) !== changes0) fail("2. a no-drift compare wrote a model change entry");
	console.log("ok: no model change entry");
	if (mock.requests.length !== 1) fail(`2. expected exactly one live request, saw ${mock.requests.length}`);
	console.log("ok: the live round trip completed");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 3. Asleep at selection: the selection saw the Fallback window, the request
//    wakes the model, and the post-request moment heals.
// ---------------------------------------------------------------------------
{
	console.log("\n3. asleep at selection, healed post-request");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 160000, status: "sleeping" } }, { expectedWindow: 128000 });
	const changes0 = await modelChangeCount(rpc);
	await prompt(rpc, "Reply with exactly: OK");
	if (mock.models()[MODEL]?.status !== "loaded") fail("3. the request did not wake the model");
	console.log("ok: the request woke the model");
	if ((await window(rpc)) !== 160000) fail("3. the window is not healed to the live 160000");
	console.log("ok: window healed to 160000");
	if (!rpc.notifies.includes(healedLine(128000, 160000))) fail(`3. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: one report line, verbatim");
	if ((await modelChangeCount(rpc)) !== changes0 + 1) fail("3. the heal did not add exactly one model change entry");
	console.log("ok: the heal added one model change entry");
	// A second turn re-arms nothing: both Attempts are spent.
	const reads0 = mock.catalogReads.length;
	const notifies0 = rpc.notifies.length;
	await prompt(rpc, "Reply with exactly: OK");
	if (mock.catalogReads.length !== reads0) fail("3. a second turn ran a compare; the Attempts were spent");
	if (rpc.notifies.length !== notifies0) fail(`3. a second turn reported; got: ${JSON.stringify(rpc.notifies.slice(notifies0))}`);
	console.log("ok: the second turn spent nothing and reported nothing");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 4. Shrink: the server came back with a smaller n_ctx and the session
//    shrinks to it.
// ---------------------------------------------------------------------------
{
	console.log("\n4. shrink");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 160000, status: "loaded" } }, { expectedWindow: 160000 });
	mock.setNCtx(MODEL, 40192);
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 40192) fail("4. the window did not shrink to 40192");
	console.log("ok: window shrank to 40192");
	if (!rpc.notifies.includes(healedLine(160000, 40192))) fail(`4. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: one report line, verbatim");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 5. Truncated turn: a turn that ends `length` with a near-empty answer
//    spends an unspent Attempt on an extra compare, and never re-arms.
// ---------------------------------------------------------------------------
{
	console.log("\n5. truncated turn spends an unspent Attempt, never re-arms");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 40192, status: "loaded" } }, { expectedWindow: 40192 });
	const changes0 = await modelChangeCount(rpc);
	// The answer ends `length` after one token, and the catalog drifts right
	// after that request: only the symptom compare, at the turn end, sees it.
	mock.scriptResponse({ content: "", finishReason: "length", outputTokens: 1 });
	mock.driftAfterRequest(MODEL, 160000);
	await prompt(rpc, "Reply with exactly: OK");
	const truncatedTurn = rpc.events.find((event) => event.type === "turn_end" && event.message?.stopReason === "length" && event.message?.usage?.output <= 8);
	if (!truncatedTurn) fail("5. no near-empty truncated turn was observed");
	console.log("ok: the turn ended length with one output token");
	if (!rpc.notifies.includes(healedLine(40192, 160000))) fail(`5. the symptom compare did not heal; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: the symptom compare spent the unspent post Attempt and healed");
	if ((await window(rpc)) !== 160000) fail("5. the window is not healed to 160000");
	if ((await modelChangeCount(rpc)) !== changes0 + 1) fail("5. the heal did not add exactly one model change entry");
	// The next truncated turn re-arms nothing: both Attempts are spent, so no
	// compare runs at all.
	mock.scriptResponse({ content: "", finishReason: "length", outputTokens: 1 });
	const reads0 = mock.catalogReads.length;
	const notifies0 = rpc.notifies.length;
	await prompt(rpc, "Reply with exactly: OK");
	if (mock.catalogReads.length !== reads0) fail("5. the second truncated turn ran a compare; the trigger re-armed");
	if (rpc.notifies.length !== notifies0) fail(`5. the second truncated turn reported; got: ${JSON.stringify(rpc.notifies.slice(notifies0))}`);
	console.log("ok: the second truncated turn spent nothing and reported nothing");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 6. Dead server: the pre-request failure degrades to silence, the refresh
//    spends nothing, and the next turn heals.
// ---------------------------------------------------------------------------
{
	console.log("\n6. dead server");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 40192, status: "loaded" } }, { expectedWindow: 40192 });
	mock.setNCtx(MODEL, 160000);
	const port = mock.port;
	await mock.close();
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 40192) fail("6. the window moved while the server was down");
	console.log("ok: the failure degraded to silence, window stays 40192");
	if (rpc.notifies.length !== 0) fail(`6. expected silence, got: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: silent");
	const restarted = await startLlamaMockRouter({ port, models: { [MODEL]: { nCtx: 160000, status: "loaded" } } });
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 160000) fail("6. the next turn did not heal the window");
	console.log("ok: the next turn healed the window (the failed refresh spent nothing)");
	if (!rpc.notifies.includes(healedLine(40192, 160000))) fail(`6. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: one report line, verbatim");
	await rpc.close();
	await restarted.close();
}

// ---------------------------------------------------------------------------
// 7. Context-cap: a cap above the drift hides it; a cap above a drifted
//    window still shows the move.
// ---------------------------------------------------------------------------
{
	console.log("\n7. context-cap interaction");
	const CAP = 32000;
	const { mock, rpc } = await startSession(
		{ [MODEL]: { nCtx: 160000, status: "loaded" }, [MODEL_B]: { nCtx: 40192, status: "loaded" } },
		{ cap: CAP, expectedWindow: CAP },
	);
	console.log(`ok: the session resolves at the cap ${CAP}`);
	const rearm = async () => {
		// model_select re-arms both Attempts; a same-model re-select would
		// not fire it, so select the other model and back.
		for (const id of [MODEL_B, MODEL]) {
			const switched = await rpc.request("set_model", { provider: "llama.cpp", modelId: id });
			if (!switched.success) fail(`7. set_model ${id}: ${JSON.stringify(switched)}`);
		}
	};
	// The catalog drifts while staying above the cap. The comparison sees
	// the uncapped move (the cap keeps the session model clamped, not the
	// registry) and reports a heal the cap immediately undoes: one cosmetic
	// line, and the session stays at the cap.
	mock.setNCtx(MODEL, 40192);
	await rearm();
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== CAP) fail(`7. the session escaped the cap; window is ${await window(rpc)}`);
	console.log("ok: the session stays at the cap");
	if (!rpc.notifies.includes(healedLine(CAP, 40192))) fail(`7. the cosmetic heal line is missing; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: the one cosmetic heal line, verbatim");
	// The live value crosses below the cap: the clamped value genuinely
	// moves, and the heal is real.
	mock.setNCtx(MODEL, 24000);
	await rearm();
	await prompt(rpc, "Reply with exactly: OK");
	if ((await window(rpc)) !== 24000) fail("7. the window did not follow the drift below the cap");
	console.log("ok: the window followed the drift below the cap");
	if (!rpc.notifies.includes(healedLine(CAP, 24000))) fail(`7. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: one report line, verbatim");
	await rpc.close();
}

// ---------------------------------------------------------------------------
// 8. /llama-window: the command re-arms one Attempt, reports the heal,
//    confirms an unchanged window, and reports a check failure.
// ---------------------------------------------------------------------------
{
	console.log("\n8. /llama-window command");
	const { mock, rpc } = await startSession({ [MODEL]: { nCtx: 40192, status: "loaded" } }, { expectedWindow: 40192 });
	const changes0 = await modelChangeCount(rpc);
	// Spend both Attempts on a no-drift turn.
	await prompt(rpc, "Reply with exactly: OK");
	if (rpc.notifies.length !== 0) fail(`8. expected silence before the command; got: ${JSON.stringify(rpc.notifies)}`);
	// The catalog drifts; the command re-arms one Attempt and heals.
	mock.setNCtx(MODEL, 160000);
	let result = await rpc.request("prompt", { message: "/llama-window" });
	if (!result.success) fail(`8. command: ${JSON.stringify(result)}`);
	if ((await window(rpc)) !== 160000) fail("8. the command did not heal the window");
	console.log("ok: the command healed the window");
	if (!rpc.notifies.includes(healedLine(40192, 160000))) fail(`8. missing heal line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: the heal line, verbatim");
	if ((await modelChangeCount(rpc)) !== changes0 + 1) fail("8. the command heal did not add exactly one model change entry");
	// An unchanged window confirms.
	result = await rpc.request("prompt", { message: "/llama-window" });
	if (!result.success) fail(`8. command: ${JSON.stringify(result)}`);
	if (!rpc.notifies.includes(`llama window: 160000 (llama.cpp/${MODEL})`))
		fail(`8. missing confirm line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: the confirm line, verbatim");
	// A dead server reports a check failure.
	const port = mock.port;
	await mock.close();
	result = await rpc.request("prompt", { message: "/llama-window" });
	if (!result.success) fail(`8. command: ${JSON.stringify(result)}`);
	if (!rpc.notifies.includes(`llama window: check failed (llama.cpp/${MODEL})`))
		fail(`8. missing check-failed line; notifies: ${JSON.stringify(rpc.notifies)}`);
	console.log("ok: the check-failed line, verbatim");
	await rpc.close();
}

console.log("\nllama-refresh E2E passed");
process.exit(0);
