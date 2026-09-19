# /ctx flags guidelines that duplicate tool descriptions

A tool's JSON description is resent on every LLM call as part of the tool
entry. A Prompt guideline that merely restates that description adds cost
without adding information, and a reader of the /ctx report has no way to
see the overlap.

After the session has at least one provider request, a guideline row whose
text largely restates a sent tool description shows a
`duplicates tool description` note, in both the text table and the TUI.
Before the first provider request, rows show with no flag. The comparison
runs against the tool descriptions from the last captured provider request
- the text actually sent - never against a rebuilt schema.

Detection rule: normalize both sides (lowercase, punctuation stripped,
spaces collapsed) and flag when the longest common substring between the
guideline and any captured tool description is at least 80 percent of the
guideline's normalized length and at least 24 characters. The threshold is
deliberately conservative: it catches the verbatim and prefixed-verbatim
shapes, misses paraphrases in v1, and avoids false positives that would
train the reader to ignore the flag.

Prompt snippets are never flagged: a one-line restatement of the tool is
the design of the available-tools section, so flagging them means flagging
nearly all of them.

## Considered options

- **No flag.** The cost is visible in the numbers, but the overlap is not.
- **Semantic or embedding similarity.** Catches paraphrases, but needs a
  model call or a bundled model in a pure, offline core, and the result
  moves with the model.
- **Keyword overlap.** Cheap, but false positives on common words.
- **Conservative longest-common-substring (chosen).** Pure text,
  deterministic, and the miss profile is known: paraphrases.

## Consequences

- The flag appears only after the first call; a session at zero calls
  shows the same rows without the note.
- A guideline that adds trigger conditions (when to use the tool) around a
  short quote of the description stays unflagged, because the shared part
  falls under the 80 percent share.
- The note rides the row's existing `note` field, so the text table and
  the TUI pick it up from the same place; the TUI clips long guideline
  labels to keep the note whole.
- The rule's constants (80 percent share, 24-character floor) are the
  seam for loosening detection in a later version.
