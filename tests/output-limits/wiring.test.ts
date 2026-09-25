import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, TextContent, Usage, UserMessage } from "@earendil-works/pi-ai";
import outputLimitsExtension from "../../extensions/output-limits/index";
import { bytesFromTokens, tokensFromBytes, PI_MAX_OUTPUT_BYTES, PI_MAX_OUTPUT_LINES, PI_NOTICE_SLACK_LINES } from "../../extensions/output-limits/core";

// The primary seam, on the shape `tests/pruning/wiring.test.ts` establishes:
// the real extension loaded against a fake `ExtensionAPI`, a real
// `SessionManager`, and a fake `ExtensionContext`, driven with synthetic
// events. Every case asserts the outgoing patch AND the artifacts on disk,
// because the whole promise of this extension is that what the model sees is
// bounded and what the user keeps is not.
//
// The arithmetic below is spelled out in the same units the extension uses,
// so a case fails on a wrong number rather than on a wrong guess.

const WINDOW = 150_000;
const RESERVE = 16_384;
const MATH = { bytesPerChar: 4, inflation: 2 };
// The model the fake context reports, in the shape pi's own reserve reader keys
// `compaction.modelOverrides` by.
const MODEL = { provider: "e2e", id: "m1" };

/**
 * A session with exactly `headroom` tokens left, the way pi would report it.
 */
function usedFor(headroom: number): { tokens: number } {
	const tokens = WINDOW - RESERVE - headroom;
	return { tokens };
}

/** The usage pi reports, in its own shape, for a session with `headroom` left. */
function usageOf(headroom: number): Usage {
	const tokens = WINDOW - RESERVE - headroom;
	return {
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

/** An assistant message asking for `calls`, in the shape pi persists. */
function assistant(calls: Array<{ id: string; name: string }>): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: {} })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku",
		usage: usageOf(0),
		stopReason: "toolUse",
		timestamp: clock,
	} as unknown as AssistantMessage;
}

type Patch = { content?: unknown; details?: unknown; isError?: boolean };
type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<Patch | undefined>;
type SimpleHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

interface Captured {
	[key: string]: unknown;
	sessionStart: SimpleHandler | undefined;
	toolResult: ToolResultHandler | undefined;
	command: CommandHandler | undefined;
	notifications: Array<{ type: string; message: string }>;
}

/** Load the real extension and return the hooks pi would call. */
function loadExtension(cwd: string, sm: SessionManager): Captured {
	const captured = { sessionStart: undefined, toolResult: undefined, command: undefined, notifications: [] } as unknown as Captured;
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "session_start") captured.sessionStart = handler as SimpleHandler;
			if (event === "tool_result") captured.toolResult = handler as ToolResultHandler;
			if (event === "session_compact" || event === "model_select" || event === "session_tree" || event === "session_shutdown") captured[event] = handler;
		},
		registerTool: () => {},
		registerCommand: (_name: string, options: { handler: CommandHandler }) => {
			captured.command = options.handler;
		},
	};
	outputLimitsExtension(pi as never);
	const ctx = fakeContext(cwd, sm, captured, { tokens: WINDOW - RESERVE });
	captured.sessionStart?.({ type: "session_start", reason: "startup" }, ctx);
	return captured;
}

/**
 * A fake `ExtensionContext` whose one live knob is the usage pi reports.
 * `usageTokens: null` is the blind shape right after a compaction, and
 * `noUsage` is the other blind shape: `getContextUsage()` returns nothing.
 */
/**
 * `usage` is what `ctx.getContextUsage()` answers: an object with a token
 * count, an object with no count (the blind shape right after a compaction),
 * or nothing at all (the blind shape with no resolved usage).
 */
type UsageAnswer = { tokens: number | null } | undefined;

