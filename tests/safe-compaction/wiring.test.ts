import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { createBeforeCompactHandler, checkpointResult } from "../../extensions/safe-compaction/index.ts";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string) {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}
function assistant(text: string) {
	clock += 1000;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "mock",
		model: "mock-model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: clock,
	} as never;
}

function reasoningModel(baseUrl?: string): Model<any> {
	return { id: "mock-model", provider: "mock", api: "openai-completions", baseUrl, contextWindow: 65536, maxTokens: 32768, reasoning: true } as unknown as Model<any>;
}

interface PreparationLike {
	messagesToSummarize: ReturnType<typeof user>[];
	turnPrefixMessages: never[];
	isSplitTurn: boolean;
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
	settings: unknown;
}

function makeEvent(signal?: AbortSignal): SessionBeforeCompactEvent {
	const preparation: PreparationLike = {
		messagesToSummarize: [user("original request"), assistant("did the work")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		firstKeptEntryId: "kept-1",
		tokensBefore: 40000,
		fileOps: { read: new Set(["a.ts"]), written: new Set(["src/app.ts"]), edited: new Set() },
		settings: { enabled: true, reserveTokens: 32768, keepRecentTokens: 4000 },
	};
	return {
		type: "session_before_compact",
		preparation: preparation as never,
		// pi always hands the handler a live signal; the fake mirrors that.
		signal: signal ?? new AbortController().signal,
	} as unknown as SessionBeforeCompactEvent;
}

interface FakeCtx {
	model?: Model<any>;
	thinkingLevel?: string;
	auth: { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string; env?: Record<string, string> } | { ok: false; error: string };
	notifications: { message: string; type: string }[];
	ctx: Parameters<ReturnType<typeof createBeforeCompactHandler>>[1];
}

function makeCtx(overrides: { model?: Model<any>; thinkingLevel?: string; auth?: FakeCtx["auth"] } = {}): FakeCtx {
	const notifications: { message: string; type: string }[] = [];
	const ctx = {
		cwd,
		model: overrides.model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => overrides.auth ?? { ok: true, apiKey: "test-key" },
		},
		thinkingLevel: overrides.thinkingLevel,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type: type ?? "info" });
			},
		},
	};
	return { model: overrides.model, thinkingLevel: overrides.thinkingLevel, auth: overrides.auth ?? { ok: true, apiKey: "test-key" }, notifications, ctx: ctx as never };
}

let tmp: string;
let cwd: string;
let agentDir: string;
let env = {} as NodeJS.ProcessEnv;
let handler: ReturnType<typeof createBeforeCompactHandler>;

