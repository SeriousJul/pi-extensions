import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	aggregateEditResults,
	classifyEditFailure,
	defaultSessionsRoot,
	extractEditResult,
	filterWindow,
	listSessionFiles,
	parseLastWindow,
	scanSessions,
} from "../../scripts/edit-health.mjs";

const DAY = 86_400_000;

/** Build one session record line for the given shape of edit result. */
function editLine(opts: {
	isError?: boolean;
	text: string;
	tsMs?: number;
	recordTs?: string;
}) {
	const message: Record<string, unknown> = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "edit",
		content: [{ type: "text", text: opts.text }],
		isError: opts.isError === true,
	};
	if (opts.tsMs !== undefined) message.timestamp = opts.tsMs;
	const record: Record<string, unknown> = {
		type: "message",
		id: "r1",
		parentId: null,
		message,
	};
	if (opts.tsMs === undefined) record.timestamp = opts.recordTs;
	return JSON.stringify(record);
}

function successLine() {
	return editLine({
		isError: false,
		text: "Successfully replaced 1 block(s) in /tmp/x.ts.",
	});
}

const NO_MATCH =
	"Could not find edits[0] in /tmp/x.ts. The oldText must match exactly including all whitespace and newlines.";
const AMBIGUOUS =
	"Found 2 occurrences of edits[0] in /tmp/x.ts. Each oldText must be unique. Please provide more context to make it unique.";
const VALIDATION_SCHEMA =
	'Validation failed for tool "edit":\n  - edits.0.oldText: must have required properties oldText';
const VALIDATION_INPUT =
	"Edit tool input is invalid. edits must contain at least one replacement.";
const VALIDATION_OVERLAP =
	"edits[0] and edits[1] overlap in /tmp/x.ts. Merge them into one edit or target disjoint regions.";
const OTHER_ENOENT = "Could not edit file: /tmp/gone.ts. Error code: ENOENT.";
const OTHER_NOOP =
	"No changes made to /tmp/x.ts. The replacement produced identical content. This might indicate an issue with the edit.";
const OTHER_TRUNCATED =
	'Tool call "edit" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';

describe("classifyEditFailure", () => {
	it("classifies no-match messages", () => {
		expect(classifyEditFailure(NO_MATCH)).toBe("no-match");
		expect(
			classifyEditFailure(
				"Could not find the exact text in /tmp/x.ts. The old text must match exactly including all whitespace and newlines.",
			),
		).toBe("no-match");
	});

	it("classifies ambiguous messages", () => {
		expect(classifyEditFailure(AMBIGUOUS)).toBe("ambiguous");
		expect(
			classifyEditFailure("Found 7 occurrences of the text in /tmp/x.ts. The text must be unique."),
		).toBe("ambiguous");
	});

	it("classifies validation messages", () => {
		expect(classifyEditFailure(VALIDATION_SCHEMA)).toBe("validation");
		expect(classifyEditFailure(VALIDATION_INPUT)).toBe("validation");
		expect(classifyEditFailure(VALIDATION_OVERLAP)).toBe("validation");
	});

	it("classifies everything else as other", () => {
		expect(classifyEditFailure(OTHER_ENOENT)).toBe("other");
		expect(classifyEditFailure(OTHER_NOOP)).toBe("other");
		expect(classifyEditFailure(OTHER_TRUNCATED)).toBe("other");
		expect(classifyEditFailure("unexpected message")).toBe("other");
	});
});

describe("extractEditResult", () => {
	it("keeps edit tool results with their error flag and text", () => {
		const r = extractEditResult(JSON.parse(editLine({ isError: true, text: NO_MATCH, tsMs: 1000 })));
		expect(r).toEqual({ tsMs: 1000, isError: true, text: NO_MATCH });
	});

	it("drops records that are not edit tool results", () => {
		expect(extractEditResult({ type: "session", version: 3 })).toBeUndefined();
		expect(
			extractEditResult(JSON.parse(editLine({ isError: true, text: NO_MATCH }).replace('"edit"', '"bash"'))),
		).toBeUndefined();
	});

	it("falls back to the record ISO timestamp", () => {
		const ts = "2026-08-01T12:00:00.000Z";
		const r = extractEditResult(JSON.parse(editLine({ isError: false, text: "ok", recordTs: ts })));
		expect(r?.tsMs).toBe(Date.parse(ts));
	});

	it("yields no timestamp when neither field parses", () => {
		const r = extractEditResult(JSON.parse(editLine({ isError: false, text: "ok" })));
		expect(r?.tsMs).toBeUndefined();
	});
});

