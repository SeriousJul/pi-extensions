import { describe, expect, it } from "vitest";
import {
	createCompressionCore,
	SPAN_FRAME,
	spanKeyOf,
	type CompressionCore,
	type SpanRecord,
	type Turn,
	type TurnRequest,
} from "../../extensions/compress/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const MODEL = { provider: "anthropic", id: "claude-haiku" };

function usage(total: number) {
	return {
		input: total,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: MODEL.provider,
		model: MODEL.id,
		usage: usage(0),
		stopReason: "stop",
		timestamp: 2000,
	} as AgentMessage;
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3000,
	} as AgentMessage;
}

interface Harness {
	core: CompressionCore;
	/** The message lists the serializer fake received, in order. */
	serialized: AgentMessage[][];
}

function makeHarness(opts?: { perMessageTokens?: number }): Harness {
	const serialized: AgentMessage[][] = [];
	const perMessageTokens = opts?.perMessageTokens ?? 1;
	const core = createCompressionCore({
		// One message is `perMessageTokens` tokens, so token gates are exact.
		estimateTokens: (messages) => messages.length * perMessageTokens,
		serializeTurn: (messages) => {
			serialized.push(messages);
			return `SERIALIZED-${serialized.length}`;
		},
	});
	return { core, serialized };
}

/** One turn of one user message plus `n` assistant/tool-result messages. */
function turn(id: string, n: number): Turn {
	const messages: AgentMessage[] = [user(`user prompt of ${id}`)];
	for (let i = 0; i < n; i += 1) messages.push(i % 2 === 0 ? assistant(`${id} reply ${i}`) : toolResult(`${id} output ${i}`));
	return { entryIds: [`${id}-u`, ...Array.from({ length: n }, (_, i) => `${id}-m${i}`)], messages };
}

function request(...turns: Turn[]): TurnRequest {
	return { preamble: { entryIds: [], messages: [] }, turns };
}

function spanRecord(entryIds: string[], before: number, after: number, text = "COMPRESSED TEXT"): SpanRecord {
	return { v: 1, entryIds, text, model: MODEL, usage: usage(10), tokensBefore: before, tokensAfter: after };
}

const CONFIG = { keepTurns: 1, spanCapTokens: 500, minSpanTokens: 1 };

// ---------------------------------------------------------------------------
// plan: the keep window and the raw fallback
// ---------------------------------------------------------------------------

