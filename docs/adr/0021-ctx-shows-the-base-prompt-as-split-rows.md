# /ctx shows the default base prompt as split rows

The /ctx report lumped the whole default base prompt into one row, so the
Prompt snippets and Prompt guidelines that tools register were invisible as
such: their cost was in the token count, but a reader could not tell which
guideline or snippet it was, or who registered it.

The default base prompt now renders as separate rows: one `base prompt` row
holding the boilerplate (the identity line, the custom-tools line, and the
pi documentation block), one `available tools` row carrying all Prompt
snippets, and one row per Prompt guideline, each attributed to its source
(`builtin` for pi's default bullets, `extension` for the rest). Token
totals do not change: the total still estimates the prompt as the one unit
the provider sees, and the report total of a session is unchanged. A
custom prompt stays a single row.

The governing invariant: the section texts concatenate to the exact base
prompt. Prompt-injection detection compares the sent system prompt with
that concatenation, so an unmodified session must still report no
injection and an extension-modified prompt must still be detected. The
boilerplate therefore lives in the gaps the split rows fill: it is three
section pieces under one key, and the report merges them into the single
`base prompt` row.

## Considered options

- **One row, unchanged.** Simplest, but the snippet and guideline cost
  stays invisible.
- **Split rows without the exact-concatenation invariant.** Simpler row
  construction, but injection detection would need a second, parallel
  reconstruction and the two could drift.
- **Split rows with the invariant (chosen).** The boilerplate is stored
  around the split pieces; the merge is a single-key join at report time.

## Consequences

- The row kind set gains `tools` and `guideline`; both carry a dash in the
  usage columns, like the other section rows.
- The report row for the boilerplate holds the boilerplate text with the
  snippet and guideline bullets removed; expanding it shows that text, not
  the full prompt.
- A registered guideline identical to a pi default bullet keeps the
  `builtin` source (it is the default bullet, and dedup keeps the first
  occurrence in prompt order).
