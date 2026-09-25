/**
 * E2E for the output limits extension (issue #107).
 *
 * Spawns a real pi process in RPC mode in a throwaway directory with the
 * extension loaded and no live LLM: a probe extension registers a scripted
 * provider that answers each prompt with real tool calls, then a "done"
 * text. The scripted provider also names how full the context is, which is
 * the knob the Bound is computed from. Asserts, against the real session file
 * and the real Spill directory on disk:
 *
 *   1. no extension error at load or during any case
 *   2. a real `bash` call whose output crosses the Bound is capped in the
 *      session file, and the Spill file holds the whole result the hook
 *      received: the loss is one cut preserved in a file, not a lost half
 *   3. the capped text in the session file carries pi's own notice plus the
 *      extension's line with the real numbers and the Spill path
 *   4. the same command with ample Headroom is left exactly as pi produced it:
 *      no notice, no Spill, nothing appended
 *   5. `details.truncation.maxBytes` in the session file is the extension's
 *      Bound, not pi's 50KB, so the built-in renderer tells the truth
 *   6. two real parallel `bash` calls in one assistant message divide the
 *      message allowance, and the batch line names both calls
 *   7. a real `read` of a big file is capped without a Spill, and pi's own
 *      `Use offset=` continuation is rewritten to the smaller cut
 *   8. a real `grep` result past the Bound is capped and spilled
 *   9. the Spill directory is 0700 and every Spill file is 0600
 *  10. the off switch leaves everything alone: pi's own result and no Spill
 *  11. with the agent dir on the home filesystem, which is where decision 20
 *      puts the Spill root and is a different device from the `/tmp` pi logs
 *      bash to, a bash result is still bounded: the adopt moves pi's log by
 *      copy when a rename cannot cross the device, and the session text names
 *      one live path
 *  12. a many-LINE result is left alone while the Headroom is ample, on the
 *      two tools pi cuts by line (bash and read) and on the one it does not
 *      (grep): the session text is byte-identical to what the same command
 *      produced with the extension off, and no Spill exists
 *
 * Each run is its own `pi` process. The `on` and `off` runs keep the agent dir
 * beside pi's temp dir, which is fast and tidy; the `cross-device` run puts it
 * under the home filesystem, which is where decision 20 says the Spill root
 * lives and what makes the `EXDEV` path real rather than simulated. On a
 * machine where `/tmp` and the home share a device that run still proves the
 * capping and the single live path; it just cannot exercise the copy.
 *
 *   node tests/output-limits/e2e-rpc.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piCli = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extensionPath = join(repoRoot, "extensions", "output-limits", "index.ts");
const probePath = join(repoRoot, "tests", "output-limits", "e2e-probe.ts");
const TIMEOUT_MS = 90_000;

// The window the scripted provider declares, and pi's reserve default. The
// Headroom is `CONTEXT_WINDOW - RESERVE - usage`, so `TIGHT_INPUT` leaves
// 16384 tokens: the allowance is 4096 tokens, and the Bound is 8192 bytes.
const CONTEXT_WINDOW = 150_000;
const RESERVE = 16_384;
const TIGHT_INPUT = CONTEXT_WINDOW - RESERVE - 16_384;
const OPEN_INPUT = 4_000;
const BOUND_BYTES = 8_192;

/** A line-emitting command whose output is well past the Bound. */
const BIG_COMMAND = `seq 1 4000 | awk '{printf "row %s %s\\n", $1, "'\''xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'\''"}'`;

// The line axis, deliberately: 5000 rows of a few bytes each is about 25KB, so
// pi's own cut lands on its 2000-LINE figure and not on 50KB. The result pi
// blesses is therefore 2002 lines (2000 kept plus pi's blank line and notice)
// and roughly 10KB. A ceiling of exactly 2000 lines re-cut it and spilled a
// 10KB result in a nearly empty session, which is the same failure the byte
// notice allowance was added for, on the other unit.
const MANY_LINE_COMMAND = "seq 1 5000";
/** pi's own content and notice figures, restated for the case guards above. */
const PI_MAX_OUTPUT_BYTES = 50 * 1024;
const PI_NOTICE_SLACK_BYTES = 1024;
/** Enough short lines that pi's own line cut, not its byte cut, is what binds. */
const MANY_LINES = 4000;

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

