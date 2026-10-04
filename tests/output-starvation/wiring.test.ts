// Wiring tests for the output-starvation guard (ADR 0028). The pi wiring
// (index.ts) binds the guard core to before_provider_request and owns what
// the guard does about it: the Fit (a returned payload with a lowered
// budget), the refusal (one report line and the run's abort), the
// once-per-turn budget, and the once-per-session reserve notice. Every test
// loads the real extension against a fake pi API; the session is a real
// SessionManager so the Reported context and the fallback estimate the
// lines name are pi's own figures on a real projection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import extension from "../../extensions/output-starvation/index";
import { PI_OUTPUT_FLOOR, PI_SAFETY_MARGIN } from "../../extensions/output-starvation/guard.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const WINDOW = 40192;
const MODEL = { provider: "llama.cpp", id: "m1", contextWindow: WINDOW } as Model<Api>;
/** A model whose output ceiling sits above pi's default reserve, which is
 * the settings disagreement the guard names once per session. */
const CEILING_MODEL = { provider: "llama.cpp", id: "m1", contextWindow: WINDOW, maxTokens: 32_768 } as Model<Api>;

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
	modelSelect: ((event: { type: "model_select" }, ctx: ExtensionContext) => void) | undefined;
	beforeProviderRequest: ((event: { type: "before_provider_request"; payload: unknown }, ctx: ExtensionContext) => unknown) | undefined;
}

interface Captured {
	notifications: Array<{ message: string; type: string }>;
	aborts: number;
}

function makeContext(
	sm: SessionManager,
	captured: Captured,
	{
		model = MODEL,
		cwd = projectDir,
		failNotify = false,
		failProjection = false,
	}: { model?: Model<Api> | null; cwd?: string; failNotify?: boolean; failProjection?: boolean } = {},
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
		cwd,
		sessionManager: failProjection ? { buildSessionProjection: () => { throw new Error("projection dead"); } } : sm,
		model: model === null ? undefined : model,
		abort: () => {
			captured.aborts += 1;
		},
	} as unknown as ExtensionContext;
}

/** Load the real extension against a fake pi API. */
function loadExtension(): Handlers {
	const handlers: Handlers = { sessionStart: undefined, turnStart: undefined, modelSelect: undefined, beforeProviderRequest: undefined };
	const pi = {
		on: (event: string, handler: unknown) => {
			if (event === "session_start") handlers.sessionStart = handler as Handlers["sessionStart"];
			if (event === "turn_start") handlers.turnStart = handler as Handlers["turnStart"];
			if (event === "model_select") handlers.modelSelect = handler as Handlers["modelSelect"];
			if (event === "before_provider_request") handlers.beforeProviderRequest = handler as Handlers["beforeProviderRequest"];
		},
	};
	extension(pi as never);
	return handlers;
}

// ---------------------------------------------------------------------------
// Fixture session and settings files
// ---------------------------------------------------------------------------

let cwd: string;
let sessionDir: string;
let agentDir: string;
let projectDir: string;
let sm: SessionManager;

