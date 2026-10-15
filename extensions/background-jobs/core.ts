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
 *                    records the child pid, and writes the exit code. It
 *                    also runs a watcher on the agent process's pid
 *     job.log        the child's stdout and stderr
 *     child.pid      the command's pid (for signalling it)
 *     watcher.pid    the wrapper's agent-watcher subshell (for cleanup)
 *     stopped        marker written when the agent died and the watcher
 *                    stopped the job's process group
 *     exitcode       the child's exit code, written by the wrapper on exit
 *
 * The exit code file is the point of the wrapper: it makes the code
 * knowable to a process that did not start the job. The record stays on
 * disk for a new session to read, but a live job never outlives its agent
 * (ADR 0037): the wrapper's watcher polls the agent's pid, and when the
 * agent exits or is killed the watcher stops the job's process group
 * (TERM, a grace, KILL) and writes the stopped marker.
 *
 * The job is one process group, led by the wrapper: detached makes the
 * wrapper the group leader, and the group id (the wrapper's pid) stays
 * valid after the wrapper dies, as long as any member is alive. So the
 * whole tree is always stoppable with `kill -- -<pid>`, and the record
 * keeps covering the job while any of its processes is alive: no process
 * of a job ever outlives the record (ADR 0036). The shell scripts install
 * no signal traps: dash and the bash versions that serve as /bin/sh
 * disagree on trap semantics, and bash 5.3 crashes on a `kill 0` group
 * kill inside a trap, so the group is managed with plain group signals.
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
/** How many jobs one listing names, newest first. A long-lived session
 * accumulates job directories for weeks; a listing of every one of them is
 * a wall of text that buries the jobs the caller asked about. The bound is
 * a constant, not a setting: it protects the message, not a taste. */
export const MAX_LISTED_JOBS = 20;
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
	/** The wrapper process's pid, and therefore the job's process group id
	 * (the detached wrapper is the group leader): signal the group with
	 * `kill -- -<pid>` to stop the whole job. The command's pid is in
	 * child.pid once the wrapper has launched it. */
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
	/** True when the record's stopped marker says the agent process died
	 * and the wrapper's watcher stopped the job's process group. */
	stopped: boolean;
	/** The job's process group id: the wrapper's pid. Stopping the job is a
	 * signal to that group (`kill -- -<pid>`), which covers every process
	 * of the job, the wrapper dead or not. */
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

/** True while the job's processes may still be alive: the wrapper pid
 * normally, the child pid once the wrapper is gone, and the watcher pid
 * while it polls. A finished job is never counted alive: the exit code
 * file (the job completed on its own) or the stopped marker (the agent
 * died and the watcher stopped the group) is the completion signal, and
 * an old recorded pid may have been reused by an unrelated process -
 * pids wrap on macOS at 99999 - so a pid check could hold a finished
 * directory hostage forever. A job directory is never removed while this
 * holds, so the processes a live record covers can never become
 * unmanageable. */
function jobProcessesAlive(dir: string): boolean {
	if (fileExists(join(dir, "exitcode")) || fileExists(join(dir, "stopped"))) return false;
	let wrapperPid: number | null = null;
	try {
		wrapperPid = Number.parseInt(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).pid, 10);
	} catch {
		wrapperPid = null;
	}
	return isPidAlive(wrapperPid) || isPidAlive(readNumberFile(join(dir, "child.pid"))) || isPidAlive(readNumberFile(join(dir, "watcher.pid")));
}

