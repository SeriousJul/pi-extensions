# background jobs extension

Runs long commands in the background, so the agent is not blocked for the
whole duration of a test suite, a build, or a long fetch. Three tools:

- `bash_bg` starts a command detached and returns the job id, the pid, and
  the log path. The command runs through a shell; its stdout and stderr go
  to a per-job log file. Parameters: `command` (required), `cwd`, `env`
  (extra variables merged over the current environment), and `label`.
- `job_wait` blocks until the job exits or a timeout (default 120 seconds)
  and returns the exit code with a tail of the output (default 30 lines).
  On timeout it returns "still running" with the tail so far, so the agent
  can wait again or move on.
- `job_status` reports one job by id, or lists every job with its age, its
  label or command head, and its status, without waiting.

The tools are active by default. The guideline is: background a command
only when it is expected to take more than about ten seconds, or when other
work can proceed while it runs; plain bash stays the default.

## Job state

Job state lives on disk, one directory per job under pi's agent state root
(the parent of the session directory), in a `jobs` subdirectory. Each
directory holds the manifest (command, cwd, label, pid, start time, log
path), the command script, the log, the child pid, and the exit code.
Jobs outlive the session that started them: a new session can list and
wait on a job an old session started. `PI_JOBS_DIR` overrides the root.
([ADR 0023](/adr/0023-background-jobs-keep-state-on-disk-per-job).)

- **The exit code is recorded by a shell wrapper.** The wrapper runs the
  command with its output to the log, records the child pid, and writes
  the exit code to a file on exit, so the code is knowable to any process,
  not only the one that spawned the command.
- **A machine-level bound of eight** concurrent running jobs. A start
  beyond the bound is refused with the list of running jobs.
- **Stale cleanup.** Starting a new job removes job directories older
  than seven days, so the state directory does not grow forever.
- **No kill tool.** To stop a job, signal the pid that `job_status`
  reports through the ordinary bash tool. A dedicated kill is a candidate
  if sessions show the need.

POSIX only: the wrapper is `/bin/sh`. The extension set targets the
operator's Linux and macOS machines.

## How it works

The spawn, poll, tail, cleanup, and formatting logic lives in the core
module (`extensions/background-jobs/core.ts`); the pi wiring (`index.ts`)
only registers the three tools and resolves the job root from the session
file.
