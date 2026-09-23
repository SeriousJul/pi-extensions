import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";

// pi 0.85.1 does not re-export TreePreparation at the package root; mirror
// the fields the tests set.
type TreePreparation = {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: ReturnType<SessionManager["getEntries"]>;
	userWantsSummary: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};
import type { Api, AssistantMessage, Model, Usage, UserMessage } from "@earendil-works/pi-ai";
import { BRANCH_SUMMARY_PREAMBLE, SUMMARIZATION_SYSTEM_PROMPT } from "../../extensions/safe-branch-summary/prompts.ts";
import { createBeforeTreeHandler } from "../../extensions/safe-branch-summary/index.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const USAGE: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let clock = 0;
function user(text: string): UserMessage {
	clock += 1000;
	return { role: "user", content: text, timestamp: clock };
}

function assistant(text: string): AssistantMessage {
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
	} as AssistantMessage;
}

function modelWith(window: number | undefined, maxTokens: number | undefined): Model<Api> {
	return { contextWindow: window, maxTokens: maxTokens } as unknown as Model<Api>;
}

interface CompleteCall {
	systemPrompt: string | undefined;
	userText: string;
	maxTokens: number;
	signal: AbortSignal;
}

let tmp: string;
let cwd: string;
let agentDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safe-branch-summary-wiring-"));
	cwd = path.join(tmp, "project");
	agentDir = path.join(tmp, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	env = { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv;
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

	function writeGlobalSettings(settings: unknown): void {
		fs.mkdirSync(agentDir, { recursive: true });
		// The tests run against a 8192-token window; the reserve margin pi
		// would otherwise read (16384) would swallow the whole window.
		const file = { branchSummary: { reserveTokens: 2048 }, ...(settings as object) };
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(file) + "\n", "utf8");
	}

interface FakeSession {
	notices: { message: string; type: "info" | "warning" | "error" }[];
	calls: CompleteCall[];
	handler: ReturnType<typeof createBeforeTreeHandler>;
	model: Model<Api>;
	run(event: SessionBeforeTreeEvent, brokenModel?: Model<Api>): Promise<unknown>;
}

function makeSession(model: Model<Api>, complete: (call: CompleteCall) => Promise<AssistantMessage>, settings?: unknown): FakeSession {
	writeGlobalSettings(settings ?? {});
	const notices: { message: string; type: "info" | "warning" | "error" }[] = [];
	const calls: CompleteCall[] = [];
	const handler = createBeforeTreeHandler(env);
	const session: FakeSession = {
		notices,
		calls,
		handler,
		model,
		async run(event, brokenModel) {
			const ctx = {
				cwd,
				model: brokenModel ?? model,
				modelRegistry: {
					complete: async (
						_m: Model<Api>,
						context: { systemPrompt?: string; messages: UserMessage[] },
						options: { signal: AbortSignal; maxTokens: number },
					) => {
						const message = context.messages[0];
						const userText =
							typeof message.content === "string"
								? message.content
								: message.content.find((block) => block.type === "text")?.text ?? "";
						const call = {
							systemPrompt: context.systemPrompt,
							userText,
							maxTokens: options.maxTokens,
							signal: options.signal,
						};
						calls.push(call);
						return complete(call);
					},
				},
				ui: {
					notify: (message: string, type?: "info" | "warning" | "error") => {
						notices.push({ message, type: type ?? "info" });
					},
				},
			};
			return handler(event, ctx);
		},
	};
	return session;
}

function eventFor(
	entries: ReturnType<SessionManager["getEntries"]>,
	opts: Partial<TreePreparation> = {},
	controller = new AbortController(),
): SessionBeforeTreeEvent {
	return {
		type: "session_before_tree",
		preparation: {
			targetId: "target-1",
			oldLeafId: "old-leaf",
			commonAncestorId: "root",
			entriesToSummarize: entries,
			userWantsSummary: true,
			...opts,
		},
		signal: controller.signal,
	};
}

function seedBranch(size = 2000): ReturnType<SessionManager["getEntries"]> {
	const sm = SessionManager.inMemory(cwd);
	sm.appendMessage(user("hello world"));
	sm.appendMessage(assistant("here is code: " + "a".repeat(size)));
	return sm.getEntries();
}

// ---------------------------------------------------------------------------
// When to summarize
// ---------------------------------------------------------------------------

describe("when to summarize", () => {
	it("disabled settings stay out so the built-in runs", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => {
			throw new Error("must not be called");
		}, { safeBranchSummary: { enabled: false } });
		await expect(session.run(eventFor(seedBranch(0)))).resolves.toBeUndefined();
		expect(session.calls).toHaveLength(0);
		expect(session.notices).toHaveLength(0);
	});

	it("does not act when the user did not ask for a summary", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => {
			throw new Error("must not be called");
		});
		await expect(session.run(eventFor(seedBranch(0), { userWantsSummary: false }))).resolves.toBeUndefined();
		expect(session.calls).toHaveLength(0);
	});

	it("an empty abandoned branch writes no entry", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => {
			throw new Error("must not be called");
		});
		await expect(session.run(eventFor([]))).resolves.toBeUndefined();
		expect(session.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Degenerate navigation outcomes
// ---------------------------------------------------------------------------

describe("degenerate navigation outcomes", () => {
	it("nothing-fits writes the built-in's no-content entry", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => {
			throw new Error("must not be called");
		});
		const sm = SessionManager.inMemory(cwd);
		sm.appendMessage(user("x".repeat(50_000)));
		await expect(session.run(eventFor(sm.getEntries()))).resolves.toEqual({ summary: { summary: "No content to summarize" } });
		expect(session.calls).toHaveLength(0);
	});

	it("a window at or below the reserve soft-skips with a warning", async () => {
		const session = makeSession(modelWith(2048, 16384), async () => {
			throw new Error("must not be called");
		});
		await expect(session.run(eventFor(seedBranch(0)))).resolves.toEqual({ summary: { summary: "" } });
		expect(session.calls).toHaveLength(0);
		expect(session.notices).toHaveLength(1);
		expect(session.notices[0].type).toBe("warning");
		expect(session.notices[0].message).toContain("at or below the reserved margin");
	});
});

