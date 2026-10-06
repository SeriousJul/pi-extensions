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
- `job_status` reports one job by id, or lists jobs with their age, their
  label or command head, and their status, without waiting. The listing is
  bounded: newest first, the total stated, and one line naming how many the
  bound left out and where the rest lives.

The tools are active by default. The guideline is: background a command
only when it is expected to take more than about ten seconds, or when other
work can proceed while it runs; plain bash stays the default.

## Tool row

The `bash_bg` tool row - the TUI entry for the call in an agent turn - shows
the command in the built-in bash line shape, `$ <command>`, with no
background marker: the tool name already says the command is backgrounded,
and the command line is the true intent
([ADR 0024](/adr/0024-bash-bg-tool-row-shows-the-plain-command-line.md)). A
multi-line command renders in full, and while the arguments stream in the
row shows `$ ...`.

```
$ npm test
job jb-abc123 started
pid: 4242
log: ~/.pi/agent/sessions/jobs/jb-abc123/job.log
wait on it with job_wait; inspect it with job_status.
```

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
- **A bound on the listing itself.** One `job_status` call with no id lists
  at most `MAX_LISTED_JOBS` jobs (20), newest first, and then says how many
  it left out and names the Job root where the rest lives. The bound is a
  constant, not a setting: it protects the context the listing is written
  into. A machine with hundreds of jobs must not pay roughly 19,000 tokens
  for one status call, and the unknown-job-id error stays bounded the same
  way and running-jobs-only, so a typo cannot pull the machine's job history
  into the session.
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