describe("plan", () => {
	it("passes the request through raw when every finished turn is inside the keep window", () => {
		const { core, serialized } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 2);
		const t2 = turn("c", 1); // in progress
		const plan = core.plan(request(t0, t1, t2), { ...CONFIG, keepTurns: 2 });
		expect(plan.messages).toEqual([...t0.messages, ...t1.messages, ...t2.messages]);
		expect(plan.jobs).toEqual([]);
		expect(plan.spans).toBe(0);
		expect(plan.compressed).toBe(0);
		expect(serialized).toEqual([]);
	});

	it("keeps the last keepTurns finished turns plus the in-progress turn raw", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 2);
		const t2 = turn("c", 2);
		const t3 = turn("d", 1); // in progress
		const plan = core.plan(request(t0, t1, t2, t3), CONFIG);
		// turn 0 and 1 are spans (uncached): they stay raw and yield jobs.
		expect(plan.messages).toEqual([...t0.messages, ...t1.messages, ...t2.messages, ...t3.messages]);
		expect(plan.spans).toBe(2);
		expect(plan.compressed).toBe(0);
		expect(plan.jobs.map((j) => j.spanKey)).toEqual([spanKeyOf(t0.entryIds), spanKeyOf(t1.entryIds)]);
	});

	it("never spans the in-progress turn, even with keepTurns 0", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 1); // in progress
		const plan = core.plan(request(t0, t1), { ...CONFIG, keepTurns: 0 });
		expect(plan.spans).toBe(1);
		expect(plan.jobs).toHaveLength(1);
		expect(plan.jobs[0].entryIds).toEqual(t0.entryIds);
		expect(plan.messages).toEqual([...t0.messages, ...t1.messages]);
	});

	it("sends the preamble raw, before everything else", () => {
		const { core } = makeHarness();
		const preamble: Turn = { entryIds: ["p1"], messages: [user("a compaction summary standing in")] };
		const t0 = turn("a", 2);
		const t1 = turn("b", 2);
		const t2 = turn("c", 1); // in progress
		const req = { preamble, turns: [t0, t1, t2] };
		const plan = core.plan(req, CONFIG);
		expect(plan.messages[0]).toBe(preamble.messages[0]);
		expect(plan.spans).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// plan: compression jobs
// ---------------------------------------------------------------------------

describe("plan jobs", () => {
	it("emits one job per uncached span, with the serialized input, token count, and cap", () => {
		const { core, serialized } = makeHarness({ perMessageTokens: 7 });
		const t0 = turn("a", 2); // 3 messages = 21 tokens
		const t1 = turn("b", 1);
		const t2 = turn("c", 1); // in progress
		const plan = core.plan(request(t0, t1, t2), CONFIG);
		expect(plan.jobs).toHaveLength(1);
		const job = plan.jobs[0];
		expect(job.spanKey).toBe(spanKeyOf(t0.entryIds));
		expect(job.entryIds).toEqual(t0.entryIds);
		expect(job.input).toBe("SERIALIZED-1");
		expect(job.spanTokens).toBe(21);
		expect(job.capTokens).toBe(500);
		// The serializer saw exactly the span's messages.
		expect(serialized).toEqual([t0.messages]);
	});

	it("does not emit a job for a span smaller than the min span gate", () => {
		const { core, serialized } = makeHarness({ perMessageTokens: 1 });
		const small = turn("a", 1); // 2 messages = 2 tokens
		const t1 = turn("b", 1);
		const t2 = turn("c", 1); // in progress
		const plan = core.plan(request(small, t1, t2), { ...CONFIG, minSpanTokens: 3 });
		expect(plan.jobs).toEqual([]);
		expect(plan.spans).toBe(1); // it is still a span, just below the gate
		expect(plan.messages).toEqual([...small.messages, ...t1.messages, ...t2.messages]);
		expect(serialized).toEqual([]);
	});

	it("emits a job when the span is exactly at the min span gate", () => {
		const { core } = makeHarness({ perMessageTokens: 1 });
		const t0 = turn("a", 1); // 2 messages = 2 tokens
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		const plan = core.plan(request(t0, t1, t2), { ...CONFIG, minSpanTokens: 2 });
		expect(plan.jobs).toHaveLength(1);
	});

	it("skips job emission when emitJobs is false, with the same outgoing messages", () => {
		const { core, serialized } = makeHarness({ perMessageTokens: 7 });
		const t0 = turn("a", 2); // 21 tokens, passes the gate
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		const full = core.plan(request(t0, t1, t2), CONFIG);
		const quiet = core.plan(request(t0, t1, t2), CONFIG, { emitJobs: false });
		expect(full.jobs).toHaveLength(1);
		expect(quiet.jobs).toEqual([]);
		expect(quiet.messages).toEqual(full.messages);
		expect(quiet.spans).toBe(full.spans);
		expect(quiet.compressed).toBe(full.compressed);
		// The span was never serialized for the quiet plan.
		expect(serialized).toEqual([t0.messages]);
	});

	it("does not emit a job for a cached span", () => {
		const { core, serialized } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		core.record(spanRecord(t0.entryIds, 10, 2));
		const plan = core.plan(request(t0, t1, t2), CONFIG);
		expect(plan.jobs).toEqual([]);
		expect(serialized).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// plan: cached spans
// ---------------------------------------------------------------------------

describe("plan with cached spans", () => {
	it("replaces a cached span with one synthetic user message carrying the frame and the form", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 2);
		const t2 = turn("c", 1); // in progress
		core.record(spanRecord(t0.entryIds, 10, 2, "What was asked: fix the build"));
		const plan = core.plan(request(t0, t1, t2), CONFIG);
		const [first, ...rest] = plan.messages;
		expect(first.role).toBe("user");
		const content = (first as UserMessage).content as string;
		expect(content).toBe(`${SPAN_FRAME}\n\nWhat was asked: fix the build`);
		// Order is preserved: the rest is the raw turns, in order.
		expect(rest).toEqual([...t1.messages, ...t2.messages]);
		expect(plan.spans).toBe(1);
		expect(plan.compressed).toBe(1);
		expect(plan.jobs).toEqual([]);
	});

	it("keeps multiple cached spans in their original order", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 1);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		const t3 = turn("d", 1); // in progress
		core.record(spanRecord(t0.entryIds, 9, 1, "FORM-A"));
		core.record(spanRecord(t1.entryIds, 8, 1, "FORM-B"));
		const plan = core.plan(request(t0, t1, t2, t3), { ...CONFIG, keepTurns: 1 });
		const forms = plan.messages.filter((m) => {
			if (m.role !== "user") return false;
			const content = (m as UserMessage).content;
			return typeof content === "string" && content.includes("FORM-");
		});
		expect(forms).toHaveLength(2);
		expect((forms[0] as UserMessage).content).toContain("FORM-A");
		expect((forms[1] as UserMessage).content).toContain("FORM-B");
		expect(plan.messages[0]).toBe(forms[0]);
		expect(plan.messages[1]).toBe(forms[1]);
		// The kept turn and the in-progress turn stay raw, in order.
		expect(plan.messages.slice(2)).toEqual([...t2.messages, ...t3.messages]);
	});

	it("recomputes the plan identically for the same request, so repeated requests are stable", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		core.record(spanRecord(t0.entryIds, 10, 2));
		const first = core.plan(request(t0, t1, t2), CONFIG);
		const second = core.plan(request(t0, t1, t2), CONFIG);
		expect(second.messages).toEqual(first.messages);
	});

	it("treats a span with a different entry list as a different span", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t0Edited = turn("a-edited", 2); // same shape, different entry IDs
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		core.record(spanRecord(t0.entryIds, 10, 2, "FORM"));
		const plan = core.plan(request(t0Edited, t1, t2), CONFIG);
		expect(plan.compressed).toBe(0);
		expect(plan.messages).toEqual([...t0Edited.messages, ...t1.messages, ...t2.messages]);
	});
});