/** The bytes of a session-file toolResult message's first text block. */
function resultText(entry) {
	const content = entry?.message?.content ?? [];
	return content.filter((block) => block.type === "text").map((block) => block.text).join("|");
}

/** The session entries, parsed from the JSONL the real run wrote. */
function sessionEntries(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

/**
 * The exact Bound a cut enforced, read from the patched
 * `details.truncation.maxBytes`, cross-checked against the notice line that
 * states it.
 *
 * The notice rounds both of its numbers for display ("8KB (4.1k tokens)"),
 * which is what the spec shows the model, so the two figures are compared with
 * a display-rounding tolerance rather than for equality. pi's reported usage
 * includes this turn's own output tokens, so every Bound here sits a little
 * under the clean figure: what is being proved is that the session text fits
 * the number the extension published, not that the number is round.
 */
function boundOf(entry, text) {
	const match = /\[output-limits: capped to (\d+(?:\.\d+)?)(B|KB|MB) \((\d+(?:\.\d+)?)(k)? tokens\)/.exec(text);
	if (!match) throw new Error(`no Bound the extension states in the notice:\n${text.slice(-320)}`);
	const shown = Number(match[1]) * (match[2] === "KB" ? 1024 : match[2] === "MB" ? 1024 * 1024 : 1);
	const shownTokens = Number(match[3]) * (match[4] ? 1000 : 1);
	// The extension's own math is tokens * bytesPerChar / inflation = x2.
	if (Math.abs(shownTokens * 2 - shown) > 0.11 * shown + 512) {
		throw new Error(`notice bytes ${shown} and tokens ${shownTokens} disagree`);
	}
	const exact = entry.message.details?.truncation?.maxBytes;
	if (typeof exact !== "number") throw new Error("no patched details.truncation.maxBytes");
	if (Math.abs(exact - shown) > 0.06 * shown + 128) throw new Error(`maxBytes ${exact} does not match the notice's ${shown}`);
	return { exact, shown };
}

/** Every Spill file this session's run wrote, across its session directories. */
function spillNames(agentDir, file) {
	const sessionId = sessionEntries(file)[0].id;
	const dir = join(agentDir, "output-limits", sessionId);
	return existsSync(dir) ? readdirSync(dir) : [];
}

function entriesFor(smFile, toolCallId) {
	return sessionEntries(smFile).filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolCallId === toolCallId);
}

/**
 * A directory on the filesystem the home lives on. pi writes its bash logs to
 * `$TMPDIR`, which is tmpfs on a typical Linux, so an agent dir here puts the
 * Spill root on a different device from the file decision 9 says to move: the
 * layout where a rename throws `EXDEV`.
 */
function homeAgentDir(label) {
	const base = join(homedir(), ".cache", "pi-output-limits-e2e");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, `${label}-`));
}

/**
 * `agentDir` picks where the session's state lives. The default puts it beside
 * pi's temp dir, which is fast and tidy; the cross-device run overrides it,
 * because that is the layout real users have.
 */