/** Write the global settings file the guard reads. */
function writeAgentSettings(settings: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

/** Build the fixture session: one answered turn (usage 50) and a 400-char
 * prompt, so pi's estimator reads 50 + 100 = 150 tokens for the context a
 * request would carry, and the Reported context is 50. */
function buildFixture(): void {
	cwd = mkdtempSync(join(tmpdir(), "output-starvation-wiring-"));
	projectDir = cwd;
	sessionDir = join(cwd, "sessions");
	const builder = SessionManager.create(cwd, sessionDir);
	builder.appendMessage(user("q1"));
	builder.appendMessage(assistant(USAGE));
	builder.appendMessage(user("f".repeat(400)));
	sm = SessionManager.open(builder.getSessionFile()!, sessionDir, cwd);
}

/** A wire payload of the shape pi's OpenAI-compatible providers send, with a
 * dense tool result after the last answer: `denseChars` of content the
 * provider has not counted yet. */
function payloadWith(denseChars: number, budget: number): unknown {
	return {
		model: "m1",
		messages: [
			{ role: "system", content: "s".repeat(400) },
			{ role: "user", content: [{ type: "text", text: "q1" }] },
			{ role: "assistant", content: "done" },
			{ role: "tool", tool_call_id: "c1", content: "t".repeat(denseChars) },
		],
		max_tokens: budget,
	};
}

const EXPECTED_ESTIMATE = 150; // usage 50 + 400 chars / 4
const LINE = `output starvation: refused (llama.cpp/m1): context estimate ${EXPECTED_ESTIMATE}, Effective window ${WINDOW}, output budget ${PI_OUTPUT_FLOOR}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("output-starvation wiring", () => {
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "output-starvation-wiring-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OUTPUT_STARVATION", "");
		buildFixture();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Output overrun: the Fit
// ---------------------------------------------------------------------------

// The fixture's Reported context is 50, so a payload with `denseChars` of
// content after its last answer is estimated at 50 + chars/2 at the default
// math, and the Fit leaves window - estimate - pi's margin.
const DENSE = 40_000;
const DENSE_ESTIMATE = 50 + DENSE / 2; // 20050
const DENSE_FIT = WINDOW - DENSE_ESTIMATE - PI_SAFETY_MARGIN; // 16046

describe("output overrun: the guard fits the budget", () => {
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "output-starvation-wiring-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OUTPUT_STARVATION", "");
		buildFixture();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("returns the payload with the fitted budget and names the line once", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as {
			max_tokens: number;
			model: string;
			messages: unknown[];
		};

		expect(sent.max_tokens).toBe(DENSE_FIT);
		// The Fit owns the budget field and nothing else about the request.
		expect(sent.model).toBe("m1");
		expect(sent.messages.length).toBe(4);
		expect(captured.aborts).toBe(0);
		expect(captured.notifications).toEqual([
			{
				message: `output overrun: fitted budget (llama.cpp/m1): context estimate ${DENSE_ESTIMATE}, Effective window ${WINDOW}, output budget 32768 -> ${DENSE_FIT}`,
				type: "info",
			},
		]);
	});

	it("fits every request in the turn while the notice stays at one line", () => {
		// A Fit is not a refusal: a retry must not go out with the budget that
		// just failed. The notice is capped, the Fit is not.
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const first = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as { max_tokens: number };
		const second = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as { max_tokens: number };

		expect(first.max_tokens).toBe(DENSE_FIT);
		expect(second.max_tokens).toBe(DENSE_FIT);
		expect(captured.notifications.length).toBe(1);
		expect(captured.aborts).toBe(0);
	});

	it("never raises a budget: a payload already inside the room goes out untouched", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const payload = payloadWith(DENSE, 1000);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload }, ctx);

		expect(sent).toBeUndefined();
		expect(payload).toEqual(payloadWith(DENSE, 1000));
		expect(captured.notifications).toEqual([]);
	});

	it("refuses rather than fits when the room left cannot hold any real answer", () => {
		// 80,000 dense characters put the Corrected estimate past the window:
		// the guard refuses instead of sending a budget no answer fits in.
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(80_000, 32_768) }, ctx);
		const estimate = 50 + Math.ceil((80_000 * 2) / 4);

		expect(sent).toBeUndefined();
		expect(captured.aborts).toBe(1);
		// The refusal reads the same line the collapsed budget reads; the
		// figures tell them apart (the budget is pi's choice, not pi's floor).
		expect(captured.notifications).toEqual([
			{
				message: `output starvation: refused (llama.cpp/m1): context estimate ${estimate}, Effective window ${WINDOW}, output budget 32768`,
				type: "error",
			},
		]);
	});

	it("refuses at most once per turn across both refusal kinds", () => {
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(80_000, 32_768) }, ctx);

		expect(captured.notifications.length).toBe(1);
		expect(captured.aborts).toBe(1);
	});

	it("judges a session with no usage anchor on the whole payload, Inflation-corrected", () => {
		// A fresh session that is already large: nothing has been counted, so
		// everything in the payload is trailing.
		rmSync(cwd, { recursive: true, force: true });
		cwd = mkdtempSync(join(tmpdir(), "output-starvation-wiring-"));
		projectDir = cwd;
		const builder = SessionManager.create(cwd, join(cwd, "sessions"));
		builder.appendMessage(user("q1"));
		sm = SessionManager.open(builder.getSessionFile()!, join(cwd, "sessions"), cwd);

		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as { max_tokens: number };

		// 400 system chars + 2 user chars + 4 answer chars + 40000 dense chars,
		// all of it uncounted, at the default math.
		const estimate = Math.ceil(((400 + 2 + 4 + DENSE) * 2) / 4);
		expect(sent.max_tokens).toBe(WINDOW - estimate - PI_SAFETY_MARGIN);
		expect(captured.notifications[0]!.message).toContain(`context estimate ${estimate}`);
	});

	it("lowers a thinking budget that shared the ceiling it just lowered", () => {
		// pi writes thinking_token_budget beside the ceiling and clamps the
		// pair together. A Fit that lowered only the ceiling would send a
		// reasoning budget above the ceiling it just wrote, which vLLM and
		// SGLang reject and which answers with nothing elsewhere.
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const payload = { ...(payloadWith(DENSE, 32_768) as Record<string, unknown>), thinking_token_budget: 16_000 };
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload }, ctx) as Record<string, unknown>;

		expect(sent.max_tokens).toBe(DENSE_FIT);
		expect(sent.thinking_token_budget).toBe(DENSE_FIT - 1024);
		expect(captured.aborts).toBe(0);
	});

	it("never aborts a request it can only judge on its own unanchored guess", () => {
		// A fresh session that is already larger than the window: no answer
		// carries a Reported context, so the estimate is the guard's guess,
		// and the guess says nothing fits. ADR 0028 refuses on pi's
		// arithmetic, so the request goes out as pi built it and the provider
		// is the one that reads it.
		rmSync(cwd, { recursive: true, force: true });
		cwd = mkdtempSync(join(tmpdir(), "output-starvation-wiring-"));
		projectDir = cwd;
		const builder = SessionManager.create(cwd, join(cwd, "sessions"));
		builder.appendMessage(user("q1"));
		sm = SessionManager.open(builder.getSessionFile()!, join(cwd, "sessions"), cwd);

		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const payload = payloadWith(80_000, 32_768);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload }, ctx);

		expect(sent).toBeUndefined();
		expect(captured.notifications).toEqual([]);
		expect(captured.aborts).toBe(0);
	});

	it("does not rebuild pi's session projection for a request the payload alone clears", () => {
		// pi builds one projection per request itself. The guard reads a
		// second one only when the payload does not prove the request has
		// room, so a healthy turn does not pay for the extra build.
		let builds = 0;
		const counting = { buildSessionProjection: () => { builds += 1; return sm.buildSessionProjection(); } } as unknown as SessionManager;
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(counting, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(1000, 20_000) }, ctx);
		expect(builds).toBe(0);

		// The same session on a request the payload cannot clear does read it,
		// and reads it once.
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx);
		expect(builds).toBe(1);
	});

	it("reads the settings it owns: inflation, margin, and the answer floor", () => {
		writeAgentSettings({ outputStarvation: { inflation: 1, safetyMargin: 1024, minAnswerTokens: 20_000 } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as { max_tokens: number };

		// Inflation 1 halves the trailing estimate, and the guard's own margin
		// replaces pi's; the raised answer floor still clears here.
		const estimate = 50 + DENSE / 4;
		expect(sent.max_tokens).toBe(WINDOW - estimate - 1024);
		expect(captured.notifications[0]!.message).toContain(`context estimate ${estimate}`);

		// The same request under a floor the fit cannot clear is refused.
		writeAgentSettings({ outputStarvation: { inflation: 1, safetyMargin: 1024, minAnswerTokens: 30_000 } });
		const raised = loadExtension();
		const raisedCaptured: Captured = { notifications: [], aborts: 0 };
		const raisedCtx = makeContext(sm, raisedCaptured);
		raised.sessionStart!({ type: "session_start", reason: "startup" }, raisedCtx);
		raised.turnStart!({ type: "turn_start" }, raisedCtx);
		expect(raised.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, raisedCtx)).toBeUndefined();
		expect(raisedCaptured.aborts).toBe(1);
	});

	it("stays off when the environment turns it off, and compares pi's raw behavior", () => {
		vi.stubEnv("PI_OUTPUT_STARVATION", "off");
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);

		expect(handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(80_000, 32_768) }, ctx)).toBeUndefined();
		expect(handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx)).toBeUndefined();
		expect(captured.notifications).toEqual([]);
		expect(captured.aborts).toBe(0);
	});

	it("stays off when the settings turn it off", () => {
		writeAgentSettings({ outputStarvation: { enabled: false } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);

		expect(handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx)).toBeUndefined();
		expect(handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx)).toBeUndefined();
		expect(captured.notifications).toEqual([]);
		expect(captured.aborts).toBe(0);
	});

	it("reports a malformed setting and keeps working on the defaults", () => {
		writeAgentSettings({ outputStarvation: { inflation: "2" } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		const sent = handlers.beforeProviderRequest!({ type: "before_provider_request", payload: payloadWith(DENSE, 32_768) }, ctx) as { max_tokens: number };

		expect(sent.max_tokens).toBe(DENSE_FIT); // the default inflation, not the malformed value
		expect(captured.notifications[0]!.message).toContain("outputStarvation.inflation must be a number");
		expect(captured.notifications[0]!.type).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// The reserve disagreement notice
// ---------------------------------------------------------------------------

describe("reserve disagreement notice", () => {
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "output-starvation-wiring-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OUTPUT_STARVATION", "");
		buildFixture();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("names the disagreement once per session when the reserve sits below the output ceiling", () => {
		writeAgentSettings({ compaction: { reserveTokens: 16_384 } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { model: CEILING_MODEL });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.modelSelect!({ type: "model_select" }, ctx);
		handlers.modelSelect!({ type: "model_select" }, ctx);

		expect(captured.notifications).toEqual([
			{
				message:
					"output starvation: reserve disagreement (llama.cpp/m1): compaction reserve 16384, model output ceiling 32768; set compaction.reserveTokens to 32768 or more",
				type: "warning",
			},
		]);
	});

	it("says nothing when the reserve clears the model's output ceiling", () => {
		// The settings-level workaround the ticket names: a reserve at or above
		// the ceiling keeps pi's own threshold honest, and the guard stays quiet.
		writeAgentSettings({ compaction: { reserveTokens: 32_768 } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { model: CEILING_MODEL });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.modelSelect!({ type: "model_select" }, ctx);

		expect(captured.notifications).toEqual([]);
	});

	it("says nothing for a model that names no output ceiling", () => {
		writeAgentSettings({ compaction: { reserveTokens: 16_384 } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.modelSelect!({ type: "model_select" }, ctx);

		expect(captured.notifications).toEqual([]);
	});

	it("names the disagreement a later model brings, once", () => {
		// A session that starts on a model with no disagreement and moves to
		// one that has it still hears about it, and only once.
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured);
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		expect(captured.notifications).toEqual([]);
		const ceilingCtx = makeContext(sm, captured, { model: CEILING_MODEL });
		handlers.modelSelect!({ type: "model_select" }, ceilingCtx);
		handlers.modelSelect!({ type: "model_select" }, ceilingCtx);
		expect(captured.notifications.length).toBe(1);
	});

	it("resets the per-turn flags on a model selection, so nothing stale survives it", () => {
		writeAgentSettings({ compaction: { reserveTokens: 16_384 } });
		const handlers = loadExtension();
		const captured: Captured = { notifications: [], aborts: 0 };
		const ctx = makeContext(sm, captured, { model: CEILING_MODEL });
		handlers.sessionStart!({ type: "session_start", reason: "startup" }, ctx);
		handlers.turnStart!({ type: "turn_start" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		expect(captured.aborts).toBe(1);

		// A second starved request in the same turn is refused only once...
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		expect(captured.aborts).toBe(1);
		// ...and the flag is cleared again by the model selection.
		handlers.modelSelect!({ type: "model_select" }, ctx);
		handlers.beforeProviderRequest!({ type: "before_provider_request", payload: { max_tokens: PI_OUTPUT_FLOOR } }, ctx);
		expect(captured.aborts).toBe(2);
	});
});