function fakeContext(cwd: string, sm: SessionManager, captured: Captured, usage: UsageAnswer): ExtensionContext {
	return {
		ui: {
			notify: (message: string, type?: string) => captured.notifications.push({ type: type ?? "info", message }),
			setStatus: () => {},
			setTitle: () => {},
		},
		mode: "rpc",
		hasUI: true,
		cwd,
		sessionManager: sm,
		model: { contextWindow: WINDOW, provider: MODEL.provider, id: MODEL.id },
		modelRegistry: {},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: new AbortController().signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => (usage === undefined ? undefined : { tokens: usage.tokens, contextWindow: WINDOW, percent: null }),
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
}

function withUsage(captured: Captured, sm: SessionManager, usage: UsageAnswer): ExtensionContext {
	return fakeContext(cwdOf(sm), sm, captured, usage);
}

function cwdOf(sm: SessionManager): string {
	return sm.getCwd();
}

function event(over: Partial<ToolResultEvent> & { toolName: string; toolCallId: string }): ToolResultEvent {
	return { type: "tool_result", input: {}, content: [], details: undefined, isError: false, ...over } as ToolResultEvent;
}

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

/** The text a handler published, or the text it was handed when it did not. */
function published(patch: Patch | undefined, fallback: string): string {
	if (!patch?.content) return fallback;
	return (patch.content as TextContent[])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("|");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let cwd: string;
let agentDir: string;
let sessionDir: string;
let sm: SessionManager;

/** `lines` lines of roughly `width` bytes each, numbered so ends are telling. */
function bigOutput(lines: number, width = 44): string {
	const rows: string[] = [];
	for (let i = 1; i <= lines; i += 1) {
		const head = `line ${i} `;
		rows.push(head + "x".repeat(Math.max(1, width - Buffer.byteLength(head, "utf8"))));
	}
	return rows.join("\n");
}

/** Complete lines in a text, the way this extension counts them. */
function countLinesOf(text: string): number {
	return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

function seed(calls: Array<{ id: string; name: string }>): void {
	const builder = SessionManager.create(cwd, sessionDir);
	builder.appendMessage(user("q"));
	builder.appendMessage(assistant(calls));
	sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
}

function writeSettings(section: Record<string, unknown>): void {
	writeRawSettings({ compaction: { reserveTokens: RESERVE }, outputLimits: section });
}

/** Settings written whole, for a case that needs pi's own section shape. */
function writeRawSettings(value: Record<string, unknown>): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(value));
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "output-limits-wiring-"));
	agentDir = mkdtempSync(join(tmpdir(), "output-limits-wiring-agent-"));
	// Point every reader at the fake agent dir, so a real global settings file
	// or a real Spill directory can never steer a case.
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_OUTPUT_LIMITS", "");
	sessionDir = join(agentDir, "sessions");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { reserveTokens: RESERVE } }));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(cwd, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

/** This session's Spill files, sorted by their sequence prefix. */
function spillFiles(sessionId: string = sm.getSessionId()): string[] {
	const dir = join(agentDir, "output-limits", sessionId);
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function spillText(name: string, sessionId: string = sm.getSessionId()): string {
	return readFileSync(join(agentDir, "output-limits", sessionId, name), "utf8");
}

// ---------------------------------------------------------------------------
// Pass-through rules
// ---------------------------------------------------------------------------

describe("pass-through", () => {
	it("leaves a result inside the Bound alone, with nothing appended and nothing spilled", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(133_616));
		const source = "short output";
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("is invisible at a result pi itself blessed, even at pi's own 50KB", async () => {
		// The outer max is pi's figure plus the slack pi's own notice adds past
		// it, so a result at pi's ceiling is not re-cut here.
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(133_616));
		const source = bigOutput(1_160, 44);
		expect(Buffer.byteLength(source, "utf8")).toBeGreaterThanOrEqual(50 * 1024);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), ctx)).toBeUndefined();
	});

	it("is invisible at a result pi blessed on the line axis, at ample Headroom", async () => {
		// The case the byte-only fixtures never reached: 2000 short content lines
		// is well under pi's 50KB, so pi's own cut lands on the LINE limit and it
		// then appends its notice, making 2002 lines. A ceiling of exactly 2000
		// re-cut a result pi had already blessed, spilled it, and announced a
		// "capped to 51KB" figure about a 10KB result -- all with the window
		// nearly empty. Nothing here may happen.
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(129_616));
		const rows = Array.from({ length: 2000 }, (_, i) => `row ${3001 + i}`).join("\n");
		const source = `${rows}\n\n[Showing lines 3001-5000 of 5000. Full output: /tmp/pi-bash-1f2e.log]`;
		expect(countLinesOf(source)).toBe(2002);
		// Well inside pi's byte figure: the ONLY thing that can cut this result is
		// a line ceiling, which is exactly what was wrong.
		expect(Buffer.byteLength(source, "utf8")).toBeLessThan(PI_MAX_OUTPUT_BYTES);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("is invisible at a many-line grep result, where pi applies no line ceiling at all", async () => {
		// pi hands grep, find, and ls a `maxLines` of Number.MAX_SAFE_INTEGER:
		// their match, result, and entry limits already cap the rows. So a 2500
		// line grep result under pi's byte figure is what pi publishes, and a
		// single 2000-line ceiling here made the extension stricter than pi at
		// any Headroom, which is the one-directional rule turned inside out.
		seed([{ id: "g1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(129_616));
		const source = Array.from({ length: 2500 }, (_, i) => `f${i}.ts:${i + 1}: match`).join("\n");
		expect(countLinesOf(source)).toBe(2500);
		expect(Buffer.byteLength(source, "utf8")).toBeLessThan(PI_MAX_OUTPUT_BYTES);
		expect(await captured.toolResult!(event({ toolName: "grep", toolCallId: "g1", content: [textBlock(source)] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("is invisible at a read result at pi's line ceiling, at ample Headroom", async () => {
		// The flagship loss the review found, on the tool that has no Spill to
		// fall back to: pi read 2000 of 4001 short lines and named the offset.
		// With the extension on and the window nearly empty the model must still
		// be told where to continue, byte-for-byte as pi wrote it.
		seed([{ id: "r1", name: "read" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(129_616));
		const rows = Array.from({ length: 2000 }, (_, i) => `export const r${i + 1} = 1;`).join("\n");
		const source = `${rows}\n\n[Showing lines 1-2000 of 4001. Use offset=2001 to continue.]`;
		expect(countLinesOf(source)).toBe(2002);
		expect(await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(source)], input: { path: "big.ts", offset: 1 } }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("bounds nothing when the tool is not in the settings list", async () => {
		writeSettings({ tools: ["bash"] });
		seed([{ id: "c1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		// Headroom so tight that a 50KB grep result would be cut if this tool
		// were in scope at all.
		const ctx = withUsage(captured, sm, usedFor(1_024));
		const source = bigOutput(1_200, 44);
		expect(await captured.toolResult!(event({ toolName: "grep", toolCallId: "c1", content: [textBlock(source)] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("is inert when PI_OUTPUT_LIMITS is off", async () => {
		vi.stubEnv("PI_OUTPUT_LIMITS", "off");
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(1_024));
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(1_200, 44))] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("is inert when the settings switch is off", async () => {
		writeSettings({ enabled: false });
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(1_024));
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(1_200, 44))] }), ctx)).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("lets a blind call through, because a blind Bound is pi's own figure", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const source = bigOutput(1_200, 44);
		// No usage object at all: `getContextUsage()` returns nothing.
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), withUsage(captured, sm, undefined))).toBeUndefined();
		// And the other blind shape: a usage object with no token count, right
		// after a compaction.
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), withUsage(captured, sm, { tokens: null }))).toBeUndefined();
		expect(spillFiles()).toEqual([]);
	});

	it("reads pi's compaction reserve for the model it is bounding for", async () => {
		// Headroom is the window minus pi's reserve, and pi resolves that reserve
		// per model through `compaction.modelOverrides`. A reader that saw only
		// the plain setting would state a Headroom pi is not working to, and
		// every Bound would be off by the difference.
		writeRawSettings({ compaction: { reserveTokens: RESERVE, modelOverrides: { [`${MODEL.provider}/${MODEL.id}`]: { reserveTokens: 66_384 } } }, outputLimits: {} });
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		// The same usage `ctxTight` reports. With the plain 16384 reserve that
		// leaves 16.4k of Headroom and an 8KB Bound; for this model pi reserves
		// 66384, so the window is already spent and the floor is the only figure
		// left: 4KB, and a Headroom that reads 0.
		const ctx = withUsage(captured, sm, usedFor(TIGHT_HEADROOM));
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(900, 44))] }), ctx), "");
		expect(text).toContain("capped to 4KB (2k tokens) of the 0 token headroom");
	});

	it("leaves a tool outside the five alone however tight the Headroom", async () => {
		seed([{ id: "c1", name: "write" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(1_024));
		expect(await captured.toolResult!(event({ toolName: "write", toolCallId: "c1", content: [textBlock(bigOutput(1_200, 44))] }), ctx)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Bound, Spill, and the patched details
// ---------------------------------------------------------------------------

// Headroom 16384 -> allowance 4096 tokens -> Bound 8192 bytes. Every case
// below that asks for a cut uses these figures.
const TIGHT_HEADROOM = 16_384;
/** A context whose session has exactly `TIGHT_HEADROOM` tokens of Headroom. */
function ctxTight(captured: Captured, target: SessionManager = sm): ExtensionContext {
	return withUsage(captured, target, usedFor(TIGHT_HEADROOM));
}
const BOUND_BYTES = 8_192;
const BOUND_TOKENS = tokensFromBytes(BOUND_BYTES, MATH);
expect(BOUND_BYTES).toBe(bytesFromTokens(BOUND_TOKENS, MATH));

describe("bound and spill", () => {
	it("cuts a large bash result to the Bound, keeps the tail, and spills the whole result", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const source = bigOutput(2_000, 44);
		const patch = await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)] }), ctx);

		expect(patch).toBeDefined();
		const text = published(patch, source);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(BOUND_BYTES);
		// pi's own tail direction: the last line survives, the first does not.
		expect(text).toContain("line 2000 ");
		expect(text).not.toContain("line 1 ");
		expect(text).toContain(`[output-limits: capped to 8KB (${BOUND_TOKENS / 1000 >= 1 ? "4.1k" : BOUND_TOKENS} tokens) of the 16.4k token headroom;`);
		// The path is the real one, and it is inside the agent dir the session
		// resolved: an abbreviation the model cannot open would be a lie.
		expect(text).toContain(`full output: ${join(agentDir, "output-limits")}/`);

		const files = spillFiles();
		expect(files).toHaveLength(1);
		expect(files[0]).toBe("1-bash-c1.log");
		// The Spill holds everything the hook received.
		expect(spillText(files[0])).toBe(`${source}\n`);
	});

	it("names the Spill file with the sequence, the tool, and the call id", async () => {
		seed([
			{ id: "call-aaa111x", name: "bash" },
			{ id: "call-bbb222x", name: "grep" },
		]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "call-aaa111x", content: [textBlock(bigOutput(900, 44))] }), ctx);
		await captured.toolResult!(event({ toolName: "grep", toolCallId: "call-bbb222x", content: [textBlock(bigOutput(900, 44))] }), ctx);
		expect(spillFiles()).toEqual(["1-bash-call-aaa.log", "2-grep-call-bbb.log"]);
	});

	it("writes the Spill directory at 0700 and the file at 0600", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(900, 44))] }), ctx);
		const dir = join(agentDir, "output-limits", sm.getSessionId());
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, spillFiles()[0])).mode & 0o777).toBe(0o600);
	});

	it("patches details.truncation to the extension's own figures so the renderer tells the truth", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const piTruncation = {
			truncated: true,
			truncatedBy: "bytes",
			outputLines: 1_100,
			totalLines: 2_000,
			outputBytes: 51_200,
			totalBytes: 91_200,
			maxLines: 2_000,
			maxBytes: 51_200,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			content: "whatever pi kept",
		};
		const patch = await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(2_000, 44))], details: { truncation: piTruncation } }), ctx);
		const truncation = (patch!.details as Record<string, any>).truncation;
		// The two patched figures are the extension's Bound, not pi's default.
		expect(truncation.maxBytes).toBe(BOUND_BYTES);
		// bash is line-cut by pi at 2000 content lines, and the extension states
		// its own ceiling: pi's figure plus the two lines pi's notice costs.
		expect(truncation.maxLines).toBe(PI_MAX_OUTPUT_LINES + PI_NOTICE_SLACK_LINES);
		// The counts come from the cut that actually ran, so the rendered
		// numbers stay coherent with the text beside them.
		expect(truncation.outputBytes).toBeLessThanOrEqual(BOUND_BYTES);
		expect(truncation.totalBytes).toBe(Buffer.byteLength(bigOutput(2_000, 44), "utf8"));
		expect(truncation.truncated).toBe(true);
	});

	it("points bash's fullOutputPath at the Spill and moves pi's throwaway into it", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		// pi's own log of the whole command output, which holds more than the
		// hook received: the part pi dropped lives in here and nowhere else.
		const piLog = join(cwd, "pi-bash-throwaway.log");
		writeFileSync(piLog, "the whole command output, including what pi dropped\n");
		const source = bigOutput(2_000, 44);
		const patch = await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)], details: { fullOutputPath: piLog } }), ctx);

		const files = spillFiles();
		expect(files).toHaveLength(1);
		expect((patch!.details as Record<string, any>).fullOutputPath).toBe(join(agentDir, "output-limits", sm.getSessionId(), files[0]));
		// One call, one file: pi's log is moved in and adopted whole. The
		// result text is NOT appended after it, because pi's log is a superset
		// of what the hook received and duplicating it would double the file to
		// state nothing new.
		expect(spillText(files[0])).toBe("the whole command output, including what pi dropped\n");
		expect(spillText(files[0])).not.toContain("line 2000 ");
		expect(existsSync(piLog)).toBe(false);
	});

	it("leaves one live path in a capped bash result, not the pi log it moved", async () => {
		// pi's own notice stays because it stays true. That is only honest once
		// the file it names has moved into the Spill, so the name is rewritten
		// too: a path to a moved file is a "No such file" waiting for the model.
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const piLog = join(tmpdir(), "pi-bash-deadbeef.log");
		writeFileSync(piLog, "the whole command output, including what pi dropped\n");
		const source = `${bigOutput(2_000, 44)}\n\n[Showing lines 3071-4000 of 4000 (50.0KB limit). Full output: ${piLog}]`;
		const patch = await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)], details: { fullOutputPath: piLog } }), ctx);
		const text = published(patch, source);

		// pi's notice survives, with its numbers intact and its path repointed.
		expect(text).toContain("[Showing lines 3071-4000 of 4000 (50.0KB limit). Full output: ");
		expect(text).not.toContain(piLog);
		const named = /Full output: ([^\]]+)\]/.exec(text)?.[1];
		expect(named, "pi's notice names no path").toBeDefined();
		const resolved = named!.startsWith("~") ? join(homedir(), named!.slice(2)) : named!;
		const files = spillFiles();
		expect(resolved).toBe(join(agentDir, "output-limits", sm.getSessionId(), files[0]));
		// This extension's own line names the same one file, and it is there.
		expect(text.match(/[Ff]ull output: /g)).toHaveLength(2);
		expect(existsSync(resolved)).toBe(true);
		expect(existsSync(piLog)).toBe(false);
		expect((patch!.details as Record<string, any>).fullOutputPath).toBe(resolved);
		expect(spillText(files[0])).toBe("the whole command output, including what pi dropped\n");
		// The rewrite is charged to the Bound, not added after it.
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(BOUND_BYTES);
	});

	it("spills grep, find, and ls, so the dropped half of a match list survives", async () => {
		seed([
			{ id: "g1", name: "grep" },
			{ id: "f1", name: "find" },
			{ id: "l1", name: "ls" },
		]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		for (const [id, name] of [["g1", "grep"], ["f1", "find"], ["l1", "ls"]] as const) {
			await captured.toolResult!(event({ toolName: name, toolCallId: id, content: [textBlock(bigOutput(900, 44))] }), ctx);
		}
		expect(spillFiles()).toEqual(["1-grep-g1.log", "2-find-f1.log", "3-ls-l1.log"]);
		expect(spillText("1-grep-g1.log")).toBe(`${bigOutput(900, 44)}\n`);
	});

	it("keeps the head for grep, find, and ls, which is pi's own direction", async () => {
		seed([{ id: "g1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const source = bigOutput(2_000, 44);
		const text = published(await captured.toolResult!(event({ toolName: "grep", toolCallId: "g1", content: [textBlock(source)] }), ctx), source);
		expect(text).toContain("line 1 ");
		expect(text).not.toContain("line 2000 ");
	});

	it("bounds read without a Spill and rewrites pi's continuation to the smaller cut", async () => {
		seed([{ id: "r1", name: "read" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const body = bigOutput(2_000, 44);
		const source = `${body}\n\n[Showing lines 1-2000 of 5000 (50.0KB limit). Use offset=2001 to continue.]`;
		const patch = await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(source)], input: { path: "big.ts", offset: 1 } }), ctx);
		const text = published(patch, source);

		expect(spillFiles()).toEqual([]);
		expect(text).toContain("[output-limits: capped to");
		expect(text).toContain("to continue]");
		// pi's stale continuation is gone: two offsets would be a coin flip
		// for the model.
		expect(text).not.toContain("Use offset=2001 to continue");
		// The rewritten offset is the first line the model has not seen.
		const kept = text.split("\n\n[output-limits:")[0];
		expect(text).toContain(`use offset=${1 + kept.split("\n").length} to continue`);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(BOUND_BYTES);
	});

	it("rewrites a read continuation from the offset the call asked for", async () => {
		seed([{ id: "r1", name: "read" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const body = bigOutput(2_000, 44);
		const source = `${body}\n\n[Showing lines 41-2040 of 3000. Use offset=2041 to continue.]`;
		const text = published(await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(source)], input: { path: "big.ts", offset: 41 } }), ctx), source);
		const keptLines = text.split("\n\n[output-limits:")[0].split("\n").length;
		expect(text).toContain(`use offset=${41 + keptLines} to continue`);
	});

	it("leaves a read result whose only overflow was pi's notice line alone", async () => {
		// A read body exactly at the Bound, with pi's continuation line pushing
		// it over. Stripping that line would fit the bytes and take away the only
		// recovery read has, because read keeps no Spill: a body with no offset,
		// no notice, and no pointer is the one way this extension can lose text.
		// So pi's own result stands, and the admitted cost is pi's notice.
		writeSettings({ minOutputBytes: 512 });
		const builder = SessionManager.create(cwd, sessionDir);
		builder.appendMessage(user("q"));
		builder.appendMessage(assistant([{ id: "r1", name: "read" }]));
		sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
		const captured = loadExtension(cwd, sm);
		// Headroom 2048, share 0.25 -> allowance 512 tokens -> 1024 bytes.
		const ctx = withUsage(captured, sm, usedFor(2_048));
		const body = "x".repeat(1_024);
		const source = `${body}\n\n[Showing lines 1-1 of 500. Use offset=2 to continue.]`;
		const patch = await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(source)], input: { path: "big.ts", offset: 1 } }), ctx);
		// Nothing was published, so the session keeps pi's text and pi's pointer.
		expect(patch).toBeUndefined();
		expect(published(patch, source)).toContain("Use offset=2 to continue");
		expect(published(patch, source)).not.toContain("output-limits:");
		expect(spillFiles()).toEqual([]);
	});

	it("always leaves a cut read result with a working continuation", async () => {
		// The other half of the rule: when read IS cut, pi's stale line goes and
		// the extension's own line carries the offset of the first line the model
		// does not have. A read result that survived a cut with no pointer at all
		// is a silent loss of the rest of the file.
		const builder = SessionManager.create(cwd, sessionDir);
		builder.appendMessage(user("q"));
		builder.appendMessage(assistant([{ id: "r1", name: "read" }]));
		sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const body = bigOutput(400, 44);
		const source = `${body}\n\n[Showing lines 1-400 of 4000. Use offset=401 to continue.]`;
		const patch = await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(source)], input: { path: "big.ts", offset: 1 } }), ctx);
		const text = published(patch, source);
		expect(text).toContain("[output-limits: capped to");
		const keptLines = text.split("\n\n[output-limits:")[0]!.split("\n").length;
		expect(text).toContain(`use offset=${1 + keptLines} to continue`);
		// One pointer, not two: pi's stale offset is gone.
		expect(text).not.toContain("Use offset=401 to continue");
		expect((text.match(/offset=/g) ?? []).length).toBe(1);
	});

	it("never invents a continuation for a result that had none to rewrite", async () => {
		seed([{ id: "g1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const text = published(await captured.toolResult!(event({ toolName: "grep", toolCallId: "g1", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(text).toContain("full output:");
		expect(text).not.toContain("use offset=");
	});
});

// ---------------------------------------------------------------------------
// The batch: the Ledger
// ---------------------------------------------------------------------------

describe("ledger", () => {
	// A floor low enough to let the division show: 256 bytes is 128 tokens.
	const DIVIDED = { minOutputBytes: 256 };

	it("divides the allowance across the calls one assistant message asked for", async () => {
		writeSettings(DIVIDED);
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
			{ id: "c", name: "bash" },
			{ id: "d", name: "bash" },
		]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		// Allowance 4096 tokens over 4 calls is 1024 tokens, which is 2048
		// bytes and above the 128-token floor.
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(text).toContain("capped to 2KB (1k tokens) of the 16.4k token headroom left for this message (4 calls)");
	});

	it("rolls forward what a sibling left unused", async () => {
		writeSettings(DIVIDED);
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
		]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		// The first call is small, so it spends almost none of the batch.
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock("tiny")] }), ctx);
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "b", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		// Two calls would be 2048 tokens each; the first left its share intact,
		// so the second reaches almost all 4096 of the allowance.
		expect(text).toContain("capped to 8KB (4.1k tokens)");
	});

	it("keeps the floor as the last word when the batch is already spent", async () => {
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
		]);
		const captured = loadExtension(cwd, sm);
		// Allowance is the floor itself here: 1024 tokens of Headroom is 256
		// after the share, and minOutputBytes lifts it back to 2048 tokens.
		const ctx = withUsage(captured, sm, usedFor(1_024));
		const first = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(first).toContain("capped to 4KB (2k tokens)");
		// The batch is over, and the second call still gets the floor rather
		// than an empty result.
		const second = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "b", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(second).toContain("capped to 4KB (2k tokens)");
	});

	it("still bounds cleanly when the assistant message cannot be read", async () => {
		// Probe 2's fallback: a result whose call id is in no session entry.
		const builder = SessionManager.create(cwd, sessionDir);
		builder.appendMessage(user("q"));
		sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "ghost", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(text).toContain("[output-limits: capped to");
		expect(text).not.toContain("left for this message");
	});

	it("bounds a whole batch whose assistant message cannot be read", async () => {
		// Probe 2's fallback, with three siblings instead of one. The call count
		// is unknown, so each call may reach whatever the batch has left and the
		// accumulation is what bounds them -- which is only true if the three
		// share one batch key. Per-call keys gave every sibling a batch of one
		// and left the message at three times its allowance.
		// An assistant message that asked for calls, none of them this call's:
		// the shape probe 2 warns about, where the session does not read
		// cleanly at `tool_result` time.
		writeSettings(DIVIDED);
		seed([{ id: "some-other-call", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const source = bigOutput(2_000, 44);
		let total = 0;
		const texts: string[] = [];
		for (const id of ["s1", "s2", "s3"]) {
			const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: id, content: [textBlock(source)] }), ctx), "");
			texts.push(text);
			total += Buffer.byteLength(text, "utf8");
		}
		// The allowance is 4096 tokens, which is the 8192-byte Bound. The first
		// call spends it; the floor (256 bytes here) is what the rest may reach.
		expect(texts[0]).toContain("capped to 8KB (4.1k tokens)");
		expect(texts[1]).toContain("capped to 256B (128 tokens)");
		expect(texts[2]).toContain("capped to 256B (128 tokens)");
		expect(total).toBeLessThanOrEqual(BOUND_BYTES + 2 * 256 + 64);
	});

	it("does not freeze a batch at the outer max when its first call is blind", async () => {
		// A call can reach the hook before pi has a usage figure to read. It
		// passes pi's whole result through, and that must not be taken as the
		// batch's allowance: the outer max is a clamp, not a budget. The sibling
		// that does read a Headroom divides what the batch has left, and the
		// blind pass-through counts against it.
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
		]);
		const captured = loadExtension(cwd, sm);
		const source = bigOutput(2_000, 44);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(source)] }), withUsage(captured, sm, undefined))).toBeUndefined();
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "b", content: [textBlock(source)] }), ctxTight(captured)), "");
		// The floor is the last word here. Left at the blind baseline, this call
		// would have reached the outer max instead: 26112 tokens, 52224 bytes.
		expect(text).toContain("capped to 4KB (2k tokens)");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(bytesFromTokens(2_048, MATH));
	});

	it("re-baselines after a compaction, a model switch, or a tree navigation", async () => {
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
		]);
		writeSettings(DIVIDED);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(bigOutput(2_000, 44))] }), ctx);
		for (const hook of ["session_compact", "model_select", "session_tree"] as const) {
			const handler = captured[hook] as SimpleHandler;
			expect(handler, hook).toBeDefined();
			await handler({ type: hook }, ctx);
		}
		// The batch state was dropped, so this call divides a fresh allowance
		// over both calls again. Carried over, the sibling's 2048 admitted
		// tokens would have left the whole remainder to this one: 4KB against
		// 8KB is the difference between a new baseline and a stale one.
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "b", content: [textBlock(bigOutput(2_000, 44))] }), ctx), "");
		expect(text).toContain("capped to 4KB (2k tokens)");
	});
});