// ---------------------------------------------------------------------------
// record / restore / stats
// ---------------------------------------------------------------------------

describe("record, restore, stats", () => {
	it("records a span and reports it in stats with the tokens saved", () => {
		const { core } = makeHarness();
		expect(core.stats()).toEqual({ spans: 0, tokensSaved: 0 });
		core.record(spanRecord(["e1", "e2"], 3000, 240));
		expect(core.stats()).toEqual({ spans: 1, tokensSaved: 2760 });
		expect(core.isCached(spanKeyOf(["e1", "e2"]))).toBe(true);
	});

	it("reports zero tokens saved when the form is not smaller than the span", () => {
		const { core } = makeHarness();
		core.record(spanRecord(["e1"], 100, 200));
		expect(core.stats()).toEqual({ spans: 1, tokensSaved: 0 });
	});

	it("replaces the form of a re-recorded span", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		core.record(spanRecord(t0.entryIds, 10, 1, "OLD"));
		core.record(spanRecord(t0.entryIds, 10, 1, "NEW"));
		const plan = core.plan(request(t0, t1, t2), CONFIG);
		expect(plan.compressed).toBe(1);
		expect((plan.messages[0] as UserMessage).content).toContain("NEW");
		expect(core.stats().spans).toBe(1);
	});

	it("restores the cache from persisted spans", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 1);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1);
		core.restore([spanRecord(t0.entryIds, 9, 1, "RESTORED")]);
		const plan = core.plan(request(t0, t1, t2), CONFIG);
		expect(plan.compressed).toBe(1);
		expect((plan.messages[0] as UserMessage).content).toContain("RESTORED");
	});

	it("drops a cached span whose entries left the branch (compaction), so the stats stop counting it", () => {
		const { core } = makeHarness();
		const t0 = turn("a", 2);
		const t1 = turn("b", 1);
		const t2 = turn("c", 1); // in progress
		core.record(spanRecord(t0.entryIds, 3000, 240, "FORM"));
		expect(core.stats()).toEqual({ spans: 1, tokensSaved: 2760 });
		// The compaction replaced the old turn: only the summary stands in.
		const preamble: Turn = { entryIds: ["comp1"], messages: [user("compaction summary")] };
		const req = { preamble, turns: [t1, t2] };
		const plan = core.plan(req, CONFIG);
		expect(plan.compressed).toBe(0);
		expect(core.stats()).toEqual({ spans: 0, tokensSaved: 0 });
		expect(core.isCached(spanKeyOf(t0.entryIds))).toBe(false);
		// A span that is still in the branch survives the same plan.
		core.record(spanRecord(t1.entryIds, 10, 2));
		core.plan(req, CONFIG);
		expect(core.isCached(spanKeyOf(t1.entryIds))).toBe(true);
	});
});
