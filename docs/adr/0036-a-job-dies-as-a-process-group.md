# A job dies as a process group

Issue #139: operators saw processes of a `bash_bg` job (in their case,
several `bun` processes) still running in `top` while no agent was working
- orphans that no session could list, wait on, or stop.

Three mechanisms produced them. First, the wrapper shell could die while the
job's processes were still alive (a supervisor killing the wrapper's pid,
OOM): the descendants reparented to init, and the record declared the job
exited because only the wrapper's liveness was checked and the exit code
file - written by the dead wrapper - was absent. Second, the documented
stop path signalled the pid `job_status` reported, which was the job's
`sh` shell, not its process group: killing it left the command's own
processes behind. Third, the stale cleanup deleted any job directory older
than seven days, even a live one: a long-running job's directory mtime never
advances (the wrapper writes only on exit), so the next `bash_bg` start
removed the record and left the processes unmanageable.

**The job is one process group, and stopping it is a signal to that group.**
The wrapper is the group leader (`detached` makes the spawned shell the
leader of a new group, in a new session), and the group id - the wrapper's
pid - stays valid after the wrapper dies, as long as any member is alive.
`job_status` and `job_wait` therefore report the group pid, and the stop
path is `kill -- -<pid>` through the bash tool: one signal reaches every
process of the job, wrapper dead or not, with no per-process bookkeeping.

**The record covers the job while any of its processes is alive.** Liveness
is the wrapper's pid normally, and the `child.pid` process once the wrapper
is gone: a wrapper killed with SIGKILL cannot trap anything, but the
command's shell survives it, so the record keeps saying running and the
agent can wait on or group-stop the surviving tree. The stale cleanup skips
any directory whose job is still alive, so a job that outlives the seven-day
bound keeps its record instead of losing it.

**The shell scripts install no signal traps.** The first fix attempt trapped
HUP/INT/TERM/QUIT in the wrapper and the job's shell and cleared the group
from inside the trap with `kill 0`. It failed in practice: dash and the
bash versions that serve as `/bin/sh` disagree on trap semantics for
non-interactive shells (signals ignored on entry cannot be re-trapped, and
background children get INT/QUIT ignored), and bash 5.3 segfaulted on a
`kill 0` group kill inside a trap while waiting on a child. Group
management from the Node side - where the record is read and the pid is
known - is uniform across the operator's Linux and macOS machines and
needs no shell cooperation, including in the SIGKILL case where no trap
could have fired at all.

**Rejected alternatives.** Trapping and forwarding signals in the shell
wrapper (above): unportable across dash and bash, and useless against
SIGKILL. Auto-killing the job's processes when the wrapper dies: the ADR
0023 policy is that jobs outlive the session, so a surviving job is a
feature, not a leak; the bug was the record lying and the processes being
unreachable, not that they kept running. A Node watchdog process per job:
a second long-lived process to manage, for a job the on-disk record already
describes; the group kill needs no resident process.