// ---------------------------------------------------------------------------
// Lossless or no cut
// ---------------------------------------------------------------------------

describe("lossless or no cut", () => {
	it("leaves pi's result alone when the Spill cannot be written, and says so once per session", async () => {
		seed([
			{ id: "a", name: "bash" },
			{ id: "b", name: "bash" },
		]);
		// A file where the session's Spill directory must be: every write into
		// it fails, and the extension must not cut at all.
		mkdirSync(join(agentDir, "output-limits"), { recursive: true });
		writeFileSync(join(agentDir, "output-limits", "placeholder-session"), "not a directory");
		const builder = SessionManager.create(cwd, sessionDir);
		builder.appendMessage(user("q"));
		builder.appendMessage(assistant([{ id: "a", name: "bash" }]));
		const file = builder.getSessionFile()!;
		// Make the session id be the file that blocks its own Spill directory.
		sm = SessionManager.open(file, join(agentDir, "sessions"), cwd);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		mkdirSync(join(agentDir, "output-limits"), { recursive: true });
		writeFileSync(join(agentDir, "output-limits", sm.getSessionId()), "not a directory");

		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		captured.notifications.length = 0;
		const source = bigOutput(2_000, 44);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(source)] }), ctx)).toBeUndefined();
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "a", content: [textBlock(source)] }), ctx)).toBeUndefined();
		const failures = captured.notifications.filter((n) => n.message.includes("could not write a Spill file"));
		expect(failures).toHaveLength(1);
		expect(failures[0].type).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// Images and errors
