# Triage Labels

This repo's issue tracker speaks in terms of five canonical triage roles.
The label strings below are the vocabulary it uses; edit this file to
match whatever vocabulary you actually use.

| Label            | Meaning                                  |
| ---------------- | ---------------------------------------- |
| `needs-triage`   | Maintainer needs to evaluate this issue  |
| `needs-info`     | Waiting on reporter for more information |
| `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | Requires human implementation          |
| `wontfix`        | Will not be actioned                     |

When a workflow mentions a role (e.g. "apply the AFK-ready triage label"),
use the corresponding label string from this table.

The role vocabulary is inherited from the triage skill of the
mattpocock/skills source, which the addyosmani source replaced (#138).
The label strings stay this repo's own.