/** True when the file exists. */
function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** True when the record carries the stopped marker (the agent died and
 * the wrapper's watcher stopped the job). */
function jobStopped(dir: string): boolean {
	try {
		return readFileSync(join(dir, "stopped"), "utf8").trim() === "agent-exited";
	} catch {
		return false;
	}
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
	const watcherPid = readNumberFile(join(dir, "watcher.pid"));
	// The record covers the job while any of its processes is alive: the
	// wrapper normally, the command's shell and the watcher after an
	// untrappable wrapper death. Then a session can still wait on, or stop
	// (group signal), the surviving tree instead of reading a dead wrapper
	// as an exit that never came (issue #139).
	const running = exitCode === null && (isPidAlive(manifest.pid) || isPidAlive(childPid) || isPidAlive(watcherPid));
	return {
		jobId: manifest.jobId,
		name: manifest.label ?? commandHead(manifest.command),
		status: running ? "running" : "exited",
		exitCode,
		stopped: jobStopped(dir),
		pid: manifest.pid || null,
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

/** The running jobs as a line per job, for refusal and unknown-id errors.
 * Bounded like every other listing, with the same wording about what the
 * bound left out. */
export function formatLiveJobs(jobsRoot: string, now: number = Date.now()): string {
	return formatJobListing(listJobs(jobsRoot, now).filter((job) => job.status === "running"), jobsRoot);
}

/** The listing: at most MAX_LISTED_JOBS jobs, newest first, and one line
 * naming how many the bound left out and where the rest lives (the Job
 * root). A caller that needs the rest reads the job directories there; the
 * listing is not the index. */
export function formatJobListing(jobs: JobInfo[], jobsRoot: string): string {
	const listed = jobs.slice(0, MAX_LISTED_JOBS);
	const lines = listed.map(formatJobLine);
	const omitted = jobs.length - listed.length;
	if (omitted > 0) lines.push(`${omitted} older job(s) not listed: the newest ${MAX_LISTED_JOBS} are shown; the full list is in ${jobsRoot}`);
	return lines.join("\n");
}

/** Removes job directories older than the stale bound. The record of a
 * live job is never removed: a long-running job never refreshes its
 * directory's mtime (the wrapper writes only on exit), so age alone would
 * delete the record of a live job and leave its processes unmanageable
 * (issue #139). A finished job is always removable, whatever its recorded
 * pids say: the exit code file or the stopped marker is the completion
 * signal, and the pids may have been reused. Returns how many it removed.
 * Called when a new job starts, so cleanup rides on real usage and never
 * runs on a schedule. */
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
			if (jobProcessesAlive(dir)) continue;
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
		"agent=$PPID",
		`sh ${shQuote(join(dir, "job.sh"))} > ${shQuote(manifest.logPath)} 2>&1 &`,
		"cp=$!",
		// The agent watcher (ADR 0037): a subshell in the job's own process
		// group polls the agent process's pid. While the agent is alive the
		// watcher only waits: the exit code file means the job finished on
		// its own, and a dead child means the job was stopped and nothing
		// is left to watch. When the agent dies, the watcher marks the
		// record, then stops the job's process group (TERM, a grace, KILL).
		// It ignores TERM so it survives the group signal it sends, and it
		// is the only process allowed to write the stopped marker.
		"(",
		"trap '' TERM",
		`while kill -0 "$agent" 2>/dev/null; do`,
		`  [ -f ${shQuote(join(dir, "exitcode"))} ] && exit 0`,
		"  kill -0 \"$cp\" 2>/dev/null || exit 0",
		"  sleep 2",
		"done",
		`[ -f ${shQuote(join(dir, "exitcode"))} ] || printf 'agent-exited\\n' > ${shQuote(join(dir, "stopped"))}`,
		"kill 0 2>/dev/null",
		"sleep 3",
		"kill -KILL 0 2>/dev/null",
		") &",
		"wp=$!",
		`printf '%s\\n' "$cp" > ${shQuote(join(dir, "child.pid"))}`,
		`printf '%s\\n' "$wp" > ${shQuote(join(dir, "watcher.pid"))}`,
		'wait "$cp"',
		"rc=$?",
		`printf '%s\\n' "$rc" > ${shQuote(join(dir, "exitcode"))}`,
		'kill -KILL "$wp" 2>/dev/null',
		'exit "$rc"',
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
	const status =
		job.status === "running"
			? "running"
			: job.exitCode !== null
				? `exited (${job.exitCode})`
				: job.stopped
					? "stopped (agent)"
					: "exited (no code)";
	return `${job.jobId}  ${status.padEnd(16)} ${formatAge(job.ageMs).padStart(6)}  ${job.name}`;
}

/** One job as a multi-line block for the single-job status. */
export function formatJob(job: JobInfo): string {
	const status =
		job.status === "running"
			? "running"
			: job.exitCode !== null
				? `exited (${job.exitCode})`
				: job.stopped
					? "stopped (the agent process exited)"
					: "exited (no exit code recorded)";
	const lines = [
		`job ${job.jobId}`,
		`status: ${status}`,
		`pid: ${job.pid ?? "unknown"}`,
	];
	if (job.pid) lines.push(`stop: kill -- -${job.pid}`);
	lines.push(
		`age: ${formatAge(job.ageMs)}`,
		`name: ${job.name}`,
		`log: ${job.logPath}`,
	);
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