// ---------------------------------------------------------------------------
// The summary request
// ---------------------------------------------------------------------------

describe("the summary request", () => {
	it("sends the standalone context through the registry with the safe caps", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => assistant("## Goal\nsummarized the branch"));
		const result = (await session.run(eventFor(seedBranch()))) as { summary: { summary: string; usage?: Usage; details?: unknown } };
		expect(result.summary.summary).toContain(BRANCH_SUMMARY_PREAMBLE);
		expect(result.summary.summary).toContain("## Goal");
		expect(result.summary.usage).toEqual(USAGE);
		expect(result.summary.details).toEqual({ readFiles: [], modifiedFiles: [] });

		expect(session.calls).toHaveLength(1);
		const call = session.calls[0];
		expect(call.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(call.userText).toContain("<conversation>");
		expect(call.userText).toContain("here is code:");
		expect(call.maxTokens).toBe(4096);
	});

	it("passes the instructions options through to the prompt", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => assistant("## Goal\nok"));
		await session.run(eventFor(seedBranch(100), { customInstructions: "Focus on tests", label: "checkpoint" }));
		expect(session.calls[0].userText).toContain("Additional focus: Focus on tests");
		// The label itself is applied by pi to the summary entry; the
		// extension only reports the summary.
		expect(session.calls).toHaveLength(1);
	});

	it("a request error soft-skips with a warning", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => {
			throw new Error("400: exceed_context_size_error");
		});
		await expect(session.run(eventFor(seedBranch(0)))).resolves.toEqual({ summary: { summary: "" } });
		expect(session.notices).toHaveLength(1);
		expect(session.notices[0].type).toBe("warning");
		expect(session.notices[0].message).toContain("exceed_context_size_error");
		expect(session.notices[0].message).toContain("navigation continued without a summary");
	});

	it("an error response soft-skips with the response message", async () => {
		const bad = {
			role: "assistant",
			content: [],
			usage: USAGE,
			stopReason: "error",
			errorMessage: "Branch summarization failed: 400",
			timestamp: 0,
		} as unknown as AssistantMessage;
		const session = makeSession(modelWith(8192, 16384), async () => bad);
		await expect(session.run(eventFor(seedBranch(0)))).resolves.toEqual({ summary: { summary: "" } });
		expect(session.notices[0].message).toContain("Branch summarization failed: 400");
	});

	it("a tool call in the response soft-skips", async () => {
		const tooly = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
			usage: USAGE,
			stopReason: "stop",
			timestamp: 0,
		} as unknown as AssistantMessage;
		const session = makeSession(modelWith(8192, 16384), async () => tooly);
		await expect(session.run(eventFor(seedBranch(0)))).resolves.toEqual({ summary: { summary: "" } });
		expect(session.notices[0].message).toContain("called a tool");
	});

	it("a user abort cancels the navigation, even mid-request", async () => {
		const controller = new AbortController();
		const session = makeSession(modelWith(8192, 16384), async (call) => {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => resolve(), 50);
				call.signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
			throw new Error("should not reach");
		});
		const promise = session.run(eventFor(seedBranch(0), {}, controller));
		controller.abort();
		await expect(promise).resolves.toEqual({ cancel: true });
		expect(session.notices).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Settings and unexpected failures
// ---------------------------------------------------------------------------

describe("settings and unexpected failures", () => {
	it("a malformed value is reported and the default is used", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => assistant("## Goal\nok"), {
			safeBranchSummary: { inflationFactor: "two" },
		});
		const result = (await session.run(eventFor(seedBranch(0)))) as { summary: { summary: string } };
		expect(session.notices).toHaveLength(1);
		expect(session.notices[0].type).toBe("error");
		expect(session.notices[0].message).toContain("inflationFactor");
		// Navigation still summarized, on the default factor.
		expect(result.summary.summary).toContain("## Goal");
	});

	it("an unexpected error soft-skips instead of throwing", async () => {
		const session = makeSession(modelWith(8192, 16384), async () => assistant("## Goal\nok"));
		// A model getter that throws breaks the handler before any of its
		// own checks; the catch-all must turn it into a soft-skip, never a
		// throw (a throw would hand the request back to the built-in).
		const broken = {
			get contextWindow() {
				throw new Error("context invalidated");
			},
		} as unknown as Model<Api>;
		await expect(session.run(eventFor(seedBranch(0)), broken)).resolves.toEqual({ summary: { summary: "" } });
		expect(session.notices[0].message).toContain("context invalidated");
	});
});
