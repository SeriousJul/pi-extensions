import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	aggregateLspRecords,
	correlateFollowUps,
	defaultStateRoot,
	filterWindow,
	listProjectDirs,
	listStderrLogs,
	parseLastWindow,
	parseLspLogLine,
	piSessionDirName,
	scanEditEvents,
	scanStateDir,
} from "../../scripts/lsp-health.mjs";
import { appendLspLog } from "../../extensions/lsp/usage.ts";

const DAY = 86_400_000;
const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One usage.jsonl line for the given record shape. */
function callLine(opts: {
	tool?: string;
	outcome?: string;
	language?: string;
	server?: string;
	chars?: number;
	duration_ms?: number;
	tsMs?: number;
	root?: string;
} = {}) {
	const tsMs = opts.tsMs ?? Date.now();
	return JSON.stringify({
		ts: new Date(tsMs).toISOString(),
		kind: "call",
		tool: opts.tool ?? "lsp_diagnostics",
		outcome: opts.outcome ?? "ok",
		language: opts.language ?? "typescript",
		server: opts.server ?? "typescript-language-server",
		root: opts.root ?? "/tmp/proj",
		duration_ms: opts.duration_ms,
		chars: opts.chars ?? 0,
	});
}

function annotationLine(opts: { outcome?: string; files?: string[]; new_count?: number; has_error?: boolean; tsMs?: number } = {}) {
	const tsMs = opts.tsMs ?? Date.now();
	return JSON.stringify({
		ts: new Date(tsMs).toISOString(),
		kind: "annotation",
		trigger: "edit",
		language: "typescript",
		server: "typescript-language-server",
		root: "/tmp/proj",
		outcome: opts.outcome ?? "reported",
		files: opts.files ?? ["app.ts"],
		new_count: opts.new_count ?? 2,
		has_error: opts.has_error ?? true,
	});
}

function sweepLine(opts: { outcome?: string; new_count?: number; tsMs?: number } = {}) {
	const tsMs = opts.tsMs ?? Date.now();
	return JSON.stringify({
		ts: new Date(tsMs).toISOString(),
		kind: "sweep",
		language: "typescript",
		root: "/tmp/proj",
		outcome: opts.outcome ?? "quiet",
		new_count: opts.new_count ?? 0,
	});
}

/** A state directory with one project log holding the given lines. */
function stateDirWith(lines: string[]): string {
	const agent = mkdtempSync(join(tmpdir(), "lsp-health-"));
	cleanups.push(() => rmSync(agent, { recursive: true, force: true }));
	const state = join(agent, "lsp");
	const project = join(state, "--tmp-proj");
	mkdirSync(project, { recursive: true });
	for (const line of lines) appendFileSync(join(project, "usage.jsonl"), `${line}\n`, "utf8");
	return state;
}

describe("parseLspLogLine", () => {
	it("parses a well-formed call record", () => {
		const line = callLine({ tool: "lsp_hover", outcome: "timeout", tsMs: 1_700_000_000_000 });
		const record = parseLspLogLine(line);
		expect(record).not.toBeNull();
		expect(record?.kind).toBe("call");
		expect(record?.tool).toBe("lsp_hover");
		expect(record?.root).toBe("/tmp/proj");
	});

	it("accepts annotation and sweep records", () => {
		expect(parseLspLogLine(annotationLine())?.kind).toBe("annotation");
		expect(parseLspLogLine(sweepLine())?.kind).toBe("sweep");
	});

	it("rejects blank and malformed lines", () => {
		expect(parseLspLogLine("")).toBeNull();
		expect(parseLspLogLine("   ")).toBeNull();
		expect(parseLspLogLine("{not json")).toBeNull();
		expect(parseLspLogLine("42")).toBeNull();
	});

	it("rejects records missing the identity fields or with an unknown kind", () => {
		const noTs = JSON.stringify({ kind: "call", root: "/tmp/proj" });
		const noRoot = JSON.stringify({ ts: new Date().toISOString(), kind: "call" });
		const badKind = JSON.stringify({ ts: new Date().toISOString(), kind: "metrics", root: "/tmp/proj" });
		expect(parseLspLogLine(noTs)).toBeNull();
		expect(parseLspLogLine(noRoot)).toBeNull();
		expect(parseLspLogLine(badKind)).toBeNull();
	});
});

