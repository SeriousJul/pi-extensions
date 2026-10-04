/**
 * Tests for the background jobs extension (issue #95).
 *
 * Primary seam: the tools' execute functions, captured from a mock extension
 * API and fired without a live pi, following the established pattern. The
 * spawn and poll logic is exercised with real short-lived shell commands -
 * a fast echo, a slow sleep, a failing exit - because a mocked child
 * process would test the mock, not the shell wrapper.
 *
 * Every harness gets its own throwaway sessions root, so the derived job
 * root (the parent of the session directory, per ADR 0023) is isolated per
 * test and the state directory the tools use is the real one, derived the
 * real way.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import registerBackgroundJobs, { registerTools } from "../../extensions/background-jobs/index";
import { paintBashBgCallLine } from "../../extensions/background-jobs/render";
import { MAX_LISTED_JOBS, formatLiveJobs } from "../../extensions/background-jobs/core.ts";

type ToolDef = Parameters<ExtensionAPI["registerTool"]>[0];

interface ToolResult {
	content: { type: string; text: string }[];
	details: unknown;
}

interface Harness {
	/** The sessions root this harness's tools derive their job root from. */
	sessionsRoot: string;
	call: (tool: string, params: Record<string, unknown>) => Promise<string>;
}

const tmpRoots: string[] = [];

function makeHarness(): Harness {
	const sessionsRoot = mkdtempSync(join(tmpdir(), "bg-jobs-test-"));
	tmpRoots.push(sessionsRoot);
	const projectCwd = join(sessionsRoot, "project");
	mkdirSync(projectCwd, { recursive: true });

	const tools = new Map<string, ToolDef>();
	const pi = { registerTool: (t: ToolDef) => tools.set(t.name, t) } as unknown as ExtensionAPI;
	registerTools(pi);

	const sessionFile = join(sessionsRoot, "project", "session.jsonl");
	const ctx: ExtensionContext = {
		cwd: projectCwd,
		sessionManager: { getSessionFile: () => sessionFile },
	} as unknown as ExtensionContext;

	return {
		sessionsRoot,
		call: async (tool, params) => {
			const t = tools.get(tool);
			if (!t) throw new Error(`no such tool: ${tool}`);
			const result = (await t.execute("1", params, undefined, undefined, ctx)) as ToolResult;
			return result.content.map((c) => c.text).join("\n");
		},
	};
}

/** The job root a harness's tools use: parent of the session directory. */
function jobsRootOf(h: Harness): string {
	return join(h.sessionsRoot, "jobs");
}

function startedJobId(text: string): string {
	const match = text.match(/^job (jb-\S+) started/m);
	if (!match) throw new Error(`no started job in: ${text}`);
	return match[1];
}

/** Wait for a job to reach "exited" without asserting on the output. */
async function settle(h: Harness, jobId: string, timeoutS = 15): Promise<string> {
	return h.call("job_wait", { jobId, timeout: timeoutS });
}

