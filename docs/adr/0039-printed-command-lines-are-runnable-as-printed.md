# Every command line a tool prints is runnable as printed

Issue #135: the sync extension tells a user to run
`scripts/setup-sync-wizard.sh`, a path that is relative to the source
checkout. Nobody runs it from the checkout. pi installs a package into a
directory the user does not choose and often does not know: a git source is
cloned under pi's git directory, an npm source lands under pi's npm root, and
a local source stays where it is. pi also never links a package's `bin`
entries onto `PATH`, so `pi-sync` is unreachable by name for every managed
install, git or npm. A printed path that resolves from no working directory
the user is standing in is not a fix; it is a second failure one step later.

**Every command line a tool prints must be pasteable into a shell from any
working directory.** That covers error messages, help text, and a wizard's
own closing advice, in the CLI and in the TUI alike. A slash command named in
a message (`/sync init`) already satisfies the rule: it is runnable where it
is shown.

**The path is derived from the module's own location at runtime.** A module
knows its own file, so it can walk up to its Install root and name anything
the package ships. `skill-migrate` already derives its root this way. The
printed form is absolute and shell-quoted when the path needs quoting:
`bash <abs>/scripts/setup-sync-wizard.sh` for the Account setup script, and
`node <abs>/extensions/sync/cli.mjs <verb>` for the CLI, because a package
install can lose the script's exec bit while `bash <path>` never cares. A
program that prints a path to a file it ships checks that the file is present
when it builds the message, and says so plainly when it is not.

**Considered options.** Hardcoding the install path (`~/.pi/agent/git/...`)
is wrong for npm and local installs, and breaks when pi changes its layout or
the user relocates the agent directory. Probing `PATH` for `pi-sync` and
printing the bare name when it resolves adds a moving part that can still be
wrong (an alias, a wrapper, a hand-added `node_modules/.bin`), and prints
different text on two machines for no gain. An override environment variable
puts the user to work fixing a mistake the tool made. Telling the user to put
the bin on `PATH` is the same mistake, moved.

**Consequences.** Machine-generated command lines are longer than the short
`pi-sync init` spelling, so the docs keep `pi-sync` as the tool's name in
prose and show the runnable absolute form once, with the docs placeholder
`<install>` defined as the Install root. `bash` becomes a documented
requirement of Account setup: the script is bash, and the fallback advice
(`PI_SYNC_OAUTH_CLIENT_ID`) is already printed beside it. The rule is
repo-wide, but this change touches sync only: no other extension prints an
unrunnable command line today.