describe("listProjectDirs", () => {
	it("lists project directories that hold a usage.jsonl", () => {
		const state = stateDirWith([callLine()]);
		const empty = join(state, "--tmp-empty");
		mkdirSync(empty, { recursive: true });
		const dirs = listProjectDirs(state);
		expect(dirs.map((d) => d.name)).toEqual(["--tmp-proj"]);
	});

	it("returns nothing for a missing state directory", () => {
		expect(listProjectDirs(join(tmpdir(), "lsp-health-missing"))).toEqual([]);
	});
});

describe("scanStateDir", () => {
	it("collects records from every project, skipping torn lines", () => {
		const state = stateDirWith(
			[callLine({ tool: "lsp_hover", tsMs: Date.now() - DAY }), "torn {line", annotationLine({ outcome: "quiet" }), sweepLine({ outcome: "reported", new_count: 3 })],
		);
		const records = scanStateDir(state);
		expect(records).toHaveLength(3);
		expect(records.map((r) => r.kind)).toEqual(["call", "annotation", "sweep"]);
	});

	it("keeps the timestamp of parseable records and drops it for the rest", () => {
		const goodTs = Date.now() - 2 * DAY;
		const state = stateDirWith([callLine({ tsMs: goodTs }), JSON.stringify({ ts: "not-a-date", kind: "call", root: "/tmp/proj" })]);
		const records = scanStateDir(state);
		expect(records[0].tsMs).toBe(goodTs);
		expect(records[1].tsMs).toBeUndefined();
	});

	it("returns nothing when the state directory is missing", () => {
		expect(scanStateDir(join(tmpdir(), "lsp-health-missing"))).toEqual([]);
	});
});

describe("listStderrLogs", () => {
	it("finds the per-server stderr logs with their sizes", () => {
		const state = stateDirWith([callLine()]);
		const project = join(state, "--tmp-proj");
		writeFileSync(join(project, "server-typescript-language-server.stderr.log"), "warning: something\n", "utf8");
		writeFileSync(join(project, "server-clangd.stderr.log"), "", "utf8");
		writeFileSync(join(project, "notes.txt"), "not a server log", "utf8");
		const logs = listStderrLogs(state);
		expect(logs).toHaveLength(2);
		const byName = new Map(logs.map((l) => [l.server, l]));
		expect(byName.get("typescript-language-server")?.size).toBeGreaterThan(0);
		expect(byName.get("clangd")?.size).toBe(0);
	});
});

