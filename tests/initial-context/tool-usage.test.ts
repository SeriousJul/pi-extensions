/**
 * Tests for the tool usage scan: counting tool calls per tool across a
 * session tree, fork dedupe, the mcp subtool split, the windows, and the
 * per-file mtime+size cache.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createToolUsageSource,
	skillKeysFor,
	toolCallKey,
	parseToolUsageWindow,
	usesForLabel,
	windowStart,
} from "../../extensions/initial-context/tool-usage.ts";
import { listSessionFiles } from "../../extensions/shared/sessions.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-15T00:00:00Z");
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

let tmp: string = "";
afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = "";
});

function makeTree(): string {
	tmp = mkdtempSync(join(tmpdir(), "tool-usage-"));
	const root = join(tmp, "sessions");
	const proj = join(root, "proj");
	mkdirSync(proj, { recursive: true });
	const call = (name: string, args?: unknown): object => ({ type: "toolCall", id: "x", name, arguments: args ?? {} });
	const msg = (id: string, ts: string, calls: object[]): string =>
		JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: ts,
			message: { role: "assistant", content: calls },
		});

	// a.jsonl: three bash (recent), one mcp subtool (recent), one mcp meta op
	// (40 days ago), one read (50 days ago), a skill load (recent), and a
	// skill load via bash (50 days ago).
	const a = [
		msg("a1", iso(1), [call("bash"), call("bash"), call("bash")]),
		msg("a2", iso(2), [call("mcp", { tool: "list_windows", args: "{}" })]),
		msg("a3", iso(40), [call("mcp", { connect: "computer-use-linux" })]),
		msg("a4", iso(50), [call("read")]),
		msg("a5", iso(1), [call("read", { path: "/home/u/.pi/agent/skills/domain-modeling/SKILL.md" })]),
		msg("a6", iso(50), [call("bash", { command: "cat /home/u/.pi/agent/skills/grilling/SKILL.md" })]),
		"this is not json but mentions \"toolCall\" in text",
	].join("\n");
	writeFileSync(join(proj, "a.jsonl"), a);

	// The fork copies a's lines byte-identical and adds one own bash call.
	const fork = a + "\n" + msg("f1", iso(1), [call("bash")]);
	writeFileSync(join(proj, "a-fork.jsonl"), fork);

	// A quiet session from 120 days ago.
	writeFileSync(join(proj, "old.jsonl"), msg("o1", iso(120), [call("bash")]) + "\n");

	// Non-session files are ignored.
	writeFileSync(join(proj, "notes.txt"), "toolCall noise");
	writeFileSync(join(root, "stray.jsonl"), msg("s1", iso(1), [call("bash")]) + "\n");
	return root;
}

function makeSource(root: string, cacheFile: string): ReturnType<typeof createToolUsageSource> {
	return createToolUsageSource({ sessionsRoot: root, cacheFile, now: () => NOW });
}

describe("toolCallKey", () => {
	it("splits mcp calls by subtool and keeps the meta ops on mcp", () => {
		expect(toolCallKey("mcp", { tool: "list_windows", args: "{}" })).toBe("mcp:list_windows");
		expect(toolCallKey("mcp", { connect: "server" })).toBe("mcp");
		expect(toolCallKey("mcp", undefined)).toBe("mcp");
		expect(toolCallKey("bash", {})).toBe("bash");
	});
});

describe("parseToolUsageWindow", () => {
	it("accepts 30d, 90d, and all only", () => {
		expect(parseToolUsageWindow("30d")).toBe("30d");
		expect(parseToolUsageWindow("90d")).toBe("90d");
		expect(parseToolUsageWindow("all")).toBe("all");
		expect(parseToolUsageWindow("7d")).toBeUndefined();
		expect(parseToolUsageWindow(undefined)).toBeUndefined();
	});
});

describe("windowStart", () => {
	it("computes the window start, and all has none", () => {
		expect(windowStart("30d", NOW)).toBe(NOW - 30 * DAY);
		expect(windowStart("90d", NOW)).toBe(NOW - 90 * DAY);
		expect(windowStart("all", NOW)).toBeUndefined();
	});
});

describe("usesForLabel", () => {
	it("counts tool rows, folds mcp subtools in, counts skill loads, skips sections", () => {
		const counts = { mcp: 1, "mcp:list_windows": 8, bash: 3, "skill:grilling": 2 };
		expect(usesForLabel("mcp", "tool", counts)).toBe(9);
		expect(usesForLabel("bash", "tool", counts)).toBe(3);
		expect(usesForLabel("edit", "tool", counts)).toBe(0);
		expect(usesForLabel("grilling", "skill", counts)).toBe(2);
		expect(usesForLabel("prototype", "skill", counts)).toBe(0);
		expect(usesForLabel("base prompt", "base", counts)).toBeUndefined();
		expect(usesForLabel("bash", "tool", undefined)).toBeUndefined();
	});
});

describe("skillKeysFor", () => {
	it("extracts the skill name from a SKILL.md reference in the arguments", () => {
		expect(skillKeysFor({ path: "/home/u/.pi/agent/skills/domain-modeling/SKILL.md" })).toEqual(["skill:domain-modeling"]);
		expect(skillKeysFor({ command: "cat /a/skills/grilling/SKILL.md && cat /a/skills/grilling/SKILL.md" })).toEqual(["skill:grilling"]);
		expect(skillKeysFor({ path: "/tmp/notes.txt" })).toEqual([]);
		expect(skillKeysFor(undefined)).toEqual([]);
	});
});

describe("listSessionFiles", () => {
	it("lists only the jsonl files inside the subdirectories", () => {
		const root = makeTree();
		const files = listSessionFiles(root).map((f) => f.file).sort();
		expect(files).toEqual([join(root, "proj", "a-fork.jsonl"), join(root, "proj", "a.jsonl"), join(root, "proj", "old.jsonl")].sort());
		expect(listSessionFiles(join(tmp, "missing"))).toEqual([]);
	});
});

describe("createToolUsageSource", () => {
	it("counts tool calls per window and never double-counts a fork", async () => {
		const root = makeTree();
		const cacheFile = join(tmp, "cache.json");
		const source = makeSource(root, cacheFile);

		const all = await source.counts();
		expect(all.window).toBe("30d");
		// 30d: the three bash plus the fork's own bash, the mcp subtool, the
		// recent read, and the recent skill load.
		expect(all.counts).toEqual({
			bash: 4,
			"mcp:list_windows": 1,
			read: 1,
			"skill:domain-modeling": 1,
		});

		source.setWindow("90d");
		const w90 = await source.counts();
		expect(w90.window).toBe("90d");
		// 90d adds the 40-day mcp meta op, the 50-day read, and the 50-day
		// skill load via bash (the bash call counts for both keys).
		expect(w90.counts).toEqual({
			bash: 5,
			"mcp:list_windows": 1,
			mcp: 1,
			read: 2,
			"skill:domain-modeling": 1,
			"skill:grilling": 1,
		});

		source.setWindow("all");
		const wAll = await source.counts();
		// all adds the 120-day bash. The fork's copied lines count once.
		expect(wAll.counts).toEqual({
			bash: 6,
			"mcp:list_windows": 1,
			mcp: 1,
			read: 2,
			"skill:domain-modeling": 1,
			"skill:grilling": 1,
		});
	});

	it("serves unchanged files from the cache and re-scans a changed file", async () => {
		const root = makeTree();
		const cacheFile = join(tmp, "cache.json");
		const first = makeSource(root, cacheFile);
		const cold = await first.counts();
		expect(cold.files).toBe(3);
		expect(cold.scanned).toBe(3);

		// A second source (a new process) with the same cache file.
		const warm = makeSource(root, cacheFile);
		const warmCounts = await warm.counts();
		expect(warmCounts.scanned).toBe(0);
		expect(warmCounts.counts).toEqual(cold.counts);

		// Append one call to a.jsonl and bump its mtime; only it re-scans.
		const file = join(root, "proj", "a.jsonl");
		appendFileSync(file, "\n" + JSON.stringify({
			type: "message",
			id: "a5",
			parentId: null,
			timestamp: iso(1),
			message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "edit", arguments: {} }] },
		}));
		utimesSync(file, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

		const next = makeSource(root, cacheFile);
		const rescan = await next.counts();
		expect(rescan.scanned).toBe(1);
		// The appended call is in; the copied fork history is not counted twice.
		expect(rescan.counts).toEqual({
			bash: 4,
			"mcp:list_windows": 1,
			read: 1,
			"skill:domain-modeling": 1,
			edit: 1,
		});
	});

	it("survives a torn cache file and drops files that leave the tree", async () => {
		const root = makeTree();
		const cacheFile = join(tmp, "cache.json");
		const first = makeSource(root, cacheFile);
		await first.counts();

		// A torn cache file is replaced by a fresh scan, no throw.
		writeFileSync(cacheFile, '{"v":1,"files":{"stray":"nope');
		const fresh = makeSource(root, cacheFile);
		const counts = await fresh.counts();
		expect(counts.scanned).toBe(3);
		expect(counts.counts).toEqual({
			bash: 4,
			"mcp:list_windows": 1,
			read: 1,
			"skill:domain-modeling": 1,
		});

		// A deleted file drops out of the counts and the cache.
		const { rmSync: rm } = await import("node:fs");
		rm(join(root, "proj", "old.jsonl"));
		const after = makeSource(root, cacheFile);
		const next = await after.counts();
		expect(next.files).toBe(2);
		expect(next.counts).toEqual({
			bash: 4,
			"mcp:list_windows": 1,
			read: 1,
			"skill:domain-modeling": 1,
		});
	});

	it("notifies subscribers when the scan settles and when the window changes", async () => {
		const root = makeTree();
		const source = makeSource(root, join(tmp, "cache.json"));
		const events: string[] = [];
		source.subscribe(() => events.push(source.snapshot().phase + ":" + source.window));
		const pending = source.counts();
		expect(source.snapshot().phase).toBe("scanning");
		await pending;
		expect(source.snapshot().phase).toBe("ready");
		source.setWindow("90d");
		expect(events.some((e) => e.startsWith("ready:"))).toBe(true);
		expect(events.at(-1)).toBe("ready:90d");
	});
});