describe("aggregateEditResults and filterWindow", () => {
	it("counts calls, failures, and per-class totals", () => {
		const stats = aggregateEditResults([
			{ tsMs: 1, isError: false, text: "ok" },
			{ tsMs: 2, isError: true, text: NO_MATCH },
			{ tsMs: 3, isError: true, text: AMBIGUOUS },
			{ tsMs: 4, isError: true, text: VALIDATION_SCHEMA },
			{ tsMs: 5, isError: true, text: OTHER_ENOENT },
			undefined,
		]);
		expect(stats.total).toBe(5);
		expect(stats.failures.total).toBe(4);
		expect(stats.failures.byClass).toEqual({
			"no-match": 1,
			ambiguous: 1,
			validation: 1,
			other: 1,
		});
	});

	it("reports zero calls for an empty stream", () => {
		expect(aggregateEditResults([])).toEqual({
			total: 0,
			failures: { total: 0, byClass: { "no-match": 0, ambiguous: 0, validation: 0, other: 0 } },
		});
	});

	it("keeps only dated calls inside the window", () => {
		const results = [
			{ tsMs: 100, isError: true, text: NO_MATCH },
			{ tsMs: 200, isError: false, text: "ok" },
			{ tsMs: undefined, isError: true, text: AMBIGUOUS },
			{ tsMs: 300, isError: true, text: VALIDATION_OVERLAP },
		];
		expect(filterWindow(results, 150, 250)).toEqual([{ tsMs: 200, isError: false, text: "ok" }]);
	});
});

describe("parseLastWindow", () => {
	it("parses days and weeks", () => {
		expect(parseLastWindow("7d")).toBe(7 * DAY);
		expect(parseLastWindow("2w")).toBe(14 * DAY);
	});

	it("rejects anything else", () => {
		expect(parseLastWindow("all")).toBeUndefined();
		expect(parseLastWindow("7x")).toBeUndefined();
		expect(parseLastWindow("")).toBeUndefined();
	});
});

