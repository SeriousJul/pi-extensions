// Wiring tests for the output-starvation guard (ADR 0028). The pi wiring
// (index.ts) binds the guard core to before_provider_request and owns the
// refusal: one report line and the run's abort, at most once per turn.
// Every test loads the real extension against a fake pi API; the session is
// a real SessionManager so the context estimate the line names is pi's own
// estimator on a real projection.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import extension from "../../extensions/output-starvation/index";
import { PI_OUTPUT_FLOOR } from "../../extensions/output-starvation/guard.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const WINDOW = 40192;
const MODEL = { provider: "llama.cpp", id: "m1", contextWindow: WINDOW } as Model<Api>;

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 50,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}
function assistant(usage: Usage): AssistantMessage {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "llama.cpp",
		model: "m1",
		usage,
		stopReason: "stop",
		timestamp: clock,
	} as AssistantMessage;
}

interface Handlers {
	sessionStart: ((event: { type: "session_start"; reason: string }, ctx: ExtensionContext) => void) | undefined;
	turnStart: ((event: { type: "turn_start" }, ctx: ExtensionContext) => void) | undefined;
	beforeProviderRequest: ((event: { type: "before_provider_request"; payload: unknown }, ctx: ExtensionContext) => unknown) | undefined;
}

interface Captured {
	notifications: Array<{ message: string; type: string }>;
	aborts: number;
}

function makeContext(
	sm: SessionManager,
	captured: Captured,
	{ model = MODEL, failNotify = false, failProjection = false }: { model?: Model<Api> | null; failNotify?: boolean; failProjection?: boolean } = {},
): ExtensionContext {
	return {
		ui: {
			notify: (message: string, type?: string) => {
				if (failNotify) throw new Error("ui dead");
				captured.notifications.push({ message, type: type ?? "info" });
			},
			setStatus: () => {},
		},
		mode: "rpc",
		hasUI: true,
		cwd: "",
		sessionManager: failProjection ? { buildSessionProjection: () => { throw new Error("projection dead"); } } : sm,
		model: model === null ? undefined : model,
		abort: () => {
			captured.aborts += 1;
		},
	} as unknown as ExtensionContext;
}

/** Load the real extension against a fake pi API. */
function loadExtension(): Handlers {
	const handlers: Handlers = { sessionStart: undefined, turnStart: undefined, beforeProviderRequest: undefined };
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "session_start") handlers.sessionStart = handler as Handlers["sessionStart"];
			if (event === "turn_start") handlers.turnStart = handler as Handlers["turnStart"];
			if (event === "before_provider_request") handlers.beforeProviderRequest = handler as Handlers["beforeProviderRequest"];
		},
	};
	extension(pi as never);
	return handlers;
}

// ---------------------------------------------------------------------------
// Fixture session
// ---------------------------------------------------------------------------

let cwd: string;
let sessionDir: string;
let sm: SessionManager;

/** Build the fixture session: one answered turn (usage 50) and a 400-char
 * prompt, so pi's estimator reads 50 + 100 = 150 tokens for the context a
 * request would carry. */
function buildFixture(): void {
	cwd = mkdtempSync(join(tmpdir(), "output-starvation-wiring-"));
	sessionDir = join(cwd, "sessions");
	const builder = SessionManager.create(cwd, sessionDir);
	builder.appendMessage(user("q1"));
	builder.appendMessage(assistant(USAGE));
	builder.appendMessage(user("f".repeat(400)));
	sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
}

const EXPECTED_ESTIMATE = 150; // usage 50 + 400 chars / 4
const LINE = `output starvation: refused (llama.cpp/m1): context estimate ${EXPECTED_ESTIMATE}, Effective window ${WINDOW}, output budget ${PI_OUTPUT_FLOOR}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("output-starvation wiring", () => {
	beforeEach(() => {
		buildFixture();
	});

	it("refuses a starved request with the report line and the run's abort", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications).toEqual([{ message: LINE, type: "error" }]);
		expect(captured.aborts).toBe(1);
	});

	it("refuses at most once per turn: a second starved request in the same turn adds nothing", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications.length).toBe(1);
		expect(captured.aborts).toBe(1);
	});

	it("refuses again on the next turn, once per turn", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications.length).toBe(2);
		expect(captured.aborts).toBe(2);
	});

	it("resets the flag on a session start, so a replacement session never inherits it", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		handlers.sessionStart!({ type: "session_start", reason: "reload" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications.length).toBe(2);
	});

	it("stays silent on a healthy budget and does not spend the turn's refusal", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: 9972 } }, ctx);

		expect(captured.notifications).toEqual([]);
		expect(captured.aborts).toBe(0);

		// The same turn is still entitled to its refusal if the budget collapses.
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		expect(captured.notifications.length).toBe(1);
		expect(captured.aborts).toBe(1);
	});

	it("stays silent when the payload carries no budget the guard can read", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { temperature: 0.5 } }, ctx);

		expect(captured.notifications).toEqual([]);
		expect(captured.aborts).toBe(0);
	});

	it("refuses with unknown facts when the context carries no model", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { model: null });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications).toEqual([
			{
				message: `output starvation: refused (unknown/unknown): context estimate ${EXPECTED_ESTIMATE}, Effective window 0, output budget ${PI_OUTPUT_FLOOR}`,
				type: "error",
			},
		]);
		expect(captured.aborts).toBe(1);
	});

	it("still aborts when the UI is dead: the abort is the refusal, the line is best-effort", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { failNotify: true });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.aborts).toBe(1);
	});

	it("degrades the estimate to 0 when the projection fails; the trigger is the payload, never the estimate", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { failProjection: true });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);

		expect(captured.notifications).toEqual([
			{
				message: `output starvation: refused (llama.cpp/m1): context estimate 0, Effective window ${WINDOW}, output budget ${PI_OUTPUT_FLOOR}`,
				type: "error",
			},
		]);
		expect(captured.aborts).toBe(1);
	});
});