async function runSession(label, settings, cases, { agentDir: pickAgentDir = () => mkdtempSync(join(tmpdir(), `output-limits-e2e-${label}-agent-`)) } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), `output-limits-e2e-${label}-`));
	const agentDir = pickAgentDir();
	const caseFile = join(cwd, "e2e-case.json");
	// A real file on disk, big enough for the read case to be cut.
	const target = join(cwd, "big.ts");
	writeFileSync(target, Array.from({ length: 4000 }, (_, i) => `export const row${i + 1} = "${"y".repeat(40)}";`).join("\n") + "\n");
	// And a short-line one, so a read of it crosses pi's LINE figure while
	// staying far inside pi's byte figure. That is the only shape where the line
	// ceiling is what binds, and it is the shape this file used to miss.
	const many = join(cwd, "many.txt");
	writeFileSync(many, Array.from({ length: MANY_LINES }, (_, i) => `x${i + 1}`).join("\n") + "\n");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	writeFileSync(caseFile, JSON.stringify({ runId: 0, calls: [], inputTokens: 0 }));

	// pi's default tool set is read, bash, edit, write. grep, find, and ls are
	// off unless asked for, and this extension bounds them, so ask.
	const child = spawn(
		process.execPath,
		[piCli, "--mode", "rpc", "--tools", "read,bash,grep,find,ls", "--extension", extensionPath, "--extension", probePath],
		{
			cwd,
			env: { ...process.env, E2E_CASE_FILE: caseFile, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let buffer = "";
	const pending = new Map();
	let nextId = 1;
	let stderr = "";
	const events = [];
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
				events.push(record);
				if (record.type === "extension_error") extensionErrors.push(record);
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
				reject(new Error(`timed out waiting for ${command}\nevents:\n${events.map((e) => JSON.stringify(e).slice(0, 200)).join("\n")}\nstderr:\n${stderr}`));
			}, TIMEOUT_MS);
			pending.set(id, (record) => {
				clearTimeout(timer);
				resolve(record);
			});
			child.stdin.write(JSON.stringify({ id, type: command, ...fields }) + "\n");
		});
	const waitForTurn = async (what) => {
		const deadline = Date.now() + TIMEOUT_MS;
		for (;;) {
			const record = await request("get_state");
			if (record.success && record.data?.isStreaming === false && record.data?.needsContinuation !== true) return;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstderr:\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	};

	// pi writes sessions under `<agentDir>/sessions/--<cwd slug>--/<id>.jsonl`.
	const sessionFile = () => {
		const files = [];
		const walk = (dir) => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
			}
		};
		walk(join(agentDir, "sessions"));
		if (files.length !== 1) throw new Error(`expected one session file, found ${JSON.stringify(files)}\nstderr:\n${stderr}`);
		return files[0];
	};

	try {
		await new Promise((resolve) => setTimeout(resolve, 6000)); // session start has run by now
		const setModel = await request("set_model", { provider: "e2ol", modelId: "e2e-1" });
		if (!setModel.success) fail(`set_model: ${JSON.stringify(setModel)}\nstderr:\n${stderr}`);

		for (const [index, test] of cases.entries()) {
			writeFileSync(caseFile, JSON.stringify({ runId: index + 1, calls: test.calls, inputTokens: test.inputTokens }));
			const prompt = await request("prompt", { message: `run case ${index + 1}` });
			if (!prompt.success) fail(`case ${index + 1} (${test.name}): prompt: ${JSON.stringify(prompt)}\nstderr:\n${stderr}`);
			await waitForTurn(`case ${index + 1} to settle`);
			console.log(`ok: case ${index + 1}: ${test.name}`);
		}
		if (extensionErrors.length > 0) fail(`extension errors: ${JSON.stringify(extensionErrors, null, 2)}`);
		return { cwd, agentDir, sessionFile: sessionFile(), stderr };
	} finally {
		child.stdin.end();
		child.kill();
	}
}

