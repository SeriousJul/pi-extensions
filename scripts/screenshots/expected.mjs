/**
 * Expected screen content for every capture (issue #73, spec seam 3,
 * ADR 0017).
 *
 * Each entry is a list of lines the settled screen must show. Comparison is
 * trimmed, substring, in any order - the same rule the golden test applies.
 * capture.mjs asserts them after every run, so a live pty capture that
 * loses its content fails the pipeline instead of re-blessing a broken
 * image; the golden test asserts them for the fast captures as well.
 */
export const EXPECTED_LINES = {
	"usage-tui": [
		"pi usage",
		"b week   w all   g provider+model   s time   c full   p none   m none",
		"9 events · all time",
		"TOTAL                                 1325      200      100      625       50     2900    $0.10",
	],
	"usage-cli": [
		"2026-09 · week · provider+model · sort: time · 6 events",
		"TOTAL                                      1,325          300          625        2,300        $0.08",
	],
	"initial-context": [
		"initial context",
		"ctx: 1.7K (1.3%) - uses: 30d",
		"base prompt",
		"available tools",
		"Only talk using ASD-STE100 Simplified Te  extension",
		"Be concise in your responses",
		"375.0/u",
		"1,660  100.0%  1.3%",
	],
	tools: [
		"Tool Configuration",
		"Tag = Tool origin. No tag = built-in.",
		// The list pads labels to the widest one (resource_toggle's extension
		// tag, ADR 0045) before the two-cell separator and the value.
		"→ read" + " ".repeat(31) + "enabled",
		"resource_toggle (resource-toggle)  enabled",
		"web_search (web-search)" + " ".repeat(12) + "enabled",
	],
	resources: [
		"pi resources",
		"Extensions",
		">  [x] codegraph  global  /home/julian/.pi/agent/extensions/codegraph/index.ts",
		"Semantic code search and code map for the current project.",
		"[ ] usage  global  /home/julian/.pi/agent/extensions/usage/index.ts",
		"Report token and cost usage across pi sessions.",
		"[x] lint-gate  project  /home/julian/acme/.pi/extensions/lint-gate/index.",
		"Refuse commits that fail the project lint rules.",
		"Skills",
		"Themes",
	],
	"sync-view": [
		"pi sync",
		"pi sync status (gist 9f2c41ab)",
		"ahead 0, behind 0",
		"in sync",
	],
	"sync-status": ["pi sync status (gist 9f2c41ab)", "ahead 0, behind 0", "in sync"],
	"codegraph-status": [
		// The status block shows once, as the info notification in the
		// transcript; /codegraph no longer sets the persistent widget (#80).
		"codegraph: /tmp/pi-extensions-capture/codegraph/repo",
		"index: 3 files, 9 nodes, 14 edges",
		"index state: complete",
		"auto-index: on",
	],
	"context-cap": ["Context window capped at 100000 tokens"],
	"lsp-status": [
		"lsp: /tmp/pi-extensions-capture/lsp/repo",
		"project: trusted",
		"TypeScript: not started - tsc",
		"C/C++: absent - clangd not found on PATH",
		"Rust: absent - rust-analyzer not found on PATH",
		"Python: absent - basedpyright or pyright not found on PATH",
		"Go: absent - gopls not found on PATH",
		"watcher: off (no running server)",
		"Press Enter or Esc to close",
	],
	"model-router-halt": [
		"model-router: usage limit on mock/mock-orig; switched to mock/mock-fallback",
		"Hello! I am the fallback model.",
	],
	"tool-headers": [
		// The header lines are the point of the extension: the tool name and
		// its Origin tag set in a rule above each call line.
		"── read · built-in ──",
		"── note_search · note-search ──",
		"read note.txt",
		'note_search query="tool row headers"',
		"$ sleep 0.2; echo greeting",
		"greeting",
		"1 note: tool row headers",
		"Took 0.2s",
		"Done.",
	],
	"tool-headers-before": [
		// The same session without the extension: the rows name nothing, which
		// is exactly what the header fixes. No `── … ──` line may be asserted.
		"read note.txt",
		'note_search query="tool row headers"',
		"$ sleep 0.2; echo greeting",
		"greeting",
		"1 note: tool row headers",
		"Took 0.2s",
		"Done.",
	],
};
