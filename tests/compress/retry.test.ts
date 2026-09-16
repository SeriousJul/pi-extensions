import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import compressExtension from "../../extensions/compress/index";
import { SPAN_FRAME } from "../../extensions/compress/core";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

function assistant(text: string, stopReason: "stop" | "error" = "stop"): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "comp-model",
		usage: ZERO_USAGE,
		stopReason,
		...(stopReason === "error" ? { errorMessage: "boom" } : {}),
		timestamp: clock,
	} as AssistantMessage;
}

const ERROR_RESULT: AssistantMessage = assistant("boom", "error");

function makeModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "test",
		id: "comp-model",
		contextWindow: 20000,
		maxTokens: 4096,
		...overrides,
	} as unknown as Model<Api>;
}

interface FakeRegistry {
	find: (provider: string, id: string) => Model<Api> | undefined;
	hasConfiguredAuth: (model: Model<Api>) => boolean;
	getAvailable: () => Model<Api>[];
	complete: (model: Model<Api>, context: unknown, options: unknown) => Promise<AssistantMessage>;
}

interface FakeCtx {
	ctx: {
		hasUI: boolean;
		cwd: string;
		sessionManager: SessionManager;
		modelRegistry: FakeRegistry;
		ui: {
			notify: (message: string, kind?: "info" | "warning" | "error") => void;
			setStatus: (key: string, value: string | undefined) => void;
			select: (title: string, options: string[]) => Promise<string | undefined>;
		};
		notifications: string[];
	};
}

/** Drive the real extension factory: captures the handlers and the
 * registered command, and returns a context built over a real
 * SessionManager. */
const tmpDirs: string[] = [];

function setup(options: { model?: Model<Api>; complete?: (model: Model<Api>) => Promise<AssistantMessage> } = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compress-retry-"));
	tmpDirs.push(tmp);
	vi.stubEnv("PI_CODING_AGENT_DIR", tmp);
	const cwd = path.join(tmp, "project");
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".pi", "settings.json"),
		JSON.stringify({ compress: { model: "test/comp-model", keepTurns: 2, spanCapTokens: 500, minSpanTokens: 100 } }),
		"utf8",
	);

	const model = options.model ?? makeModel();
	const completeCalls: Model<Api>[] = [];
	const complete = options.complete ?? (async () => ERROR_RESULT);
	const registry: FakeRegistry = {
		find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		hasConfiguredAuth: () => true,
		getAvailable: () => [model],
		complete: async (m) => {
			completeCalls.push(m);
			return complete(m);
		},
	};

	// Four turns so turn 1 is a span (keep window is two finished turns).
	// Turn 1's user message is large enough to pass the 100-token gate.
	const sm = SessionManager.inMemory();
	const text = "a".repeat(1000);
	for (let i = 1; i <= 4; i++) {
		sm.appendMessage(user(i === 1 ? `q1: ${text}` : `q${i}`));
		sm.appendMessage(assistant(`a${i}`));
	}

	const notifications: string[] = [];
	const ctx: FakeCtx["ctx"] = {
		hasUI: true,
		cwd,
		sessionManager: sm,
		modelRegistry: registry,
		ui: {
			notify: (message) => notifications.push(message),
			setStatus: () => {},
			select: async () => undefined,
		},
		notifications,
	};

	const handlers: Record<string, unknown[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const pi = {
		on: (event: string, handler: unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = { handler: def.handler };
		},
		appendEntry: () => {},
	} as never;
	compressExtension(pi);

	return {
		completeCalls,
		notifications,
		sm,
		ctx,
		start: () => (handlers.session_start as Array<(event: unknown, ctx: unknown) => Promise<void>>)[0]({}, ctx),
		turnEnd: () => (handlers.turn_end as Array<() => void>)[0](),
		context: (messages: AgentMessage[]) => (handlers.context as Array<(event: { messages: AgentMessage[] }) => { messages: AgentMessage[] } | undefined>)[0]({ messages }),
		shutdown: () => (handlers.session_shutdown as Array<() => void>)[0](),
		command: commands["compression-model"],
	};
}

/** Let the one-at-a-time queue drain. */
async function settle(iterations = 20): Promise<void> {
	for (let i = 0; i < iterations; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Failure behavior: retry cap, input gate, model change
// ---------------------------------------------------------------------------

describe("compression failures", () => {
	it("retries a failing span after each turn and gives up after three calls", async () => {
		const t = setup();
		await t.start();

		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(1);
		expect(t.notifications.filter((n) => n.includes("compression call failed"))).toHaveLength(1);

		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(2);
		// The once-per-span warning does not repeat.
		expect(t.notifications.filter((n) => n.includes("compression call failed"))).toHaveLength(1);

		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(3);
		expect(t.notifications.some((n) => n.includes("will not be retried"))).toBe(true);

		// The retry cap was hit: further turns pay nothing.
		t.turnEnd();
		await settle();
		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(3);
	});

	it("never calls the model for a span that cannot fit its context window", async () => {
		const t = setup({ model: makeModel({ contextWindow: 1500 }) });
		await t.start();

		t.turnEnd();
		await settle();
		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(0);
		expect(t.notifications.filter((n) => n.includes("larger than the compression model's context window"))).toHaveLength(1);
	});

	it("resets the retry cap when the compression model changes", async () => {
		const t = setup();
		await t.start();

		t.turnEnd();
		await settle();
		t.turnEnd();
		await settle();
		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(3);

		const secondModel = makeModel({ id: "comp-model-2" });
		t.ctx.modelRegistry.find = (provider, id) => (provider === "test" && id === secondModel.id ? secondModel : undefined);
		t.ctx.modelRegistry.complete = async (m: Model<Api>) => {
			t.completeCalls.push(m);
			return assistant("What was asked: done");
		};
		await t.command.handler("test/comp-model-2", t.ctx);

		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(4);
		expect(t.completeCalls[3]).toBe(secondModel);
	});

	it("does not start a queued call after session shutdown", async () => {
		const t = setup({
			complete: async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return ERROR_RESULT;
			},
		});
		await t.start();

		t.turnEnd();
		t.shutdown();
		await settle();
		expect(t.completeCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The swap: a paid span comes out of the next request as its form message
// ---------------------------------------------------------------------------

describe("the swap", () => {
	it("replaces a cached span with its form message in the outgoing request", async () => {
		const form = "What was asked: q1. What was done: none.";
		const t = setup({ complete: async () => assistant(form) });
		await t.start();

		t.turnEnd();
		await settle();
		expect(t.completeCalls).toHaveLength(1);

		const outgoing = structuredClone(t.sm.buildSessionContext().messages);
		expect(outgoing).toHaveLength(8);
		const result = t.context(outgoing);
		expect(result).toBeDefined();
		// Turn 1 (two messages) is one form message now.
		expect(result!.messages).toHaveLength(7);
		const first = result!.messages[0];
		expect(first.role).toBe("user");
		if (first.role === "user") {
			const content = typeof first.content === "string" ? first.content : "";
			expect(content).toContain(SPAN_FRAME);
			expect(content).toContain(form);
		}
		// The rest of the conversation goes out untouched.
		expect(result!.messages.slice(1)).toEqual(outgoing.slice(2));
	});
});
