# Usage events are counted once, keyed by the full session line

Forked and cloned sessions copy their ancestor's entry lines byte-identical
into the new file. A scan that sums every file would count the shared
history once per fork. Each usage event is therefore counted once per
distinct line: the scan keeps the set of full JSONL lines that carried a
usage event and counts a line only the first time it appears.

## Considered options

- **Entry `id`.** Entry ids are 8 hex chars and random; they collide across
  unrelated sessions, so an id alone cannot tell a copy from a collision.
- **The `parentSession` header.** It names one parent, not the whole copied
  chain, and older forks may lack it.
- **`(session id, entry id)` pairs.** A fork is a different session, so the
  pair does not merge the copy with the original.

## Consequences

- Counting depends on pi writing fork copies byte-identical. If that ever
  changes, the dedupe silently overcounts instead of undercounting; a test
  on a fork fixture guards the invariant.
- Two truly distinct events with identical bytes would merge. In practice an
  event line carries a random entry id, so identical bytes mean a copy.