describe("aggregateLspRecords", () => {
	it("counts calls by tool and outcome, with the average duration and total chars", () => {
		const records = scanStateDir(
			stateDirWith(
				[
					callLine({ tool: "lsp_diagnostics", outcome: "ok", duration_ms: 100, chars: 50 }),
					callLine({ tool: "lsp_diagnostics", outcome: "timeout", duration_ms: 300, chars: 0 }),
					callLine({ tool: "lsp_hover", outcome: "ok", chars: 25 }),
					callLine({ tool: "lsp_references", outcome: "flaky" }),				],
			),
		);
		const stats = aggregateLspRecords(records, []);
		expect(stats.calls.total).toBe(4);
		expect(stats.calls.byTool).toEqual({ lsp_diagnostics: 2, lsp_hover: 1, lsp_references: 1 });
		expect(stats.calls.byOutcome.ok).toBe(2);
		expect(stats.calls.byOutcome.timeout).toBe(1);
		expect(stats.calls.byOutcome.other).toBe(1);
		// only the two timed records feed the average
		expect(stats.calls.avgDurationMs).toBe(200);
		expect(stats.calls.chars).toBe(75);
	});

	it("splits annotations into reported and quiet, summing the new diagnostics and errors", () => {
		const records = scanStateDir(
			stateDirWith(
				[
					annotationLine({ outcome: "reported", new_count: 2, has_error: true }),
					annotationLine({ outcome: "reported", new_count: 1, has_error: false }),
					annotationLine({ outcome: "quiet" }),
				],
			),
		);
		const stats = aggregateLspRecords(records, []);
		expect(stats.annotations.total).toBe(3);
		expect(stats.annotations.reported).toBe(2);
		expect(stats.annotations.newCount).toBe(3);
		expect(stats.annotations.errors).toBe(1);
	});

	it("counts sweeps and the new diagnostics they reported", () => {
		const records = scanStateDir(stateDirWith([sweepLine({ outcome: "reported", new_count: 2 }), sweepLine(), sweepLine({ outcome: "quiet" })]));
		const stats = aggregateLspRecords(records, []);
		expect(stats.sweeps.total).toBe(3);
		expect(stats.sweeps.reported).toBe(1);
		expect(stats.sweeps.newCount).toBe(2);
	});

	it("splits the activity by project root and counts the stderr logs", () => {
		const state = stateDirWith([callLine({ tool: "lsp_hover" })]);
		const other = join(state, "--tmp-proj-b");
		mkdirSync(other, { recursive: true });
		const line = JSON.stringify({ ts: new Date().toISOString(), kind: "call", tool: "lsp_hover", outcome: "ok", root: "/tmp/proj-b", duration_ms: 50, chars: 10 });
		appendFileSync(join(other, "usage.jsonl"), `${line}\n`, "utf8");
		const project = join(state, "--tmp-proj");
		writeFileSync(join(project, "server-clangd.stderr.log"), "x", "utf8");
		const stats = aggregateLspRecords(scanStateDir(state), listStderrLogs(state));
		expect(stats.projects.total).toBe(2);
		expect(stats.projects.list).toHaveLength(2);
		expect(stats.stderr.total).toBe(1);
		expect(stats.stderr.nonEmpty).toBe(1);
	});
});

describe("filterWindow", () => {
	it("keeps the records inside the window and drops the untimed ones", () => {
		const now = Date.now();
		const records = scanStateDir(
			stateDirWith(
				[
					callLine({ tsMs: now - 1000 }),
					callLine({ tsMs: now - 10 * DAY }),
					JSON.stringify({ ts: "never", kind: "call", root: "/tmp/proj" }),
				],
			),
		);
		const window = filterWindow(records, now - DAY, now);
		expect(window).toHaveLength(1);
		expect(window[0].tsMs).toBe(now - 1000);
	});
});

describe("parseLastWindow", () => {
	it("parses day and week spans", () => {
		expect(parseLastWindow("7d")).toBe(7 * DAY);
		expect(parseLastWindow("2w")).toBe(14 * DAY);
	});
	it("rejects anything else", () => {
		expect(parseLastWindow("d7")).toBeUndefined();
		expect(parseLastWindow("1x")).toBeUndefined();
		expect(parseLastWindow("")).toBeUndefined();
		expect(parseLastWindow(undefined as unknown as string)).toBeUndefined();
	});
});