// ---------------------------------------------------------------------------

describe("images and errors", () => {
	it("charges an image block against the Bound and never cuts it", async () => {
		seed([{ id: "r1", name: "read" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const picture: ImageContent = { type: "image", data: "A".repeat(200_000), mimeType: "image/png" };
		const patch = await captured.toolResult!(event({ toolName: "read", toolCallId: "r1", content: [textBlock(bigOutput(600, 44)), picture] }), ctx);
		const blocks = patch!.content as Array<TextContent | ImageContent>;
		expect(blocks.filter((block) => block.type === "image")).toHaveLength(1);
		expect((blocks.find((block) => block.type === "image") as ImageContent).data).toBe(picture.data);
		// The text is what pays for the image's charge.
		expect(Buffer.byteLength((blocks.find((block) => block.type === "text") as TextContent).text, "utf8")).toBeLessThanOrEqual(BOUND_BYTES);
	});

	it("bounds an error result too, keeping the tail where the stack trace is", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const source = `${bigOutput(2_000, 44)}\n\nCommand exited with code 1`;
		const patch = await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(source)], isError: true }), ctx);
		const text = published(patch, source);
		expect(text).toContain("Command exited with code 1");
		// The error flag is left alone: a patch that only bounds size does not
		// silently re-open a failed command.
		expect(patch!.isError).toBeUndefined();
		expect(spillFiles()).toHaveLength(1);
	});

	it("keeps the tail for an error result from a head tool", async () => {
		// The reason something failed sits at the end, so the direction that
		// decides a success does not decide a failure (decision 18).
		seed([{ id: "g1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const source = `${bigOutput(2_000, 44)}\n\nError: the pattern is invalid`;
		const text = published(await captured.toolResult!(event({ toolName: "grep", toolCallId: "g1", content: [textBlock(source)], isError: true }), ctx), source);
		expect(text).toContain("Error: the pattern is invalid");
		expect(text).not.toContain("line 1 ");
	});

	it("keeps the multi-block shape when a cut spans blocks", async () => {
		seed([{ id: "g1", name: "grep" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		const patch = await captured.toolResult!(
			event({ toolName: "grep", toolCallId: "g1", content: [textBlock(bigOutput(400, 44)), textBlock(bigOutput(400, 44)), textBlock(bigOutput(400, 44))] }),
			ctx,
		);
		const blocks = patch!.content as TextContent[];
		expect(blocks.length).toBeGreaterThanOrEqual(2);
		expect(blocks.filter((block) => block.text.includes("[output-limits: text dropped"))).not.toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe("retention", () => {
	it("sweeps Spills older than the age limit at session start", async () => {
		const stale = "old-session";
		const dir = join(agentDir, "output-limits", stale);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "1-bash-oldold.log");
		writeFileSync(file, "stale spill\n");
		// An mtime ten days back: past the default 7-day limit.
		utimesSync(file, 0, 0);
		seed([{ id: "c1", name: "bash" }]);
		loadExtension(cwd, sm);
		expect(existsSync(file)).toBe(false);
	});

	it("keeps the newest files when the footprint crosses the size limit", async () => {
		writeSettings({ spill: { maxTotalBytes: 1_000, maxAgeDays: 365 } });
		const dir = join(agentDir, "output-limits", "big-session");
		mkdirSync(dir, { recursive: true });
		for (const name of ["1-bash-aaaa1111.log", "2-bash-bbbb2222.log", "3-bash-cccc3333.log"]) {
			writeFileSync(join(dir, name), "x".repeat(900));
		}
		// Distinct, ordered ages inside the 365-day limit: only the size limit
		// can explain a loss, and the oldest goes first.
		const hour = 3_600;
		const now = Date.now() / 1000;
		utimesSync(join(dir, "1-bash-aaaa1111.log"), now - 3 * hour, now - 3 * hour);
		utimesSync(join(dir, "2-bash-bbbb2222.log"), now - 2 * hour, now - 2 * hour);
		utimesSync(join(dir, "3-bash-cccc3333.log"), now - hour, now - hour);
		seed([{ id: "c1", name: "bash" }]);
		loadExtension(cwd, sm);
		// 3 x 900 bytes against a 1000-byte limit: the two oldest go.
		expect(readdirSync(dir)).toEqual(["3-bash-cccc3333.log"]);
	});

	it("numbers a resumed session's Spills past the files already on disk", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const dir = join(agentDir, "output-limits", sm.getSessionId());
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "7-bash-zzzz0000.log"), "earlier spill\n");
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(900, 44))] }), ctx);
		expect(spillFiles()).toEqual(["7-bash-zzzz0000.log", "8-bash-c1.log"]);
	});

	it("never sweeps pi's own /tmp throwaways", async () => {
		const outside = join(cwd, "pi-bash-not-mine.log");
		writeFileSync(outside, "pi's own file, from a call this extension never touched\n");
		utimesSync(outside, 0, 0);
		seed([{ id: "c1", name: "bash" }]);
		loadExtension(cwd, sm);
		expect(existsSync(outside)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe("/output-limits", () => {
	it("status reports the active Bound inputs and the Spill footprint, not a file list", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(900, 44))] }), ctx);
		captured.notifications.length = 0;
		await captured.command!("status", ctx);
		const text = captured.notifications.map((n) => n.message).join("\n");
		expect(text).toContain("Headroom: 16.4k");
		expect(text).toContain("shareOfHeadroom=0.25");
		expect(text).toContain("last Bound: bash");
		expect(text).toContain("Spill: 1 cut");
		// It reports the footprint, not an enumeration for the model to read.
		expect(text).not.toContain("1-bash");
		// The line ceiling is stated as the per-tool rule it is, because one
		// number would be a lie for three of the five tools.
		expect(text).toContain("bash 2002/read 2002");
		expect(text).toContain("grep/find/ls none");
		// And the tripwire the ceiling bug needed: this cut was the window's, so
		// the ceiling count stays at zero.
		expect(text).toContain("ceiling cuts: 0 cut(s)");
	});

	it("status counts a cut that a ceiling caused rather than the Headroom", async () => {
		// The default outer max is pi's own figure, so with the window open no
		// result should be cut at all. A ceiling the user set below pi's figure
		// can still cut, and `status` has to say so instead of letting the number
		// hide among the Headroom-driven cuts.
		writeSettings({ maxOutputTokens: 4_096 });
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = withUsage(captured, sm, usedFor(129_616));
		const text = published(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(900, 44))] }), ctx), "");
		expect(text).toContain("capped to 8KB (4.1k tokens)");
		captured.notifications.length = 0;
		await captured.command!("status", ctx);
		const status = captured.notifications.map((n) => n.message).join("\n");
		expect(status).toContain("ceiling cuts: 1 cut(s)");
		expect(status).toContain("a ceiling is cutting what pi blessed");
	});

	it("settings maxLines=auto writes the unset answer back", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.command!("settings maxLines=600", ctx);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).outputLimits.maxLines).toBe(600);
		await captured.command!("settings maxLines=auto", ctx);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).outputLimits.maxLines).toBeNull();
		captured.notifications.length = 0;
		await captured.command!("settings", ctx);
		expect(captured.notifications.map((n) => n.message).join("\n")).toContain("outputLimits.maxLines=auto");
	});

	it("off and on persist the switch and reload the state", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.command!("off", ctx);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).outputLimits.enabled).toBe(false);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(2_000, 44))] }), ctx)).toBeUndefined();
		await captured.command!("on", ctx);
		expect(await captured.toolResult!(event({ toolName: "bash", toolCallId: "c1", content: [textBlock(bigOutput(2_000, 44))] }), ctx)).toBeDefined();
	});

	it("settings writes a key and keeps every other setting", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		await captured.command!("settings shareOfHeadroom=0.1", ctx);
		const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(written.compaction.reserveTokens).toBe(RESERVE);
		expect(written.outputLimits.shareOfHeadroom).toBe(0.1);
	});

	it("refuses a malformed value instead of writing it", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		captured.notifications.length = 0;
		await captured.command!("settings shareOfHeadroom=4", ctx);
		expect(captured.notifications.some((n) => n.type === "error")).toBe(true);
		expect(JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8")).outputLimits).toBeUndefined();
	});

	it("reports usage for an unknown verb", async () => {
		seed([{ id: "c1", name: "bash" }]);
		const captured = loadExtension(cwd, sm);
		const ctx = ctxTight(captured);
		captured.notifications.length = 0;
		await captured.command!("nonsense", ctx);
		expect(captured.notifications[0].message).toContain("usage: /output-limits");
	});
});
