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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerBackgroundJobs, { registerTools } from "../../extensions/background-jobs/index";

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