describe("defaultStateRoot", () => {
	it("prefers PI_CODING_AGENT_DIR and appends the lsp directory", () => {
		expect(defaultStateRoot({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe(join("/tmp", "agent", "lsp"));
	});
});

describe("lsp-health CLI", () => {
	const repoRoot = join(import.meta.dirname, "..", "..");

	it("prints the report for a state directory with activity", () => {
		const state = stateDirWith(
			[
				callLine({ tool: "lsp_diagnostics", outcome: "ok" }),
				callLine({ tool: "lsp_diagnostics", outcome: "timeout" }),
				annotationLine({ outcome: "reported", new_count: 1, has_error: true }),
				sweepLine({ outcome: "quiet" }),
			],
		);
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), state], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("LSP health");
		expect(result.stdout).toContain("calls:       2");
		expect(result.stdout).toContain("annotations: 1 (1 reported, 0 quiet, 1 new diagnostics, 1 with errors)");
		expect(result.stdout).toContain("sweeps:      1 (0 reported, 1 quiet, 0 new diagnostics)");
	});

	it("reports an empty state directory without failing", () => {
		const agent = mkdtempSync(join(tmpdir(), "lsp-health-empty-"));
		const state = join(agent, "lsp");
		mkdirSync(state, { recursive: true });
		cleanups.push(() => rmSync(agent, { recursive: true, force: true }));
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), state], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("no lsp activity");
	});

	it("prints the help and exits 0", () => {
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), "--help"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Usage: node scripts/lsp-health.mjs");
	});

	it("rejects a bad --last and an extra positional with exit 2", () => {
		const badLast = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), "--last", "1x"], { encoding: "utf8" });
		expect(badLast.status).toBe(2);
		const twoRoots = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), "/tmp/a", "/tmp/b"], { encoding: "utf8" });
		expect(twoRoots.status).toBe(2);
	});
});

describe("the follow-up metric", () => {
	/** One assistant message with a single edit or write tool call. */
	function editCallLine(name: "edit" | "write", path: string, tsMs: number) {
		return JSON.stringify({
			type: "message",
			id: "r",
			message: {
				role: "assistant",
				timestamp: tsMs,
				content: [{ type: "toolCall", id: "t", name, arguments: { path } }],
			},
		});
	}

	/** A sessions tree whose directory for `root` holds the given lines. */
	function sessionsRootWith(root: string, lines: string[]): string {
		const sessions = mkdtempSync(join(tmpdir(), "lsp-sessions-"));
		cleanups.push(() => rmSync(sessions, { recursive: true, force: true }));
		const dir = join(sessions, piSessionDirName(root));
		mkdirSync(dir, { recursive: true });
		lines.forEach((line, i) => appendFileSync(join(dir, `s${i}.jsonl`), `${line}\n`, "utf8"));
		return sessions;
	}

	it("names the session directory the way pi does", () => {
		expect(piSessionDirName("/home/me/proj")).toBe("--home-me-proj--");
		expect(piSessionDirName("/tmp/x")).toBe("--tmp-x--");
	});

	it("extracts the edit and write calls from the session files", () => {
		const t0 = 1_700_000_000_000;
		const sessions = sessionsRootWith(
			"/tmp/proj",
			[
				editCallLine("edit", "app.ts", t0 + 1000),
				editCallLine("write", "util.ts", t0 + 2000),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", timestamp: t0 + 3000, content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "x.ts" } }] },
				}),
				"torn {line",
			],
		);
		const events = scanEditEvents(sessions, "/tmp/proj");
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ path: "app.ts", tool: "edit", tsMs: t0 + 1000 });
		expect(events[1]).toEqual({ path: "util.ts", tool: "write", tsMs: t0 + 2000 });
	});

	it("counts an acted-on annotation: a re-edit of a named file within the window", () => {
		const t0 = 1_700_000_000_000;
		const state = stateDirWith([annotationLine({ outcome: "reported", new_count: 1, has_error: true, files: ["app.ts"], tsMs: t0 })]);
		const sessions = sessionsRootWith("/tmp/proj", [editCallLine("edit", "other.ts", t0 + 1000), editCallLine("edit", "app.ts", t0 + 2000)]);
		const followUps = correlateFollowUps(scanStateDir(state), sessions);
		expect(followUps).toEqual({ total: 1, acted: 1, unacted: 0, untimed: 0, noSessions: 0 });
	});

	it("the window is the next five calls: a sixth does not count", () => {
		const t0 = 1_700_000_000_000;
		const state = stateDirWith([annotationLine({ outcome: "reported", files: ["app.ts"], tsMs: t0 })]);
		const calls = [1, 2, 3, 4, 5].map((n) => editCallLine("edit", `other${n}.ts`, t0 + n * 1000));
		calls.push(editCallLine("edit", "app.ts", t0 + 6000));
		const followUps = correlateFollowUps(scanStateDir(state), sessionsRootWith("/tmp/proj", calls));
		expect(followUps.acted).toBe(0);
		expect(followUps.unacted).toBe(1);
	});

	it("matches a relative log file against an absolute session path, and ignores quiet and warning-only records", () => {
		const t0 = 1_700_000_000_000;
		const state = stateDirWith([
			annotationLine({ outcome: "reported", new_count: 1, has_error: true, files: ["app.ts"], tsMs: t0 }),
			annotationLine({ outcome: "quiet", files: ["app.ts"], tsMs: t0 }),
			annotationLine({ outcome: "reported", new_count: 1, has_error: false, files: ["app.ts"], tsMs: t0 }),
		]);
		const sessions = sessionsRootWith("/tmp/proj", [editCallLine("write", "/tmp/proj/app.ts", t0 + 1000)]);
		const followUps = correlateFollowUps(scanStateDir(state), sessions);
		expect(followUps.total).toBe(1);
		expect(followUps.acted).toBe(1);
	});

	it("counts the unjudgeable separately: untimed records and roots without session files", () => {
		const t0 = 1_700_000_000_000;
		const untimed = JSON.stringify({ ts: "never", kind: "annotation", root: "/tmp/proj", outcome: "reported", files: ["app.ts"], new_count: 1, has_error: true });
		const elsewhere = JSON.stringify({ ts: new Date(t0).toISOString(), kind: "sweep", root: "/tmp/elsewhere", outcome: "reported", files: ["x.ts"], new_count: 1, has_error: true });
		const state = stateDirWith([untimed, elsewhere]);
		const sessions = sessionsRootWith("/tmp/proj", [editCallLine("edit", "app.ts", t0 + 1000)]);
		const followUps = correlateFollowUps(scanStateDir(state), sessions);
		expect(followUps.total).toBe(0);
		expect(followUps.untimed).toBe(1);
		expect(followUps.noSessions).toBe(1);
	});

	it("the CLI reports the follow-ups with a --sessions tree", () => {
		const t0 = 1_700_000_000_000;
		const state = stateDirWith([annotationLine({ outcome: "reported", new_count: 1, has_error: true, files: ["app.ts"], tsMs: t0 })]);
		const sessions = sessionsRootWith("/tmp/proj", [editCallLine("edit", "app.ts", t0 + 1000)]);
		const repoRoot = join(import.meta.dirname, "..", "..");
		const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "lsp-health.mjs"), state, "--sessions", sessions], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(`follow-ups:  1 of 1 error annotations acted on (re-edit within 5 calls)`);
	});
});

