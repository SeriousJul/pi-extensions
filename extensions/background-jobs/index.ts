/**
 * Background jobs: bash_bg, job_wait, job_status (issue #95).
 *
 * pi's bash tool is synchronous, so a command that takes minutes blocks the
 * agent for its whole duration. This extension gives the agent one waiting
 * call instead: bash_bg starts a long command detached and returns a job
 * id, a pid, and a log path; job_wait blocks until the job exits or a
 * timeout and returns the exit code with a tail of the output; job_status
 * reports one job, or lists all jobs, without waiting. The agent starts a
 * suite, keeps working on other files, and waits once at the end.
 *
 * Job state lives on disk under pi's agent state root, one directory per
 * job, so jobs outlive the session that started them (ADR 0023). The three
 * tools are agent tools, active by default: the capability replaces a
 * workaround the agent would otherwise improvise, and the prompt cost is
 * three short descriptions, so they are not in the /tools default-disabled
 * list.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_TAIL_LINES,
	DEFAULT_WAIT_TIMEOUT_S,
	UnknownJobError,
	formatJob,
	formatJobLine,
	formatLiveJobs,
	getJob,
	listJobs,
	resolveJobsRoot,
	startJob,
	tailOfFile,
	waitJob,
} from "./core.ts";

/** The job root for a tool call: the env override, else derived from the
 * session file (parent of the session directory), else the default. */
function jobsRootFor(ctx: ExtensionContext | undefined): string {
	const file = ctx?.sessionManager?.getSessionFile?.();
	return resolveJobsRoot(process.env, typeof file === "string" ? file : undefined);
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export function registerTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "bash_bg",
		label: "Bash background",
		description:
			"Start a long-running command in the background without blocking. The command runs detached through a shell; its stdout and stderr go to a per-job log file. Returns the job id, the pid, and the log path. A machine-level bound limits the number of concurrent running jobs.",
		promptSnippet: "Start a long command in the background; returns job id, pid, and log path.",
		parameters: Type.Object({
			command: Type.String({ description: "The command to run, as you would pass it to the bash tool." }),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session's working directory." })),
			env: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Extra environment variables for the command, merged over the current environment.",
				}),
			),
			label: Type.Optional(Type.String({ description: "A short name for the job, shown in job_status lists." })),
		}),
		promptGuidelines: [
			"Use bash_bg to start a command in the background only when it is expected to take more than about ten seconds, or when other work can proceed while it runs; plain bash stays the default for shorter commands.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = startJob({
				jobsRoot: jobsRootFor(ctx),
				command: params.command,
				cwd: params.cwd ?? (ctx?.cwd || process.cwd()),
				...(params.env ? { env: params.env } : {}),
				...(params.label ? { label: params.label } : {}),
			});
			if (!result.ok) return textResult(result.error);
			const m = result.manifest;
			return textResult(
				`job ${m.jobId} started${m.label ? ` (${m.label})` : ""}\npid: ${m.pid}\nlog: ${m.logPath}\nwait on it with job_wait; inspect it with job_status.`,
			);
		},
	});

	pi.registerTool({
		name: "job_wait",
		label: "Job wait",
		description:
			"Wait for a background job started with bash_bg to exit, or for a timeout. On exit returns the exit code and a tail of the output; on timeout returns the status 'running' with the tail so far, so you can choose to wait again or move on.",
		promptSnippet: "Wait for a background job to exit (or a timeout); returns exit code and output tail.",
		parameters: Type.Object({
			jobId: Type.String({ description: "The job id from bash_bg." }),
			timeout: Type.Optional(
				Type.Number({
					description: `Timeout in seconds. Default ${DEFAULT_WAIT_TIMEOUT_S}. On timeout the job keeps running and you can call job_wait again.`,
				}),
			),
			tailLines: Type.Optional(Type.Number({ description: `How many output lines to return. Default ${DEFAULT_TAIL_LINES}.` })),
		}),
		promptGuidelines: [
			"Use job_wait to wait on a bash_bg job; never write a sleep-and-tail or pgrep loop to poll one.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const timeoutS = params.timeout ?? DEFAULT_WAIT_TIMEOUT_S;
			const info = await waitJob(jobsRootFor(ctx), params.jobId, timeoutS * 1000);
			const tail = tailOfFile(info.logPath, params.tailLines ?? DEFAULT_TAIL_LINES);
			if (info.status === "exited") {
				const code = info.exitCode === null ? "no exit code recorded" : `exit code: ${info.exitCode}`;
				return textResult(`job ${info.jobId} exited\n${code}\nlog: ${info.logPath}\ntail:\n${tail || "(no output)"}`);
			}
			return textResult(
				`job ${info.jobId} still running after ${timeoutS}s (timeout)\nlog: ${info.logPath}\ntail so far:\n${tail || "(no output yet)"}`,
			);
		},
	});

	pi.registerTool({
		name: "job_status",
		label: "Job status",
		description:
			"Report one background job by id, or list every job (running and exited) with its age, name, and status, without waiting. To stop a job, signal its pid through the bash tool.",
		promptSnippet: "Report one background job, or list all jobs, without waiting.",
		parameters: Type.Object({
			jobId: Type.Optional(Type.String({ description: "A job id. Omit to list every job." })),
		}),
		promptGuidelines: [
			"Use job_status to inspect one bash_bg job or list all jobs without waiting; if a job must be stopped, signal the pid it reports through the bash tool.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const jobsRoot = jobsRootFor(ctx);
			if (params.jobId) {
				const info = getJob(jobsRoot, params.jobId);
				if (!info) throw new UnknownJobError(params.jobId, formatLiveJobs(jobsRoot));
				return textResult(formatJob(info));
			}
			const jobs = listJobs(jobsRoot);
			if (jobs.length === 0) return textResult("no jobs");
			return textResult(`${jobs.length} job(s):\n${jobs.map(formatJobLine).join("\n")}`);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerTools(pi);
}