describe("session tree scan", () => {
	const dirs: string[] = [];
	const cleaned: string[] = [];
	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "edit-health-"));
		dirs.push(root);
		cleaned.push(root);
		return root;
	}
	afterAll(() => {
		for (const dir of cleaned) rmSync(dir, { recursive: true, force: true });
	});

	function fixtureRoot(): string {
		const root = tempRoot();
		mkdirSync(join(root, "wdir-a"));
		const now = Date.now();
		const lines = [
			JSON.stringify({ type: "session", version: 3, cwd: "/wdir/a" }),
			successLine(),
			editLine({ isError: true, text: NO_MATCH, tsMs: now - 3_600_000 }),
			editLine({ isError: true, text: AMBIGUOUS, tsMs: now - 3_600_000 }),
			editLine({ isError: true, text: VALIDATION_SCHEMA, tsMs: now - 3_600_000 }),
			editLine({ isError: true, text: OTHER_ENOENT, tsMs: now - 3_600_000 }),
			// A failed bash result must not count as an edit call.
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "bash",
					content: [{ type: "text", text: "boom" }],
					isError: true,
				},
			}),
			// A half-written line must be skipped, not fatal.
			'{"type":"message","message":{"role":"toolResult","toolName":"edi',
		];
		writeFileSync(join(root, "wdir-a", "s1.jsonl"), lines.join("\n") + "\n");
		mkdirSync(join(root, "wdir-b"));
		writeFileSync(
			join(root, "wdir-b", "s2.jsonl"),
			editLine({ isError: true, text: NO_MATCH, tsMs: now - 30 * DAY }) + "\n",
		);
		// Non-jsonl and non-directory entries are ignored.
		writeFileSync(join(root, "wdir-b", "notes.txt"), "not a session");
		writeFileSync(join(root, "stray.jsonl"), "not in a subdirectory");
		return root;
	}

	it("lists only *.jsonl files inside subdirectories", () => {
		const root = fixtureRoot();
		const files = listSessionFiles(root).map((f: string) => f.split("/").slice(-2).join("/"));
		expect(files.sort()).toEqual(["wdir-a/s1.jsonl", "wdir-b/s2.jsonl"]);
		expect(listSessionFiles(join(root, "nope"))).toEqual([]);
	});

	it("counts every edit call and classifies every failure", () => {
		const root = fixtureRoot();
		const stats = aggregateEditResults(scanSessions(root));
		// s1: 1 success + 4 failures; s2: 1 failure.
		expect(stats.total).toBe(6);
		expect(stats.failures.total).toBe(5);
		expect(stats.failures.byClass).toEqual({
			"no-match": 2,
			ambiguous: 1,
			validation: 1,
			other: 1,
		});
	});

	it("windows exclude undated and out-of-window calls", () => {
		const root = fixtureRoot();
		const now = Date.now();
		const week = aggregateEditResults(filterWindow(scanSessions(root), now - 7 * DAY, now));
		// The undated success and the 30-day-old failure both drop out.
		expect(week.total).toBe(4);
		expect(week.failures.total).toBe(4);
		const all = aggregateEditResults(scanSessions(root));
		expect(all.total).toBe(6);
		expect(all.failures.total).toBe(5);
	});

	it("defaultSessionsRoot honors PI_SESSIONS_DIR", () => {
		expect(defaultSessionsRoot({ PI_SESSIONS_DIR: "/tmp/x" })).toBe("/tmp/x");
		expect(defaultSessionsRoot({})).toBe(join(homedir(), ".pi", "agent", "sessions"));
	});
});

describe("CLI", () => {
	const dirs: string[] = [];
	function fixtureRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "edit-health-cli-"));
		dirs.push(root);
		mkdirSync(join(root, "wd"));
		const now = Date.now();
		const lines = [
			successLine(),
			editLine({ isError: true, text: NO_MATCH, tsMs: now - 3_600_000 }),
			editLine({ isError: true, text: AMBIGUOUS, tsMs: now - 3_600_000 }),
			editLine({ isError: true, text: VALIDATION_OVERLAP, tsMs: now - 3_600_000 }),
		];
		writeFileSync(join(root, "wd", "s1.jsonl"), lines.join("\n") + "\n");
		return root;
	}
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	const scriptPath = join(import.meta.dirname, "..", "..", "scripts", "edit-health.mjs");

	function run(args: string[]) {
		return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
	}

	it("reports a fixture tree", () => {
		const res = run([fixtureRoot()]);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("calls:    4");
		expect(res.stdout).toContain("failures: 3 (75.00%)");
		expect(res.stdout).toContain("no-match        1 (33.33% of failures)");
		expect(res.stdout).toContain("ambiguous       1 (33.33% of failures)");
		expect(res.stdout).toContain("validation      1 (33.33% of failures)");
	});

	it("adds a window block for --last", () => {
		const res = run([fixtureRoot(), "--last", "7d"]);
		expect(res.status).toBe(0);
		const idxAll = res.stdout.indexOf("all time");
		const idxWin = res.stdout.indexOf("last 7d");
		expect(idxAll).toBeGreaterThan(-1);
		expect(idxWin).toBeGreaterThan(idxAll);
	});

	it("handles an empty or missing tree as zero calls, not an error", () => {
		const empty = mkdtempSync(join(tmpdir(), "edit-health-empty-"));
		dirs.push(empty);
		const res = run([join(empty, "absent")]);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("(no edit calls)");
	});

	it("rejects bad option values with exit code 2", () => {
		expect(run(["--last", "all"]).status).toBe(2);
		expect(run(["--since", "yesterday"]).status).toBe(2);
		expect(run(["--nope"]).status).toBe(2);
		expect(run([fixtureRoot(), fixtureRoot()]).status).toBe(2);
	});

	it("prints usage for --help", () => {
		const res = run(["--help"]);
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("Usage: node scripts/edit-health.mjs");
	});
});
