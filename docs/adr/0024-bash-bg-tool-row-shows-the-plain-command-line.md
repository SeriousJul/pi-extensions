# bash_bg tool row shows the plain command line

The bash_bg tool row (the TUI entry for the call in an agent turn) showed
only the bold tool name, with the command visible nowhere in the row. The row
now renders the command as `$ <command>`, the same line shape as the
built-in bash row, with no background marker. The tool name "Bash
background" already says the command is backgrounded, and the command line
is the true intent.

**Considered options**: a `$ <command> &` suffix, faithful to the shell but
repeating what the tool name already says; a `bg $ <command>` prefix, which
breaks the `$` line shape the operator scans across the bash rows beside it.
Both were rejected in favor of the plain line.