/** Run the cases, then assert on what landed on disk. */
const CASES = [
	{
		name: "a real bash call past the Bound is capped in the session and spilled in full",
		calls: [{ id: "e2-big", name: "bash", arguments: { command: BIG_COMMAND } }],
		inputTokens: TIGHT_INPUT,
		assert: ({ file }) => {
			const entries = entriesFor(file, "e2-big");
			if (entries.length !== 1) throw new Error(`expected one session entry for e2-big, got ${entries.length}`);
			const text = resultText(entries[0]);
			// The session file holds the capped text and nothing else.
			const { exact } = boundOf(entries[0], text);
			if (exact > BOUND_BYTES || exact < BOUND_BYTES - 256) throw new Error(`the Bound is ${exact}, expected just under ${BOUND_BYTES}`);
			if (Buffer.byteLength(text, "utf8") > exact) {
				throw new Error(`session text is ${Buffer.byteLength(text, "utf8")} bytes, above its own ${exact}-byte Bound`);
			}
			if (!text.includes("[output-limits: capped to") || !text.includes(" of the 16.4k token headroom")) {
				throw new Error(`the extension's line with the real numbers is missing:\n${text.slice(-400)}`);
			}
			if (!text.includes("row 4000 ")) throw new Error(`bash's own tail was not kept:\n${text.slice(0, 200)}`);
			if (!/pi-bash|output-limits/.test(text)) throw new Error("no full-output path named in the notice");
			// And pi's own notice survived, because it stays true: the file it
			// names is the Spill, and nothing in the text points at pi's moved
			// throwaway.
			if (!text.includes("[Showing lines")) throw new Error(`pi's own notice is gone:\n${text.slice(-400)}`);
			assertOneLivePath(entries[0], text, "bash");
			const details = entries[0].message.details ?? {};
			// The patched figure is the real Bound, a few bytes below the clean
			// 8192 because pi's usage counts this turn's own output too, and it
			// is not pi's default: that is what makes the TUI honest.
			if (details.truncation.maxBytes === 50 * 1024) throw new Error("details.truncation.maxBytes was left at pi's default");
			if (!details.fullOutputPath || !existsSync(details.fullOutputPath)) throw new Error(`fullOutputPath does not exist: ${details.fullOutputPath}`);
			// The Spill holds everything the hook received: the whole 4000 rows.
			const spill = readFileSync(details.fullOutputPath, "utf8");
			for (const probe of ["row 1 ", "row 2000 ", "row 4000 "]) {
				if (!spill.includes(probe)) throw new Error(`the Spill is missing ${probe}`);
			}
			if (spill.length < text.length) throw new Error("the Spill is smaller than the capped session text");
			const name = spill.split("\n")[0];
			if (!/^(row 1 |\[)/.test(name)) throw new Error(`unexpected Spill head: ${name.slice(0, 60)}`);
		},
	},
	{
		name: "the same command with ample Headroom is left exactly as pi produced it",
		calls: [{ id: "e2-open", name: "bash", arguments: { command: BIG_COMMAND } }],
		inputTokens: OPEN_INPUT,
		assert: ({ file, agentDir }) => {
			const entries = entriesFor(file, "e2-open");
			if (entries.length !== 1) throw new Error(`expected one session entry for e2-open, got ${entries.length}`);
			const text = resultText(entries[0]);
			if (text.includes("output-limits:")) throw new Error("the extension announced itself in an open session");
			const details = entries[0].message.details ?? {};
			if (details.truncation && details.truncation.maxBytes !== 50 * 1024) {
				throw new Error(`details.truncation.maxBytes was patched to ${details.truncation.maxBytes}`);
			}
			if (text.includes("row 4000") === false) throw new Error("the open-session result lost its tail");
			// No Spill for this call: a result that fits inside the Bound is
			// never copied anywhere, so nothing is stored for it.
			const names = spillNames(agentDir, file);
			if (names.some((name) => name.includes("-bash-e2-open"))) {
				throw new Error(`a Spill was written for a result that fits: ${names.join(", ")}`);
			}
		},
	},
	{
		name: "two real parallel bash calls divide the message allowance",
		calls: [
			{ id: "e2-p1", name: "bash", arguments: { command: BIG_COMMAND } },
			{ id: "e2-p2", name: "bash", arguments: { command: BIG_COMMAND } },
		],
		inputTokens: TIGHT_INPUT,
		assert: ({ file }) => {
			const texts = ["e2-p1", "e2-p2"].map((id) => resultText(entriesFor(file, id)[0]));
			let batchBytes = 0;
			for (const [i, id] of ["e2-p1", "e2-p2"].entries()) {
				const text = texts[i];
				const { exact } = boundOf(entriesFor(file, id)[0], text);
				if (Buffer.byteLength(text, "utf8") > exact) {
					throw new Error(`${id} admitted ${Buffer.byteLength(text, "utf8")} bytes, above its own ${exact}-byte Bound`);
				}
				batchBytes += Buffer.byteLength(text, "utf8");
				// The batch line names the two calls of this assistant message.
				if (!text.includes("left for this message (2 calls)")) throw new Error(`${id} does not name the batch:\n${text.slice(-320)}`);
				// Neither call may reach the whole single-call Bound: the
				// allowance was divided between them.
				if (exact >= BOUND_BYTES) throw new Error(`${id} states an undivided Bound of ${exact}`);
			}
			// The promise the batch makes is about the batch. Each call's share
			// is the allowance divided by the calls still to come, and the first
			// call cannot fill its share exactly (complete lines and the notice
			// reserve), so the second rolls forward what the first left. The
			// total is what has to stay inside the message allowance: 4096
			// tokens, which is 8192 bytes.
			if (batchBytes > BOUND_BYTES) {
				throw new Error(`the batch admitted ${batchBytes} bytes, above the ${BOUND_BYTES}-byte message allowance`);
			}
			if (batchBytes < BOUND_BYTES * 0.9) {
				throw new Error(`the batch admitted only ${batchBytes} of the ${BOUND_BYTES}-byte allowance it was given`);
			}
		},
	},
	{
		name: "a real read is capped without a Spill and its continuation is rewritten",
		calls: [{ id: "e2-read", name: "read", arguments: { path: "big.ts" } }],
		inputTokens: TIGHT_INPUT,
		assert: ({ file, agentDir }) => {
			const entries = entriesFor(file, "e2-read");
			if (entries.length !== 1) throw new Error(`expected one session entry for e2-read, got ${entries.length}`);
			const text = resultText(entries[0]);
			const { exact } = boundOf(entries[0], text);
			if (Buffer.byteLength(text, "utf8") > exact) throw new Error(`read admitted ${Buffer.byteLength(text, "utf8")} bytes past its ${exact}-byte Bound`);
			if (!text.includes("use offset=")) throw new Error(`no rewritten continuation:\n${text.slice(-320)}`);
			if (text.includes("Use offset=4000 to continue") || /\[Showing lines .*Use offset=\d+ to continue\.\]/.test(text)) {
				throw new Error(`pi's stale continuation was left beside the new one:\n${text.slice(-320)}`);
			}
			// read is bounded without a Spill: its source is already a file.
			if (spillNames(agentDir, file).some((name) => name.includes("-read-"))) {
				throw new Error(`read wrote a Spill: ${spillNames(agentDir, file).join(", ")}`);
			}
			// The rewritten offset points at the first line the model has not
			// seen, so a follow-up read continues where this one stopped.
			const keptLines = text.split("\n\n[output-limits:")[0].split("\n").length;
			if (!text.includes(`use offset=${1 + keptLines} to continue`)) {
				throw new Error(`continuation names an offset that skips lines: kept ${keptLines}\n${text.slice(-320)}`);
			}
		},
	},
	{
		name: "a real grep result is capped and spilled",
		// pi's own match limit is 100, which keeps a grep result inside the
		// 8KB Bound on its own. Asking for more is what makes the case cross it.
		calls: [{ id: "e2-grep", name: "grep", arguments: { pattern: "export const row", path: ".", limit: 4000 } }],
		inputTokens: TIGHT_INPUT,
		assert: ({ file }) => {
			const entries = entriesFor(file, "e2-grep");
			if (entries.length !== 1) throw new Error(`expected one session entry for e2-grep, got ${entries.length}`);
			const text = resultText(entries[0]);
			const { exact } = boundOf(entries[0], text);
			if (Buffer.byteLength(text, "utf8") > exact) throw new Error(`grep admitted ${Buffer.byteLength(text, "utf8")} bytes past its ${exact}-byte Bound`);
			// grep keeps its head: the first matches survive, the far end does
			// not. The match list is sorted by path, so the case file leads and
			// big.ts rows follow; what matters is the deep tail is gone.
			if (!text.includes("big.ts:1:")) throw new Error(`grep did not keep its head:\n${text.slice(0, 160)}`);
			if (text.includes("big.ts:3900:")) throw new Error("grep kept its tail, so this case proves nothing");
			const spillPath = text.match(/full output: (\S+)\]/)[1];
			const spill = readFileSync(spillPath.replace(/^~/, process.env.HOME ?? "~"), "utf8");
			// Fidelity, stated exactly: the Spill holds everything the hook
			// received, which for grep is pi's own 50KB result, not the whole
			// match stream. So the claim is that the Spill is a superset of the
			// session text: the half this extension dropped is still on disk.
			if (spill.length <= text.length) throw new Error(`the Spill (${spill.length}) does not hold more than the session text (${text.length})`);
			const lastInSpill = [...spill.matchAll(/big\.ts:(\d+):/g)].pop();
			const lastInSession = [...text.matchAll(/big\.ts:(\d+):/g)].pop();
			if (!lastInSpill || !lastInSession) throw new Error("no big.ts rows to compare");
			if (Number(lastInSpill[1]) <= Number(lastInSession[1])) {
				throw new Error(`the Spill stops at row ${lastInSpill[1]}, the session at ${lastInSession[1]}`);
			}
		},
	},
];