afterAll(() => {
	for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe("bash_bg + job_wait", () => {
	it("start-and-wait returns exit 0 and the expected tail", async () => {
		const h = makeHarness();
		const start = await h.call("bash_bg", { command: "echo line one\necho line two" });
		expect(start).toMatch(/^job jb-\S+ started/m);
		expect(start).toMatch(/^pid: \d+$/m);
		expect(start).toMatch(/^log: .+job\.log$/m);
		const jobId = startedJobId(start);

		const result = await settle(h, jobId);
		expect(result).toContain("exited");
		expect(result).toContain("exit code: 0");
		expect(result).toContain("line one");
		expect(result).toContain("line two");
	});

	it("a wait with a short timeout returns running with partial output, then the second wait returns the exit", async () => {
		const h = makeHarness();
		const start = await h.call("bash_bg", { command: "for i in 1 2 3; do echo step $i; sleep 1; done" });
		const jobId = startedJobId(start);

		const partial = await h.call("job_wait", { jobId, timeout: 0.4 });
		expect(partial).toContain("still running after 0.4s");
		expect(partial).toContain("step 1");

		const done = await h.call("job_wait", { jobId, timeout: 10 });
		expect(done).toContain("exited");
		expect(done).toContain("exit code: 0");
		expect(done).toContain("step 3");
	});

	it("a failing command returns its exit code", async () => {
		const h = makeHarness();
		const start = await h.call("bash_bg", { command: "echo about to fail\nexit 3" });
		const jobId = startedJobId(start);
		const result = await settle(h, jobId);
		expect(result).toContain("exited");
		expect(result).toContain("exit code: 3");
		expect(result).toContain("about to fail");
	});

	it("runs the command in the given cwd with the given env, and shows the label", async () => {
		const h = makeHarness();
		const start = await h.call("bash_bg", {
			command: "echo $MY_JOB_VAR\npwd",
			cwd: h.sessionsRoot,
			env: { MY_JOB_VAR: "hello-env" },
			label: "my-label",
		});
		const jobId = startedJobId(start);
		expect(start).toContain("(my-label)");
		const result = await settle(h, jobId);
		expect(result).toContain("exit code: 0");
		expect(result).toContain("hello-env");
		expect(result).toContain(h.sessionsRoot);

		const list = await h.call("job_status", {});
		expect(list).toContain("my-label");
		expect(list).toContain(`exited (0)`);
	});

	it("an unknown job id errors and names the live jobs", async () => {
		const h = makeHarness();
		const start = await h.call("bash_bg", { command: "sleep 5", label: "the-live-one" });
		const jobId = startedJobId(start);

		let error: Error | null = null;
		try {
			await h.call("job_wait", { jobId: "jb-does-not-exist" });
		} catch (err) {
			error = err as Error;
		}
		expect(error).not.toBeNull();
		expect(error?.message).toContain("unknown job 'jb-does-not-exist'");
		expect(error?.message).toContain(jobId);
		expect(error?.message).toContain("the-live-one");
		await settle(h, jobId);
	});

	it("job_status reports one job without waiting and lists all jobs", async () => {
		const h = makeHarness();
		const a = startedJobId(await h.call("bash_bg", { command: "echo alpha", label: "alpha" }));
		const b = startedJobId(await h.call("bash_bg", { command: "sleep 2", label: "beta" }));
		const one = await settle(h, a);
		expect(one).toContain("exit code: 0");

		const single = await h.call("job_status", { jobId: b });
		expect(single).toContain(`job ${b}`);
		expect(single).toContain("status: running");
		expect(single).toMatch(/pid: \d+/);
		expect(single).toMatch(/age: \d+[smh]/);
		expect(single).toContain("beta");
		expect(single).toMatch(/log: .+job\.log/);

		const list = await h.call("job_status", {});
		expect(list).toContain("2 job(s)");
		expect(list).toContain(`exited (0)`);
		expect(list).toContain("running");
		expect(list).toContain("beta");
		// Newest first.
		expect(list.indexOf(b)).toBeLessThan(list.indexOf(a));
		await settle(h, b);
	});

	it("refuses a start beyond the concurrent bound, with the list of running jobs", async () => {
		const h = makeHarness();
		const started: string[] = [];
		for (let i = 0; i < 8; i += 1) {
			started.push(startedJobId(await h.call("bash_bg", { command: "sleep 2", label: `filler ${i}` })));
		}
		const refused = await h.call("bash_bg", { command: "echo over the bound" });
		expect(refused).toContain("concurrent job bound reached");
		expect(refused).toContain(started[0]);
		expect(started.every((id) => refused.includes(id))).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 3000));
	});
});

