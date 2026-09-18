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
	"quota-detail": [
		"ChatGPT plan quota",
		"Plan: plus",
		"Account: julian@example.com",
		"5h  42%   resets 19:00 (in 5h)",
		"7d  18%   resets Thu 14:00 (in 7d)",
		"Fetched: 13:56:00 (4m ago)",
		"Press Enter or Esc to close",
	],
	"quota-footer": ["GPT 5h 42% · 7d 18%"],
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
		"ctx: 1.3K (1.0%) - uses: 30d",
		"1,272  100.0%  1.0%",
		"375.0/u",
	],
	tools: [
		"Tool Configuration",
		"Tag = extension or SDK origin. No tag = built-in.",
		"→ read                     enabled",
		"resource_toggle (index)  enabled",
		"web_search (web-search)  enabled",
	],
	resources: [
		"pi resources",
		"Extensions",
		">  [x] codegraph  global  /home/julian/.pi/agent/extensions/codegraph/index.ts",
		"[ ] usage  global  /home/julian/.pi/agent/extensions/usage/index.ts",
		"[x] lint-gate  project  /home/julian/acme/.pi/extensions/lint-gate/index.",
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
	"pruning-settings": [
		"pruning: enabled=true, minResultTokens=1000, protectCurrentTurn=true",
		"state: no outputs pruned yet; last gate: none",
	],
	"compress-status": ["3 spans, 12.4k saved"],
	"codegraph-status": [
		// The status block shows twice: /codegraph both sets the persistent
		// widget and emits an info notification with the same lines.
		"codegraph: /tmp/pi-extensions-capture/codegraph/repo",
		"index: 3 files, 9 nodes, 14 edges",
		"index state: complete",
		"auto-index: on",
	],
	"context-cap": ["Context window capped at 100000 tokens"],
	"model-router-halt": [
		"model-router: usage limit on mock/mock-orig; switched to mock/mock-fallback",
		"Hello! I am the fallback model.",
	],
};