/**
 * Every full-output path a capped result names, resolved for `~`. pi's notice
 * and this extension's line each name one, so the honest promise is that the
 * set has one member and that the member exists: one live path.
 */
function namedPaths(text) {
	const found = [...text.matchAll(/[Ff]ull output: (\S+)\]/g)].map((m) => m[1]);
	return [...new Set(found.map((p) => (p.startsWith("~") ? join(process.env.HOME ?? "~", p.slice(2)) : p)))];
}

function assertOneLivePath(entry, text, label) {
	const named = namedPaths(text);
	if (named.length !== 1) throw new Error(`${label}: the session text names ${named.length} distinct full-output paths, expected 1: ${JSON.stringify(named)}`);
	if (!existsSync(named[0])) throw new Error(`${label}: the path the model is told to read does not exist: ${named[0]}`);
	const details = entry.message.details ?? {};
	if (details.fullOutputPath !== named[0]) {
		throw new Error(`${label}: details.fullOutputPath ${details.fullOutputPath} is not the path the text names ${named[0]}`);
	}
	// Both lines point at the Spill, so pi's own throwaway is gone from the
	// text: following it would have been a "No such file".
	if (/pi-bash-[0-9a-f]+\.log/.test(text)) throw new Error(`${label}: pi's own throwaway path is still in the session text`);
}