describe("job state on disk", () => {
	it("a job started by one extension instance can be waited on by a fresh instance pointed at the same state directory", async () => {
		const first = makeHarness();
		const start = await first.call("bash_bg", { command: "sleep 1\necho done-from-first", label: "cross-instance" });
		const jobId = startedJobId(start);

		// A fresh instance: a new mock pi, the same sessions root, so the
		// derived job root is the same directory.
		const second = makeHarnessSameRoot(first.sessionsRoot);
		const result = await second.call("job_wait", { jobId, timeout: 10 });
		expect(result).toContain("exited");
		expect(result).toContain("exit code: 0");
		expect(result).toContain("done-from-first");
	});

	it("stale job directories are cleaned when a new job starts", async () => {
		const h = makeHarness();
		const root = jobsRootOf(h);
		mkdirSync(root, { recursive: true });
		const stale = join(root, "jb-stale");
		mkdirSync(stale);
		writeFileSync(join(stale, "manifest.json"), JSON.stringify({ jobId: "jb-stale", pid: 1, startedAt: new Date().toISOString() }));
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(stale, eightDaysAgo, eightDaysAgo);

		const start = await h.call("bash_bg", { command: "echo after cleanup" });
		const jobId = startedJobId(start);
		expect(existsSync(stale)).toBe(false);
		await settle(h, jobId);
	});
});

/** A second instance that shares the first's sessions root, modelling a
 * new pi session on the same machine. */
function makeHarnessSameRoot(sessionsRoot: string): Harness {
	const tools = new Map<string, ToolDef>();
	const pi = { registerTool: (t: ToolDef) => tools.set(t.name, t) } as unknown as ExtensionAPI;
	registerTools(pi);
	const sessionFile = join(sessionsRoot, "project", "session-2.jsonl");
	const ctx = {
		cwd: join(sessionsRoot, "project"),
		sessionManager: { getSessionFile: () => sessionFile },
	} as unknown as ExtensionContext;
	return {
		sessionsRoot,
		call: async (tool, params) => {
			const t = tools.get(tool);
			if (!t) throw new Error(`no such tool: ${tool}`);
			const result = (await t.execute("1", params, undefined, undefined, ctx)) as ToolResult;
			return result.content.map((c) => c.text).join("\n");
		},
	};
}

// The default export must register the same three tools, so a live pi that
// loads index.ts directly gets them.
it("the default export registers bash_bg, job_wait, and job_status", () => {
	const tools = new Map<string, ToolDef>();
	const pi = { registerTool: (t: ToolDef) => tools.set(t.name, t) } as unknown as ExtensionAPI;
	registerBackgroundJobs(pi);
	expect([...tools.keys()].sort()).toEqual(["bash_bg", "job_status", "job_wait"]);
	for (const [name, t] of tools) {
		expect(t.promptSnippet, `${name} promptSnippet`).toBeTruthy();
		expect(t.parameters, `${name} parameters`).toBeTruthy();
	}
});

describe("bash_bg tool row (issue #101)", () => {
	const paint = {
		fg: (_color: "toolTitle" | "toolOutput", text: string) => text,
		bold: (text: string) => text,
	};

	it("paints the command in the built-in bash line shape", () => {
		expect(paintBashBgCallLine("npm test", paint)).toBe("$ npm test");
	});

	it("keeps a multi-line command intact", () => {
		expect(paintBashBgCallLine("echo a\necho b", paint)).toBe("$ echo a\necho b");
	});

	it("paints the streaming placeholder for a missing or empty command", () => {
		expect(paintBashBgCallLine(undefined, paint)).toBe("$ ...");
		expect(paintBashBgCallLine("", paint)).toBe("$ ...");
	});

	it("the bash_bg definition paints its tool row through renderCall", () => {
		const tools = new Map<string, ToolDef>();
		const pi = { registerTool: (t: ToolDef) => tools.set(t.name, t) } as unknown as ExtensionAPI;
		registerTools(pi);
		const def = tools.get("bash_bg");
		expect(def?.renderCall, "bash_bg renderCall").toBeTypeOf("function");
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const context = { lastComponent: undefined } as unknown as Parameters<NonNullable<ToolDef["renderCall"]>>[2];
		const component = def!.renderCall!({ command: "npm test" }, theme, context);
		expect(component.render(200).map((line) => line.trim())).toEqual(["$ npm test"]);
	});
});

// ---------------------------------------------------------------------------
// The bound on the job listing
// ---------------------------------------------------------------------------

