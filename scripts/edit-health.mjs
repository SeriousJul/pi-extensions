#!/usr/bin/env node
/**
 * Edit tool health report.
 *
 * Scans a pi session directory (the tree of per-working-directory
 * subdirectories holding `*.jsonl` session files) and reports the health of
 * the built-in `edit` tool: total calls, failure count, and failure rate,
 * broken down by failure class. It is the before/after instrument for the
 * Edit assist extension (ADR 0020): run it on the same window before and
 * after the extension to see whether the failure rate fell.
 *
 * A call is one `toolResult` record with `toolName: "edit"` in a session
 * file; a failure is one with `isError: true`. Every failure is classified:
 *
 *   no-match    "Could not find ..." - the oldText does not appear in the
 *               file (the dominant class: the model re-typed oldText with a
 *               small error, usually leading whitespace)
 *   ambiguous   "Found N occurrences ..." - the oldText appears more than
 *               once, so the call is rejected
 *   validation  invalid arguments: pi's schema validation error
 *               ("Validation failed for tool \"edit\""), "Edit tool input is
 *               invalid", or the rejected-overlap error ("edits[i] and
 *               edits[j] overlap")
 *   other       everything else: missing file (ENOENT), no-op replacement
 *               ("No changes made ... identical content"), the call being
 *               blocked before execution (output-token-limit truncation,
 *               tool-call-loop guard)
 *
 * Usage:
 *
 *   node scripts/edit-health.mjs [SESSIONS_DIR] [options]
 *
 *   SESSIONS_DIR   the sessions tree to scan. Default: the
 *                  $PI_SESSIONS_DIR environment variable, else
 *                  ~/.pi/agent/sessions.
 *
 *   Options (all optional; with none, only the all-time report prints):
 *     --last <Nd|Nw>   also report the trailing window of N days or weeks
 *                      ending now, e.g. --last 7d
 *     --since <date>   also report the window from <date> to now. The date
 *                      is parsed as ISO 8601; a bare YYYY-MM-DD is UTC.
 *     -h, --help       print this help and exit
 *
 * The all-time report always prints; window options add a second report.
 * A call whose record carries no parseable timestamp counts in all-time
 * only.
 *
 * Exit code 0 on success (including zero edit calls), 2 on usage or I/O
 * error. No dependency on pi: plain Node, no third-party packages.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The failure classes, in report order. */
export const FAILURE_CLASSES = ["no-match", "ambiguous", "validation", "other"];

/**
 * Classify an edit tool failure by its result text. The observed message
 * patterns are mutually exclusive, so order only matters in that the three
 * named classes get their patterns before the "other" catch-all.
 */
export function classifyEditFailure(text) {
	if (/Could not find /.test(text)) return "no-match";
	if (/Found \d+ occurrences /.test(text)) return "ambiguous";
	if (
		/^Validation failed for tool "edit"/.test(text) ||
		/^Edit tool input is invalid/.test(text) ||
		/overlap in /.test(text)
	) {
		return "validation";
	}
	return "other";
}

/**
 * Extract one edit call from a parsed session record, or undefined when the
 * record is not an edit tool result. Returns:
 *
 *   { tsMs: number | undefined, isError: boolean, text: string }
 *
 * `tsMs` is the result timestamp in milliseconds, from the message's numeric
 * `timestamp` field with the record's ISO `timestamp` as fallback, and
 * undefined when neither parses.
 */
export function extractEditResult(record) {
	if (!record || record.type !== "message") return undefined;
	const message = record.message;
	if (!message || message.role !== "toolResult" || message.toolName !== "edit") {
		return undefined;
	}
	const text = resultText(message.content);
	let tsMs =
		typeof message.timestamp === "number"
			? message.timestamp
			: record.timestamp
				? Date.parse(record.timestamp)
				: NaN;
	if (!Number.isFinite(tsMs)) tsMs = undefined;
	return { tsMs, isError: message.isError === true, text };
}

/** The error/success text of a tool result, whatever shape content has. */
function resultText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/**
 * Aggregate a stream of extractEditResult() values into a report block:
 *
 *   { total, failures: { total, byClass: { "no-match": n, ... } } }
 */
export function aggregateEditResults(results) {
	const byClass = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0]));
	let total = 0;
	let failures = 0;
	for (const r of results) {
		if (!r) continue;
		total += 1;
		if (r.isError) {
			failures += 1;
			byClass[classifyEditFailure(r.text)] += 1;
		}
	}
	return { total, failures: { total: failures, byClass } };
}

/** Environment variable that points the scan at another sessions tree. */
export const SESSIONS_DIR_ENV = "PI_SESSIONS_DIR";

/** The sessions root: the env override, else `~/.pi/agent/sessions`. */
export function defaultSessionsRoot(env = process.env) {
	return env[SESSIONS_DIR_ENV] || join(homedir(), ".pi", "agent", "sessions");
}