/** Complete lines in a session result, the way the extension counts them. */
function countResultLines(text) {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * pi's own result for a command, with the parts that differ between two
 * processes removed: the random name of pi's bash throwaway, and the temp dir
 * around it. Everything left is what the model was sent, so an enabled session
 * that re-cut the result cannot match it.
 */
function normalizePiResult(text) {
	return text.replace(/\/[^\s]*?[\\/]?pi-bash-[0-9a-f]+\.log/g, "<PI-BASH-LOG>");
}

/** pi's blessed line count for a result it cut to its own line figure. */
const PI_BLESSED_LINES = 2002;

/** call id -> a `pair` name the disabled run records pi's text under. */
const piOwnTexts = new Map();

/**
 * The many-line cases, written once and run twice: enabled, where the promise
 * is that the session text is byte-identical to pi's own result, and disabled,
 * which records what pi's own result was.
 *
 * Every one of these is a result that crosses pi's 2000-LINE figure and stays
 * far inside its 50KB byte figure, so the line axis is the only thing that
 * could cut it -- and with the Headroom ample, nothing may.
 */
const MANY_LINE_CASES = [
	{
		pair: "bash-many-lines",
		name: "bash at 2000+ short lines",
		calls: [{ id: "e2-many-bash", name: "bash", arguments: { command: MANY_LINE_COMMAND } }],
		inputTokens: OPEN_INPUT,
		// pi's own notice is a byte-limit notice only when pi cut by bytes; on
		// this fixture pi cuts by lines, so its notice names no size figure.
		expectPiMarker: "[Showing lines 3001-5000 of 5000. Full output: ",
	},
	{
		pair: "read-many-lines",
		name: "read of a file past 2000 short lines",
		calls: [{ id: "e2-many-read", name: "read", arguments: { path: "many.txt" } }],
		inputTokens: OPEN_INPUT,
		// pi's continuation is the whole recovery mechanism here: read keeps no
		// Spill, so a result that loses `Use offset=` loses the rest of the file.
		expectPiMarker: "[Showing lines 1-2000 of 4001. Use offset=2001 to continue.]",
	},
	{
		pair: "grep-many-lines",
		name: "grep past 2000 matches, where pi applies no line ceiling at all",
		// A grep result has to stay inside pi's byte figure for this to be a
		// LINE-axis case: pi caps its rows at `limit`, then truncates by bytes
		// alone, with no line figure at all. So 2400 short match rows is about
		// 40KB and 2400 lines -- the only ceiling that could bind it is one this
		// extension invented, and at ample Headroom it must not.
		calls: [{ id: "e2-many-grep", name: "grep", arguments: { pattern: "^x", path: ".", limit: 2400 } }],
		inputTokens: OPEN_INPUT,
		expectPiMarker: "[2400 matches limit reached. Use limit=4800 for more, or refine pattern]",
		maxBytes: 50 * 1024,
	},
];

/** The enabled form: assert the session text is exactly what pi produced. */
function ampleCase(test) {
	return {
		name: `ample Headroom leaves ${test.name} exactly as pi produced it`,
		calls: test.calls.map((call) => ({ ...call, id: `on-${call.id}` })),
		inputTokens: test.inputTokens,
		assert: ({ file, agentDir }) => {
			for (const call of test.calls) {
				const entries = entriesFor(file, `on-${call.id}`);
				if (entries.length !== 1) throw new Error(`expected one session entry for ${call.id}, got ${entries.length}`);
				const text = resultText(entries[0]);
				// 1. The extension never announced itself, and never patched the
				//    record: what is in the session is pi's result and pi's numbers.
				if (text.includes("output-limits:")) throw new Error(`${call.id}: the extension spoke in an open session`);
				const details = entries[0].message.details ?? {};
				if (details.truncation && details.truncation.maxBytes !== 50 * 1024) {
					throw new Error(`${call.id}: details.truncation.maxBytes was patched to ${details.truncation.maxBytes}`);
				}
				if (test.expectPiMarker !== null && !text.includes(test.expectPiMarker)) {
					throw new Error(`${call.id}: pi's own notice is missing:\n${text.slice(-260)}`);
				}
				// 2. The fixture really is a many-line result that pi did not
				//    byte-truncate, so the line axis is what this case is about.
				const lines = countResultLines(text);
				if (lines < PI_BLESSED_LINES) throw new Error(`${call.id}: ${lines} lines, so pi's own line figure never bound this result`);
				const byteCeiling = test.maxBytes ?? PI_MAX_OUTPUT_BYTES + PI_NOTICE_SLACK_BYTES;
				if (Buffer.byteLength(text, "utf8") > byteCeiling) {
					throw new Error(`${call.id}: ${Buffer.byteLength(text, "utf8")} bytes, above ${byteCeiling}, so a byte figure is what bound it`);
				}
				// 3. No Spill for this call: a result that fits its Bound is never
				//    copied anywhere, so nothing is stored for it. Spill files carry
				//    the first eight characters of the call id, which is what makes
				//    this check per call rather than per session.
				const own = spillNames(agentDir, file).filter((name) => name.includes(call.id.slice(0, 8)));
				if (own.length > 0) throw new Error(`${call.id}: a Spill was written for a result that fits: ${own.join(", ")}`);
				// 4. The strong one: byte-identical to the same command run with
				//    the extension off, once pi's random temp names are set aside.
				const control = piOwnTexts.get(test.pair);
				if (control === undefined) throw new Error(`${call.id}: no control text was recorded, so this case proves nothing`);
				const mine = normalizePiResult(text);
				if (mine !== control) {
					throw new Error(`${call.id}: the session text is not pi's own result\n--- enabled ---\n${mine.slice(-320)}\n--- pi alone ---\n${control.slice(-320)}`);
				}
			}
		},
	};
}

/** The disabled form: record pi's own result as the control text. */
function controlCase(test) {
	return {
		name: `control: pi's own result for ${test.name}`,
		calls: test.calls,
		inputTokens: test.inputTokens,
		assert: ({ file }) => {
			for (const call of test.calls) {
				const entries = entriesFor(file, call.id);
				const text = resultText(entries[0]);
				if (text.includes("output-limits:")) throw new Error(`the control for ${call.id} is not pi's own result`);
				if (countResultLines(text) < PI_BLESSED_LINES) {
					throw new Error(`control ${call.id} has ${countResultLines(text)} lines, so it never crossed pi's line figure`);
				}
				const byteCeiling = test.maxBytes ?? PI_MAX_OUTPUT_BYTES + PI_NOTICE_SLACK_BYTES;
				if (Buffer.byteLength(text, "utf8") > byteCeiling) {
					throw new Error(`control ${call.id} is ${Buffer.byteLength(text, "utf8")} bytes, above ${byteCeiling}`);
				}
				piOwnTexts.set(test.pair, normalizePiResult(text));
			}
		},
	};
}

const DISABLED_CASES = [
	{
		name: "off: the same big bash call is left at pi's own result with no Spill",
		calls: [{ id: "e2-d-big", name: "bash", arguments: { command: BIG_COMMAND } }],
		inputTokens: TIGHT_INPUT,
		assert: ({ file, agentDir }) => {
			const entries = entriesFor(file, "e2-d-big");
			const text = resultText(entries[0]);
			if (text.includes("output-limits:")) throw new Error("the extension ran with the off switch set");
			if (Buffer.byteLength(text, "utf8") <= BOUND_BYTES) throw new Error("the result was smaller than the Bound, so this case proves nothing");
			if (spillNames(agentDir, file).length > 0) throw new Error(`a Spill was written while disabled: ${spillNames(agentDir, file).join(", ")}`);
		},
	},
	// The control texts, captured first so the enabled run can be held to them.
	...MANY_LINE_CASES.map(controlCase),
];

// The flagship case, run where the Spill root actually lives: a different
// filesystem from the `/tmp` log pi wrote for the same command.
const CROSS_DEVICE_CASES = [
	{
		name: "a bash result is bounded when pi's log is on another device",
		calls: [{ id: "e2-xdev", name: "bash", arguments: { command: BIG_COMMAND } }],
		inputTokens: TIGHT_INPUT,
		assert: ({ file }) => {
			const entries = entriesFor(file, "e2-xdev");
			if (entries.length !== 1) throw new Error(`expected one session entry for e2-xdev, got ${entries.length}`);
			const text = resultText(entries[0]);
			// The Bound holds, so the rename that could not cross the device did
			// not turn into "leave pi's whole result in the session".
			const { exact } = boundOf(entries[0], text);
			if (exact > BOUND_BYTES || exact < BOUND_BYTES - 256) throw new Error(`the Bound is ${exact}, expected just under ${BOUND_BYTES}`);
			if (Buffer.byteLength(text, "utf8") > exact) {
				throw new Error(`session text is ${Buffer.byteLength(text, "utf8")} bytes, above its own ${exact}-byte Bound`);
			}
			if (!text.includes("[output-limits: capped to")) throw new Error("the extension left no notice at all");
			if (!text.includes("row 4000 ")) throw new Error("bash's own tail was not kept");
			assertOneLivePath(entries[0], text, "cross-device");
			// The one live path is the complete file: what pi dropped crossed the
			// device with it, by copy.
			const spill = readFileSync(namedPaths(text)[0], "utf8");
			for (const probe of ["row 1 ", "row 2000 ", "row 4000 "]) {
				if (!spill.includes(probe)) throw new Error(`the Spill is missing ${probe}`);
			}
		},
	},
];

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

const runs = [
	// `off` runs first: it records pi's own result for the many-line commands,
	// which the enabled run is then held to byte for byte.
	{
		label: "off",
		settings: { compaction: { reserveTokens: RESERVE }, outputLimits: { enabled: false } },
		cases: DISABLED_CASES,
	},
	{
		label: "on",
		settings: { compaction: { reserveTokens: RESERVE }, outputLimits: { enabled: true } },
		cases: [...CASES, ...MANY_LINE_CASES.map(ampleCase)],
	},
	{
		label: "cross-device",
		settings: { compaction: { reserveTokens: RESERVE }, outputLimits: { enabled: true } },
		cases: CROSS_DEVICE_CASES,
		agentDir: () => homeAgentDir("cross-device"),
	},
];

let failed = 0;
for (const run of runs) {
	let result;
	try {
		result = await runSession(run.label, run.settings, run.cases, run);
	} catch (error) {
		fail(`run ${run.label}: ${error.message}`);
	}
	try {
		for (const [index, test] of run.cases.entries()) {
			test.assert({ file: result.sessionFile, agentDir: result.agentDir });
			console.log(`  asserted: ${test.name}`);
		}
		// Every Spill file this run wrote is 0600 in a 0700 directory.
		const root = join(result.agentDir, "output-limits");
		if (existsSync(root)) {
			for (const sessionId of readdirSync(root)) {
				const dir = join(root, sessionId);
				if (statSync(dir).mode & 0o777 !== 0o700) fail(`run ${run.label}: Spill directory ${dir} is not 0700`);
				for (const name of readdirSync(dir)) {
					const mode = statSync(join(dir, name)).mode & 0o777;
					if (mode !== 0o600) fail(`run ${run.label}: Spill file ${name} is ${mode.toString(8)}, expected 0600`);
				}
			}
		}
		console.log(`PASS: run ${run.label}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL: run ${run.label}: ${error.message}`);
	} finally {
		rmSync(result.cwd, { recursive: true, force: true });
		rmSync(result.agentDir, { recursive: true, force: true });
	}
}

if (failed > 0) process.exit(1);
console.log("PASS: output-limits e2e");