/** Write a job directory the way the wrapper leaves one: a manifest, and no
 * exit code file when the job is to read as running. */
function writeJobDir(jobsRoot: string, jobId: string, { startedAt, label, running }: { startedAt: string; label: string; running: boolean }): void {
	const dir = join(jobsRoot, jobId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ jobId, command: `echo ${label}`, cwd: jobsRoot, label, pid: running ? process.pid : 0, startedAt, logPath: join(dir, "job.log") }),
	);
	if (!running) writeFileSync(join(dir, "exitcode"), "0");
}

/** `count` job directories, the newest first in time: job-0 is the oldest. */
function writeJobDirs(jobsRoot: string, count: number, { running = false }: { running?: boolean } = {}): string[] {
	const base = Date.parse("2026-01-01T00:00:00.000Z");
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = `job-${String(i).padStart(3, "0")}`;
		writeJobDir(jobsRoot, id, { startedAt: new Date(base + i * 1000).toISOString(), label: `job ${i}`, running });
		ids.push(id);
	}
	return ids;
}

describe("the job listing is bounded", () => {
	it("names the bound as a constant, not a setting", () => {
		// A listing bound protects the message, not a taste, so it is not
		// operator-configurable. Pinning it says so.
		expect(MAX_LISTED_JOBS).toBe(20);
	});

	it("lists the newest jobs and says how many it left out", async () => {
		const h = makeHarness();
		const ids = writeJobDirs(join(h.sessionsRoot, "jobs"), MAX_LISTED_JOBS + 5);
		const list = await h.call("job_status", {});
		const lines = list.split("\n");

		// The total stays the truth about the root; only the listing is bounded.
		expect(lines[0]).toBe(`${MAX_LISTED_JOBS + 5} job(s):`);
		expect(lines.length).toBe(2 + MAX_LISTED_JOBS);
		expect(lines[lines.length - 1]).toBe(`5 older job(s) not listed: the newest ${MAX_LISTED_JOBS} are shown; the full list is in ${join(h.sessionsRoot, "jobs")}`);
		// Newest first, and the ones left out are the oldest.
		expect(lines[1]).toContain(ids[ids.length - 1]);
		expect(lines[MAX_LISTED_JOBS]).toContain(ids[ids.length - MAX_LISTED_JOBS]);
		expect(list).not.toContain("job 000");
	});

	it("says nothing about omissions when the bound covers every job", async () => {
		const h = makeHarness();
		writeJobDirs(join(h.sessionsRoot, "jobs"), MAX_LISTED_JOBS);
		const list = await h.call("job_status", {});
		expect(list).not.toContain("not listed");
		expect(list.split("\n").length).toBe(1 + MAX_LISTED_JOBS);
	});

	it("bounds the live-job listing with the same wording", () => {
		// The live listing is what an unknown job id answers with. A root full
		// of running jobs must not bury the one the caller might mean.
		const h = makeHarness();
		writeJobDirs(join(h.sessionsRoot, "jobs"), MAX_LISTED_JOBS + 3, { running: true });
		const live = formatLiveJobs(join(h.sessionsRoot, "jobs"));
		const lines = live.split("\n");
		expect(lines.length).toBe(1 + MAX_LISTED_JOBS);
		expect(lines[lines.length - 1]).toBe(`3 older job(s) not listed: the newest ${MAX_LISTED_JOBS} are shown; the full list is in ${join(h.sessionsRoot, "jobs")}`);
	});

	it("an unknown job id answers with the bounded live listing", async () => {
		const h = makeHarness();
		writeJobDirs(join(h.sessionsRoot, "jobs"), MAX_LISTED_JOBS + 3, { running: true });
		let message = "";
		try {
			await h.call("job_status", { jobId: "job-nope" });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("job-nope");
		expect(message).toContain(`not listed: the newest ${MAX_LISTED_JOBS} are shown; the full list is in ${join(h.sessionsRoot, "jobs")}`);
		expect(message).not.toContain("job 000");
	});
});
