# background jobs extension

Runs long commands in the background, so the agent is not blocked for the
whole duration of a test suite, a build, or a long fetch. Three tools:

- `bash_bg` starts a command detached and returns the job id, the pid, and
  the log path. The command runs through a shell; its stdout and stderr go
  to a per-job log file. The job is stopped when the agent process that
  started it exits or is killed; work that must outlive the agent belongs
  in nohup, a service manager, or a terminal multiplexer. Parameters:
  `command` (required), `cwd`, `env` (extra variables merged over the
  current environment), and `label`.
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
wait on it with job_wait; inspect it with job_status. To stop it, kill its
process group: kill -- -4242.
```

## Job state

Job state lives on disk, one directory per job under pi's agent state root
(the parent of the session directory), in a `jobs` subdirectory. Each
directory holds the manifest (command, cwd, label, pid, start time, log
path), the command script, the log, the child pid, the watcher pid, the
exit code, and the stopped marker. A live job dies with the agent process
that started it (ADR 0037): the record, the log, and the exit code stay on
disk, so a new session can read what ran, but it never manages a live job
from another agent. `PI_JOBS_DIR` overrides the root.
([ADR 0023](/adr/0023-background-jobs-keep-state-on-disk-per-job),
[ADR 0037](/adr/0037-a-job-dies-with-the-agent-process).)

- **The exit code is recorded by a shell wrapper.** The wrapper runs the
  command with its output to the log, records the child pid, and writes
  the exit code to a file on exit, so the code is knowable to any process,
  not only the one that spawned the command.
- **The wrapper watches the agent process.** It runs a watcher subshell
  that polls the agent's pid; when the agent exits or is killed, the
  watcher stops the job's process group (TERM, a grace, KILL) and writes
  the `stopped` marker into the job directory, so no process of the job
  outlives the agent (ADR 0037).
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
  than seven days, except the record of a job whose processes are still
  alive, so the state directory does not grow forever.
- **No kill tool.** To stop a job, signal its process group through the
  ordinary bash tool: `kill -- -<pid>`, where `<pid>` is the one
  `job_status` reports. One signal reaches every process of the job,
  wrapper dead or not (ADR 0036). A dedicated kill is a candidate if
  sessions show the need.

POSIX only: the wrapper is `/bin/sh`. The extension set targets the
operator's Linux and macOS machines.

## How it works

The spawn, poll, tail, cleanup, and formatting logic lives in the core
module (`extensions/background-jobs/core.ts`); the pi wiring (`index.ts`)
only registers the three tools and resolves the job root from the session
file.