describe("the script reads what the extension writes", () => {
	it("a record appended by the extension parses and aggregates", () => {
		const agent = mkdtempSync(join(tmpdir(), "lsp-health-wire-"));
		cleanups.push(() => rmSync(agent, { recursive: true, force: true }));
		appendLspLog("/tmp/proj", { kind: "call", tool: "lsp_hover", language: "typescript", server: "typescript-language-server", outcome: "ok", duration_ms: 42, chars: 80 }, { ...process.env, PI_CODING_AGENT_DIR: agent });
		appendLspLog("/tmp/proj", { kind: "sweep", language: "typescript", outcome: "reported", files: ["util.ts"], new_count: 1 }, { ...process.env, PI_CODING_AGENT_DIR: agent });
		const state = join(agent, "lsp");
		expect(readdirSync(state).length).toBe(1);
		const records = scanStateDir(state);
		expect(records).toHaveLength(2);
		const stats = aggregateLspRecords(records, []);
		expect(stats.calls.total).toBe(1);
		expect(stats.calls.byTool.lsp_hover).toBe(1);
		expect(stats.calls.avgDurationMs).toBe(42);
		expect(stats.calls.chars).toBe(80);
		expect(stats.sweeps.reported).toBe(1);
		expect(stats.sweeps.newCount).toBe(1);
		const file = join(state, readdirSync(state)[0], "usage.jsonl");
		expect(statSync(file).size).toBeGreaterThan(0);
	});
});
