# A job's lifetime is bounded by the agent process

The diagnosis of issue #139 surfaced a spec error: ADR 0023 decided that
jobs outlive the session, so that a new session can wait on a job an old
session started. That was never the intent of the capability. `bash_bg`
exists to give the agent a way to run long tasks without blocking its turn:
the job outlives the turn, not the agent. A wrapper that outlives the agent
process is what produced the orphan processes of #139 in the first place,
and the cross-session wait story kept the design pointed the wrong way.

**The wrapper watches the agent process that started it.** The agent is
the wrapper's parent, and its pid is stable for the wrapper's whole life.
The wrapper starts a small watcher subshell that polls the agent's pid:
while the agent is alive and the job has not completed (the exit code file
is the completion signal), the watcher sleeps. When the agent's pid stops
answering, the watcher signals the job's process group: TERM, a short
grace, then KILL, and it writes a `stopped` marker into the job directory.
The watcher runs in the job's own process group, so the group signal
reaches every process of the job. One mechanism covers every way an agent
can die: clean exit, SIGKILL, crash, OOM. A new session can read the
records and logs jobs left behind, but it never manages a live job from
another agent. Work that must outlive the agent is not a `bash_bg` job:
the operator uses nohup, a service manager, or a terminal multiplexer.

**Supersedes** the outlive-the-session and cross-session-wait decisions of
ADR 0023. The on-disk job state, the exit code file, the machine-level
concurrent bound, and the process-group management of ADR 0036 all stand.

**Considered options.** Not detaching the wrapper, so it dies with the
agent's process group: covers terminal and group signals only, not a
single-pid kill or a clean process exit. A resident Node watchdog process
per agent: a second long-lived process to manage, for what a two-line
polling subshell in the wrapper already does. PDEATHSIG (Linux): immediate
and kernel-maintained, but unreachable from a POSIX sh wrapper and absent
on macOS; the two-second poll is the portable equivalent. The agent
stopping its own jobs on a clean shutdown hook: covers the tidy case only;
crashes and kills still leak, and the watcher is the one place all exit
paths converge.
