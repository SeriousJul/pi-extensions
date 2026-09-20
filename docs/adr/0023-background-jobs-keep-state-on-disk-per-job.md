# Background jobs keep state on disk, per job

pi's bash tool is synchronous, so a command that takes minutes blocks the
agent for its whole duration. The agents worked around it with nohup,
sleep, and pgrep loops: 19 minutes of pure waiting, plus the context the
loops cost, in the factory sessions of 2026-09-19 to 2026-09-20. The
background jobs extension replaces the loops with three tools: `bash_bg`
starts a command detached, `job_wait` blocks until it exits or a timeout,
and `job_status` reports one job or lists all without waiting.

Three decisions shape the extension.

**Job state lives on disk, one directory per job, under pi's agent state
root** (the parent of the session directory). A job is a directory holding
the manifest (command, cwd, label, pid, start time, log path), the command
script, the log, the child pid, and the exit code. In-memory state would
vanish when the session that started the job ends, and the whole point of
backgrounding is that the work outlives the turn. On-disk state is what
lets a new session find and wait on a job a previous session started, and
it costs nothing: the directories are small, start removes directories
older than seven days, and a machine-level bound of eight concurrent
running jobs keeps the set finite.

**The exit code is recorded by a shell wrapper, not read from the spawned
process.** The wrapper runs the command script with its output to the log,
records the child's pid, and writes the child's exit code to a file in the
job directory on exit. Node's child process exit is only readable by the
process that spawned it, so without the file a new session could see that
the job is gone but never what it returned: a failed build and a successful
one would look identical. The file makes the code knowable to any process,
which is also what the cross-session wait story needs.

**The tools are agent tools, active by default.** They are not in the
/tools default-disabled list of user-only tools. The capability replaces a
workaround the agent would otherwise improvise (the nohup-and-poll loops),
so default-inactive would silently buy nothing; the prompt cost is three
short descriptions and three guidelines. The prompt guideline carries the
when-to-use rule: background a command only when it is expected to take
more than about ten seconds, or when other work can proceed while it runs.
Plain bash stays the default.

Rejected alternatives: a single combined tool (start and wait in one call)
would not save time - the whole point is that the agent works while the
command runs, which needs the start and the wait in separate turns. A kill
tool is out of scope for the first version: the agent signals the job
through the ordinary bash tool with the pid the status reports, and a
dedicated kill is a candidate if sessions show the need. Per-user or
per-project job namespaces are rejected in favor of the machine-local
root: the bound is machine-level by design, and the operator runs several
agents on one machine, not in separate accounts. Windows is out of scope;
the wrapper is POSIX and the extension set targets the operator's Linux
and macOS machines.