/**
 * Every session file in the tree. A missing root, a missing subdirectory,
 * or a file that vanished mid-walk is skipped, so a walk never throws on a
 * half-written tree.
 */
export function listSessionFiles(root) {
	const out = [];
	let dirNames;
	try {
		dirNames = readdirSync(root);
	} catch {
		return out;
	}
	for (const dirName of dirNames) {
		const dir = join(root, dirName);
		let st;
		try {
			st = statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			out.push(join(dir, name));
		}
	}
	return out;
}

/**
 * Every edit call in every session file under `root`. Malformed lines are
 * skipped, so a half-written session file degrades to the lines already
 * complete.
 */
export function scanSessions(root) {
	const out = [];
	for (const file of listSessionFiles(root)) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (!line || line.indexOf('"toolName":"edit"') === -1) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			const result = extractEditResult(record);
			if (result) out.push(result);
		}
	}
	return out;
}

/** The calls in `[fromMs, toMs]`; calls with no timestamp are dropped. */
export function filterWindow(results, fromMs, toMs) {
	return results.filter((r) => r.tsMs !== undefined && r.tsMs >= fromMs && r.tsMs <= toMs);
}

/** Parse a `--last` value such as `7d` or `2w` into milliseconds. */
export function parseLastWindow(spec) {
	const m = /^(\d+)([dw])$/.exec(spec);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2] === "d" ? 86_400_000 : 7 * 86_400_000;
	return n * unit;
}

/** Render one report block (header line plus indented stats). */
function renderBlock(label, stats) {
	const lines = [label];
	if (stats.total === 0) {
		lines.push("  (no edit calls)");
		return lines;
	}
	lines.push(`  calls:    ${stats.total}`);
	lines.push(`  failures: ${stats.failures.total} (${pct(stats.failures.total / stats.total)})`);
	for (const cls of FAILURE_CLASSES) {
		const n = stats.failures.byClass[cls];
		const share = stats.failures.total > 0 ? ` (${pct(n / stats.failures.total)} of failures)` : "";
		lines.push(`  ${cls.padEnd(11)} ${String(n).padStart(5)}${share}`);
	}
	return lines;
}

function pct(x) {
	return `${(x * 100).toFixed(2)}%`;
}

function isoDay(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

export function usage() {
	return [
		"Usage: node scripts/edit-health.mjs [SESSIONS_DIR] [options]",
		"",
		"SESSIONS_DIR   default: $PI_SESSIONS_DIR, else ~/.pi/agent/sessions",
		"  --last <Nd|Nw>   also report the trailing window of N days or weeks",
		"  --since <date>   also report the window from <date> (ISO 8601) to now",
		"  -h, --help       print this help",
	].join("\n");
}

export async function main(argv) {
	let root;
	const windows = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(`${usage()}\n`);
			return 0;
		}
		if (arg === "--last") {
			const spec = argv[++i];
			const ms = spec !== undefined ? parseLastWindow(spec) : undefined;
			if (ms === undefined) {
				process.stderr.write(`edit-health: invalid --last value: ${spec ?? "(missing)"} (want e.g. 7d or 2w)\n`);
				return 2;
			}
			windows.push({ fromMs: Date.now() - ms, toMs: Date.now(), label: `last ${spec}` });
			continue;
		}
		if (arg === "--since") {
			const spec = argv[++i];
			const fromMs = spec ? Date.parse(spec) : NaN;
			if (!Number.isFinite(fromMs)) {
				process.stderr.write(`edit-health: invalid --since date: ${spec ?? "(missing)"} (want ISO 8601)\n`);
				return 2;
			}
			windows.push({ fromMs, toMs: Date.now(), label: `since ${spec}` });
			continue;
		}
		if (arg.startsWith("-")) {
			process.stderr.write(`edit-health: unknown option: ${arg}\n\n${usage()}\n`);
			return 2;
		}
		if (root !== undefined) {
			process.stderr.write("edit-health: expected at most one SESSIONS_DIR argument\n");
			return 2;
		}
		root = arg;
	}
	if (root === undefined) root = defaultSessionsRoot();

	const results = scanSessions(root);
	const lines = [`Edit tool health`, `sessions: ${root}`, ""];
	lines.push(...renderBlock("all time", aggregateEditResults(results)));
	for (const w of windows) {
		lines.push("");
		lines.push(...renderBlock(`${w.label} (${isoDay(w.fromMs)} .. ${isoDay(w.toMs)})`, aggregateEditResults(filterWindow(results, w.fromMs, w.toMs))));
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`edit-health: ${err && err.message ? err.message : String(err)}\n`);
			process.exitCode = 2;
		},
	);
}