function writeAgentSettings(obj: Record<string, unknown>) {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(obj) + "\n", "utf8");
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-compaction-wiring-"));
	cwd = path.join(tmp, "project");
	agentDir = path.join(tmp, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
	// Rebuild the handler per test so it reads the fresh settings env.
	handler = createBeforeCompactHandler(env);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Stand-aside paths: the handler returns undefined and the built-in runs
// ---------------------------------------------------------------------------

describe("stand-aside", () => {
	it("stands aside when the extension is disabled in settings", async () => {
		writeAgentSettings({ safeCompaction: { enabled: false } });
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "xhigh" });
		const result = await handler(makeEvent(), fake.ctx);
		expect(result).toBeUndefined();
		expect(fake.notifications).toEqual([]);
	});

	it("stands aside when the model does not reason", async () => {
		const fake = makeCtx({ model: { ...reasoningModel(), reasoning: false } as Model<any>, thinkingLevel: "xhigh" });
		const result = await handler(makeEvent(), fake.ctx);
		expect(result).toBeUndefined();
	});

	it("stands aside when the session's thinking level is off", async () => {
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "off" });
		const result = await handler(makeEvent(), fake.ctx);
		expect(result).toBeUndefined();
	});

	it("degrades to the checkpoint when there is no session model", async () => {
		const fake = makeCtx({ thinkingLevel: "xhigh" });
		const result = await handler(makeEvent(), { ...fake.ctx, model: undefined });
		// No model: the summary cannot be written, so the guard degrades
		// to the checkpoint rather than handing an unsafe native call back.
		expect(result?.compaction).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Takeover and fallback
// ---------------------------------------------------------------------------

describe("takeover and fallback", () => {
	it("re-runs the compaction when the model reasons and thinking is on", async () => {
		// The provider at the dead port refuses the connection, so the
		// thinking-free run fails and the guard degrades to the checkpoint.
		// What is under test is the decision to call at all, not the call.
		// Retry is disabled so the dead call fails fast instead of spending
		// the backoff budget; the e2e pins the retry forwarding.
		writeAgentSettings({ retry: { enabled: false } });
		const fake = makeCtx({ model: reasoningModel("http://127.0.0.1:1"), thinkingLevel: "xhigh" });
		const result = await handler(makeEvent(), fake.ctx);
		expect(result?.compaction).toBeDefined();
		expect(result?.compaction?.summary).toContain("Checkpoint (deterministic)");
		expect(result?.compaction?.firstKeptEntryId).toBe("kept-1");
		expect(result?.compaction?.details).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["src/app.ts"] });
		const warning = fake.notifications.find((n) => n.type === "warning");
		expect(warning?.message).toContain("the thinking-free summary failed");
	});

	it("falls back to the checkpoint when auth is unavailable", async () => {
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "xhigh", auth: { ok: false, error: "no auth" } });
		const result = await handler(makeEvent(), fake.ctx);
		expect(result?.compaction).toBeDefined();
		expect(fake.notifications.some((n) => n.type === "warning" && n.message.includes("no request auth"))).toBe(true);
	});

	it("cancels when the request was aborted", async () => {
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "xhigh" });
		const abortController = new AbortController();
		abortController.abort();
		const result = await handler(makeEvent(abortController.signal), fake.ctx);
		expect(result).toEqual({ cancel: true });
		expect(fake.notifications).toEqual([]);
	});

	it("keeps working when a settings value is malformed: default stays on and the error is reported", async () => {
		writeAgentSettings({ safeCompaction: { enabled: "yes-please" }, retry: { enabled: false } });
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "xhigh" });
		const result = await handler(makeEvent(), fake.ctx);
		expect(fake.notifications.some((n) => n.type === "error" && n.message.includes("must be a boolean"))).toBe(true);
		// The malformed value fell back to enabled=true, so the guard still
		// took over and still degrades to the checkpoint on the dead call.
		expect(result?.compaction).toBeDefined();
	});

	it("never throws out of the handler", async () => {
		// A context with a broken UI must not stop the fallback. Retry is
		// disabled so any provider failure lands fast on the checkpoint.
		writeAgentSettings({ retry: { enabled: false } });
		const fake = makeCtx({ model: reasoningModel(), thinkingLevel: "xhigh" });
		const ctx = { ...fake.ctx, ui: { notify: () => { throw new Error("ui broken"); } } } as never;
		const result = await handler(makeEvent(), ctx);
		expect(result?.compaction).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// checkpointResult
// ---------------------------------------------------------------------------

describe("checkpointResult", () => {
	it("carries the previous summary verbatim and the preparation's bookkeeping", () => {
		const event = makeEvent();
		event.preparation.previousSummary = "## Prior\nStood on the named controls.";
		const result = checkpointResult(event.preparation);
		expect(result.summary).toContain("Stood on the named controls.");
		expect(result.summary).toContain("original request");
		expect(result.firstKeptEntryId).toBe("kept-1");
		expect(result.tokensBefore).toBe(40000);
	});

	it("combines the history and turn prefix ranges", () => {
		const event = makeEvent();
		event.preparation.turnPrefixMessages = [assistant("turn prefix work")] as never;
		const result = checkpointResult(event.preparation);
		expect(result.summary).toContain("turn prefix work");
	});
});
