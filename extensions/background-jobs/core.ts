/**
 * Background jobs core: the on-disk job store and the spawn, poll, tail,
 * and cleanup logic behind bash_bg, job_wait, and job_status (issue #95).
 *
 * Every job lives in one directory under the job root, one subdirectory per
 * job (ADR 0023):
 *
 *   <root>/<jobId>/
 *     manifest.json  the job record: command, cwd, label, wrapper pid,
 *                    start time, log path
 *     job.sh         the user command, written verbatim
 *     run.sh         the shell wrapper: runs job.sh with output to job.log,
 *                    records the child pid, and writes the exit code
 *     job.log        the child's stdout and stderr
 *     child.pid      the command's pid (for signalling it)
 *     exitcode       the child's exit code, written by the wrapper on exit
 *
 * The exit code file is the point of the wrapper: it makes the code
 * knowable to a process that did not start the job, so a new pi session can
 * wait on a job an old session started. Jobs outlive the session.
 *
 * POSIX only: the wrapper is /bin/sh. The extension set targets the
 * operator's Linux and macOS machines.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSessionsRoot } from "../shared/sessions.ts";

/** Environment variable that overrides the job root, for tests and ops. */
export const JOBS_DIR_ENV = "PI_JOBS_DIR";
/** The machine-level bound on concurrent running jobs. */
export const MAX_RUNNING_JOBS = 8;
/** Job directories older than this are removed when a new job starts. */
export const STALE_JOB_MS = 7 * 24 * 60 * 60 * 1000;
/** The default job_wait timeout, in seconds. */
export const DEFAULT_WAIT_TIMEOUT_S = 120;
/** The default number of output lines a wait or status tail shows. */
export const DEFAULT_TAIL_LINES = 30;
/** The poll interval of job_wait. */
const POLL_INTERVAL_MS = 250;

/** The on-disk job record. */
export interface JobManifest {
	jobId: string;
	command: string;
	cwd: string;
	label?: string;
	/** The wrapper process's pid. The command's pid is in child.pid once
	 * the wrapper has launched it. */
	pid: number;
	/** ISO start time. */
	startedAt: string;
	logPath: string;
}

/** One job as a wait or status reports it. */
export interface JobInfo {
	jobId: string;
	/** The label, else the first line of the command, truncated. */
	name: string;
	status: "running" | "exited";
	/** The exit code once the wrapper recorded it. Null when the job is
	 * still running, or when the wrapper died before recording one. */
	exitCode: number | null;
	/** The command's pid when known, else the wrapper's pid. */
	pid: number | null;
	startedAt: string;
	ageMs: number;
	logPath: string;
}

/** The error a wait or status throws for an unknown job id. The message
 * carries the list of live jobs, so the agent recovers from a typo or a
 * stale id in one step (user story 8). */
export class UnknownJobError extends Error {
	constructor(jobId: string, liveList: string) {
		super(`unknown job '${jobId}'. Live jobs:\n${liveList || "(none)"}`);
		this.name = "UnknownJobError";
	}
}

/**
 * The job root: the env override, else the `jobs` directory under pi's
 * agent state root (the parent of the session directory), else the default
 * sessions root. Machine-local and shared across sessions by design.
 */
export function resolveJobsRoot(env: NodeJS.ProcessEnv = process.env, sessionFile?: string): string {
	const override = env[JOBS_DIR_ENV];
	if (override) return override;
	if (sessionFile) return join(dirname(dirname(sessionFile)), "jobs");
	return join(defaultSessionsRoot(env), "jobs");
}

/** True when a process with this pid answers signal 0. A pid that is gone
 * but was reused reports alive; the exit code file, not the pid, is the
 * exit authority, so the pid only decides "running" while the file is
 * absent. */
export function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The last n non-blank-at-end lines of a file. Missing or unreadable
 * files yield "". */
export function tailOfFile(path: string, lines: number): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return "";
	}
	const all = text.split("\n");
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	return all.slice(-lines).join("\n");
}

function readNumberFile(path: string): number | null {
	try {
		const parsed = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function commandHead(command: string): string {
	const first = command.split("\n")[0].trim();
	return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

function jobInfoFromManifest(dir: string, manifest: JobManifest, now: number): JobInfo {
	const exitCode = readNumberFile(join(dir, "exitcode"));
	const childPid = readNumberFile(join(dir, "child.pid"));
	const running = exitCode === null && isPidAlive(manifest.pid);
	return {
		jobId: manifest.jobId,
		name: manifest.label ?? commandHead(manifest.command),
		status: running ? "running" : "exited",
		exitCode,
		pid: childPid ?? manifest.pid,
		startedAt: manifest.startedAt,
		ageMs: Math.max(0, now - Date.parse(manifest.startedAt)),
		logPath: manifest.logPath,
	};
}

/** One job by id, or null when the job directory or its manifest is gone. */
export function getJob(jobsRoot: string, jobId: string, now: number = Date.now()): JobInfo | null {
	try {
		const manifest = JSON.parse(readFileSync(join(jobsRoot, jobId, "manifest.json"), "utf8"));
		return jobInfoFromManifest(join(jobsRoot, jobId), manifest, now);
	} catch {
		return null;
	}
}

/** Every job under the root, newest first. Directories without a readable
 * manifest are skipped. */
export function listJobs(jobsRoot: string, now: number = Date.now()): JobInfo[] {
	let names: string[];
	try {
		names = readdirSync(jobsRoot);
	} catch {
		return [];
	}
	const jobs: JobInfo[] = [];
	for (const name of names) {
		const dir = join(jobsRoot, name);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const info = getJob(jobsRoot, name, now);
		if (info) jobs.push(info);
	}
	jobs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	return jobs;
}

/** The running jobs as a line per job, for refusal and unknown-id errors. */
export function formatLiveJobs(jobsRoot: string, now: number = Date.now()): string {
	return listJobs(jobsRoot, now)
		.filter((job) => job.status === "running")
		.map((job) => formatJobLine(job))
		.join("\n");
}

/** Removes job directories older than the stale bound. Returns how many it
 * removed. Called when a new job starts, so cleanup rides on real usage
 * and never runs on a schedule. */
export function cleanupStaleJobs(jobsRoot: string, now: number = Date.now()): number {
	let names: string[];
	try {
		names = readdirSync(jobsRoot);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const dir = join(jobsRoot, name);
		try {
			const st = statSync(dir);
			if (!st.isDirectory()) continue;
			if (now - st.mtimeMs <= STALE_JOB_MS) continue;
		} catch {
			continue;
		}
		rmSync(dir, { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}

/**
 * Start a command detached. Cleans stale job directories, enforces the
 * concurrent bound, writes the job directory, and spawns the wrapper.
 * Synchronous: the slow part (the command) runs detached, so the tool call
 * itself stays a few milliseconds.
 */
export function startJob(input: {
	jobsRoot: string;
	command: string;
	cwd: string;
	env?: Record<string, string>;
	label?: string;
}): { ok: true; manifest: JobManifest } | { ok: false; error: string; running: JobInfo[] } {
	cleanupStaleJobs(input.jobsRoot);
	const running = listJobs(input.jobsRoot).filter((job) => job.status === "running");
	if (running.length >= MAX_RUNNING_JOBS) {
		return {
			ok: false,
			error: `concurrent job bound reached: ${running.length} job(s) are already running (bound ${MAX_RUNNING_JOBS}); refuse to start another. Running jobs:\n${running
				.map(formatJobLine)
				.join("\n")}`,
			running,
		};
	}

	const jobId = `jb-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
	const dir = join(input.jobsRoot, jobId);
	const manifest: JobManifest = {
		jobId,
		command: input.command,
		cwd: input.cwd,
		...(input.label ? { label: input.label } : {}),
		pid: 0,
		startedAt: new Date().toISOString(),
		logPath: join(dir, "job.log"),
	};
	mkdirSync(dir, { recursive: true });
	// The user command runs in its own script, so it is written verbatim and
	// never re-quoted into a second layer of shell text. job.sh must exist
	// before the spawn: the wrapper launches it on its second line.
	writeFileSync(join(dir, "job.sh"), `#!/bin/sh\ncd ${shQuote(input.cwd)} || exit 127\n${input.command}\n`);

	const runScript = [
		"set +e",
		`sh ${shQuote(join(dir, "job.sh"))} > ${shQuote(manifest.logPath)} 2>&1 &`,
		"cp=$!",
		`printf '%s\\n' "$cp" > ${shQuote(join(dir, "child.pid"))}`,
		'wait "$cp"',
		"rc=$?",
		`printf '%s\\n' "$rc" > ${shQuote(join(dir, "exitcode"))}`,
		"exit \"$rc\"",
	].join("\n");
	const child = spawn("sh", ["-c", runScript], {
		cwd: input.cwd,
		env: { ...process.env, ...(input.env ?? {}) },
		stdio: "ignore",
		detached: true,
	});
	manifest.pid = child.pid ?? 0;
	// The manifest lands after the spawn, so a wait from another process
	// never sees pid 0 or a half-built job.
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	child.unref();
	return { ok: true, manifest };
}

/** Wait for a job to exit, up to the timeout. Returns the job's info:
 * status "exited" on exit, "running" on timeout. Throws UnknownJobError
 * when the id is not a live job. */
export async function waitJob(
	jobsRoot: string,
	jobId: string,
	timeoutMs: number,
	pollMs: number = POLL_INTERVAL_MS,
): Promise<JobInfo> {
	const deadline = Date.now() + Math.max(0, timeoutMs);
	for (;;) {
		const info = getJob(jobsRoot, jobId);
		if (!info) throw new UnknownJobError(jobId, formatLiveJobs(jobsRoot));
		if (info.status === "exited") return info;
		if (Date.now() >= deadline) return info;
		await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
	}
}

// --- formatting ---------------------------------------------------------

/** One job as a line: id, status, age, name. */
export function formatJobLine(job: JobInfo): string {
	const status = job.status === "running" ? "running" : job.exitCode === null ? "exited (no code)" : `exited (${job.exitCode})`;
	return `${job.jobId}  ${status.padEnd(16)} ${formatAge(job.ageMs).padStart(6)}  ${job.name}`;
}

/** One job as a multi-line block for the single-job status. */
export function formatJob(job: JobInfo): string {
	const lines = [
		`job ${job.jobId}`,
		`status: ${job.status === "running" ? "running" : job.exitCode === null ? "exited (no exit code recorded)" : `exited (${job.exitCode})`}`,
		`pid: ${job.pid ?? "unknown"}`,
		`age: ${formatAge(job.ageMs)}`,
		`name: ${job.name}`,
		`log: ${job.logPath}`,
	];
	return lines.join("\n");
}

/** An age in the shortest honest unit: 45s, 5m, 2h, 3d. */
export function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Single-quote for shell embedding: the paths in the wrapper are ours,
 * but the cwd is operator input, so quote it. */
function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
