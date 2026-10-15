#!/usr/bin/env node
/**
 * LSP extension health report.
 *
 * Scans the LSP extension's state directory (the tree of per-project
 * subdirectories, each holding `usage.jsonl`) and reports the standing
 * instrument for ticket #136: is the post-edit diagnostics loop worth its
 * tokens? Every number is read from the per-call log the extension writes
 * beside the project it served; the script never touches a language server
 * itself.
 *
 * The report carries three streams, one per log record kind:
 *
 *   calls        the lsp_diagnostics, lsp_hover, and lsp_references tool
 *                calls: counts by tool, counts by outcome (ok, error,
 *                timeout, refused, dead), the average answer duration, and
 *                the total size of the text the model saw - the token-cost
 *                side of the loop
 *   annotations  the post-edit notes attached to edit and write results:
 *                how many were reported (new diagnostics found) versus
 *                quiet (nothing new), and how many new diagnostics and
 *                errors they named
 *   sweeps       the turn-end sweeps: reported versus quiet, and the new
 *                diagnostics they caught that landed outside the edit tool
 *
 * Next to the streams the report lists the project roots the state
 * directory serves, each with its own counts, so one noisy project cannot
 * hide in the totals; and it counts the per-server stderr logs the
 * extension persists, with the non-empty ones named: a language server
 * that writes stderr on start is usually the explanation for timeouts and
 * dead servers.
 *
 * Usage:
 *
 *   node scripts/lsp-health.mjs [STATE_DIR] [options]
 *
 *   STATE_DIR   the state directory to scan. Default: $PI_CODING_AGENT_DIR/lsp,
 *               else ~/.pi/agent/lsp.
 *
 *   Options (all optional; with none, only the all-time report prints):
 *     --last <Nd|Nw>   also report the trailing window of N days or weeks
 *                      ending now, e.g. --last 7d
 *     --since <date>   also report the window from <date> to now. The date
 *                      is parsed as ISO 8601; a bare YYYY-MM-DD is UTC.
 *     --sessions <dir> the pi sessions tree the follow-up metric reads the
 *                      edit and write calls from. Default: $PI_SESSIONS_DIR,
 *                      else ~/.pi/agent/sessions.
 *     -h, --help       print this help and exit
 *
 * The all-time report always prints; window options add a second report.
 * A record whose timestamp does not parse counts in all-time only.
 *
 * Exit code 0 on success (including an empty state directory), 2 on usage
 * or I/O error. No dependency on pi: plain Node, no third-party packages.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The call outcomes, in report order; anything else counts as "other". */
export const OUTCOMES = ["ok", "error", "timeout", "refused", "dead"];

/**
 * How many of the agent's next edit and write calls after an error
 * annotation count as "the next few calls": a re-edit of an annotated
 * file within this window is the visible payoff of the loop (story 22 of
 * ticket #136).
 */
export const FOLLOW_UP_CALLS = 5;

/**
 * Parse one usage.jsonl line into a log record, or null when the line is
 * blank, is not valid JSON, or is not a record this script understands
 * (it must carry ts, root, and a known kind). The reader ignores malformed
 * and torn lines, so a crash mid-append cannot make the report fail.
 */
export function parseLspLogLine(line) {
	if (!line || !line.trim()) return null;
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed;
	if (typeof record.ts !== "string" || typeof record.root !== "string") return null;
	if (record.kind !== "call" && record.kind !== "annotation" && record.kind !== "sweep") {
		return null;
	}
	return record;
}

/** Every project state directory under `stateDir`, with its log file. */
export function listProjectDirs(stateDir) {
	const out = [];
	let names;
	try {
		names = readdirSync(stateDir);
	} catch {
		return out;
	}
	for (const name of names.sort()) {
		const dir = join(stateDir, name);
		let st;
		try {
			st = statSync(dir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		const file = join(dir, "usage.jsonl");
		try {
			if (!statSync(file).isFile()) continue;
		} catch {
			continue;
		}
		out.push({ dir, name, file });
	}
	return out;
}

/**
 * Every log record in every project directory under `stateDir`, each kept
 * with the project root it came from and its timestamp in milliseconds
 * (undefined when the ISO timestamp does not parse). Malformed lines are
 * skipped.
 */
export function scanStateDir(stateDir) {
	const records = [];
	for (const project of listProjectDirs(stateDir)) {
		let text;
		try {
			text = readFileSync(project.file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const record = parseLspLogLine(line);
			if (!record) continue;
			const tsMs = Date.parse(record.ts);
			const files = Array.isArray(record.files)
				? record.files.filter((f) => typeof f === "string")
				: [];
			records.push({
				kind: record.kind,
				tool: record.tool,
				outcome: record.outcome,
				language: record.language,
				server: record.server,
				root: record.root,
				chars: typeof record.chars === "number" ? record.chars : 0,
				durationMs: typeof record.duration_ms === "number" ? record.duration_ms : undefined,
				newCount: typeof record.new_count === "number" ? record.new_count : 0,
				hasError: record.has_error === true,
				files,
				tsMs: Number.isFinite(tsMs) ? tsMs : undefined,
			});
		}
	}
	return records;
}

/** The stderr log files (server-<label>.stderr.log) under `stateDir`. */
export function listStderrLogs(stateDir) {
	const logs = [];
	for (const project of listProjectDirs(stateDir)) {
		let names;
		try {
			names = readdirSync(project.dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.startsWith("server-") || !name.endsWith(".stderr.log")) continue;
			const file = join(project.dir, name);
			let st;
			try {
				st = statSync(file);
			} catch {
				continue;
			}
			logs.push({ file, server: name.slice("server-".length, -".stderr.log".length), size: st.size });
		}
	}
	return logs;
}

/**
 * The session directory name pi gives a working directory: the resolved
 * path with its leading slash dropped, slashes and colons turned into
 * dashes, wrapped in two dashes on each side (`--home-me--` for
 * /home/me). This is how a project root finds the session files that hold
 * its edit and write calls.
 */
export function piSessionDirName(root) {
	const resolved = resolve(root);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Every session file (*.jsonl) in the session directory of `root`. */
export function listRootSessionFiles(sessionsRoot, root) {
	const dir = join(sessionsRoot, piSessionDirName(root));
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		try {
			if (statSync(file).isFile()) out.push(file);
		} catch {
			continue;
		}
	}
	return out;
}

/**
 * Every edit and write call in the session files of `root`: the assistant
 * tool calls that name the built-in edit and write tools, kept with their
 * target file and timestamp (undefined when unparseable). The calls, not
 * the results, are the unit of "the agent edited again": a call that was
 * rejected still tells what the agent tried next.
 */
export function scanEditEvents(sessionsRoot, root) {
	const events = [];
	for (const file of listRootSessionFiles(sessionsRoot, root)) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.indexOf('"edit"') === -1 && line.indexOf('"write"') === -1) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			const message = record && record.type === "message" ? record.message : undefined;
			if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			const tsMs =
				typeof message.timestamp === "number"
					? message.timestamp
					: record.timestamp
						? Date.parse(record.timestamp)
						: NaN;
			for (const block of message.content) {
				if (!block || block.type !== "toolCall") continue;
				if (block.name !== "edit" && block.name !== "write") continue;
				const args = typeof block.arguments === "object" && block.arguments !== null ? block.arguments : {};
				if (typeof args.path !== "string" || !args.path) continue;
				events.push({ path: args.path, tool: block.name, tsMs: Number.isFinite(tsMs) ? tsMs : undefined });
			}
		}
	}
	return events.sort((a, b) => (a.tsMs ?? 0) - (b.tsMs ?? 0));
}

/**
 * The follow-up metric of ticket #136: of the annotations and sweeps that
 * reported at least one error, how many were acted on - the agent edited
 * one of the named files again within the next `FOLLOW_UP_CALLS` edit or
 * write calls. Read against the token cost, this is the answer to "was it
 * worth it".
 *
 * A record is judged only when it has a timestamp, names files, and the
 * root's session files exist; records that cannot be judged are counted
 * separately, not guessed.
 */
export function correlateFollowUps(records, sessionsRoot) {
	const eventsByRoot = new Map();
	let total = 0;
	let acted = 0;
	let noSessions = 0;
	let untimed = 0;
	for (const r of records) {
		if (r.kind === "call") continue;
		if (r.outcome !== "reported" || !r.hasError || r.files.length === 0) continue;
		if (r.tsMs === undefined) {
			untimed += 1;
			continue;
		}
		if (!eventsByRoot.has(r.root)) {
			const files = listRootSessionFiles(sessionsRoot, r.root);
			if (files.length === 0) {
				eventsByRoot.set(r.root, { missing: true });
			} else {
				eventsByRoot.set(r.root, { events: scanEditEvents(sessionsRoot, r.root) });
			}
		}
		const bucket = eventsByRoot.get(r.root);
		if (bucket.missing) {
			noSessions += 1;
			continue;
		}
		total += 1;
		const targets = new Set(r.files.map((f) => (f.startsWith("/") ? f : join(r.root, f))));
		const later = bucket.events.filter((e) => e.tsMs !== undefined && e.tsMs > r.tsMs);
		const window = later.slice(0, FOLLOW_UP_CALLS);
		// The session files live in the project's working directory, so a
		// relative path in a tool call resolves against the root.
		if (window.some((e) => targets.has(e.path) || targets.has(resolve(r.root, e.path)))) acted += 1;
	}
	return { total, acted, unacted: total - acted, untimed, noSessions };
}

/**
 * Merge the scanned records into the report block shape the renderer
 * consumes:
 *
 *   {
 *     calls:       { total, byTool, byOutcome, avgDurationMs, chars }
 *     annotations: { total, reported, newCount, errors }
 *     sweeps:      { total, reported, newCount }
 *     followUps:   { total, acted, unacted, untimed, noSessions }
 *     projects:    { total, list: [{ root, calls, annotations, sweeps }] }
 *     stderr:      { total, nonEmpty }
 *   }
 */
export function aggregateLspRecords(records, stderrLogs, followUps) {
	const byTool = {};
	const byOutcome = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
	byOutcome.other = 0;
	let callTotal = 0;
	let durationSum = 0;
	let durationN = 0;
	let chars = 0;
	const annotations = { total: 0, reported: 0, newCount: 0, errors: 0 };
	const sweeps = { total: 0, reported: 0, newCount: 0 };
	const projects = new Map();
	for (const r of records) {
		let p = projects.get(r.root);
		if (!p) {
			p = { root: r.root, calls: 0, annotations: 0, sweeps: 0 };
			projects.set(r.root, p);
		}
		if (r.kind === "call") {
			callTotal += 1;
			p.calls += 1;
			if (typeof r.tool === "string" && r.tool) byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
			const outcome = typeof r.outcome === "string" && byOutcome[r.outcome] !== undefined ? r.outcome : "other";
			byOutcome[outcome] += 1;
			if (r.durationMs !== undefined) {
				durationSum += r.durationMs;
				durationN += 1;
			}
			chars += r.chars;
		} else if (r.kind === "annotation") {
			annotations.total += 1;
			p.annotations += 1;
			if (r.outcome === "reported") {
				annotations.reported += 1;
				annotations.newCount += r.newCount;
				if (r.hasError) annotations.errors += 1;
			}
		} else if (r.kind === "sweep") {
			sweeps.total += 1;
			p.sweeps += 1;
			if (r.outcome === "reported") {
				sweeps.reported += 1;
				sweeps.newCount += r.newCount;
			}
		}
	}
	return {
		calls: {
			total: callTotal,
			byTool,
			byOutcome,
			avgDurationMs: durationN > 0 ? Math.round(durationSum / durationN) : undefined,
			chars,
		},
		annotations,
		sweeps,
		followUps: followUps ?? { total: 0, acted: 0, unacted: 0, untimed: 0, noSessions: 0 },
		projects: { total: projects.size, list: [...projects.values()].sort((a, b) => a.root.localeCompare(b.root)) },
		stderr: { total: stderrLogs.length, nonEmpty: stderrLogs.filter((l) => l.size > 0).length, logs: stderrLogs },
	};
}

/** The records in `[fromMs, toMs]`; records with no timestamp are dropped. */
export function filterWindow(records, fromMs, toMs) {
	return records.filter((r) => r.tsMs !== undefined && r.tsMs >= fromMs && r.tsMs <= toMs);
}

/** Parse a `--last` value such as `7d` or `2w` into milliseconds. */
export function parseLastWindow(spec) {
	const m = /^(\d+)([dw])$/.exec(spec);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2] === "d" ? 86_400_000 : 7 * 86_400_000;
	return n * unit;
}

/** Environment variable that points the scan at another state directory. */
export const STATE_DIR_ENV = "PI_CODING_AGENT_DIR";

/** The state root: $PI_CODING_AGENT_DIR/lsp, else ~/.pi/agent/lsp. */
export function defaultStateRoot(env = process.env) {
	const base = env[STATE_DIR_ENV] || join(homedir(), ".pi", "agent");
	return join(base, "lsp");
}

/** Environment variable that points the follow-up scan at another sessions tree. */
export const SESSIONS_DIR_ENV = "PI_SESSIONS_DIR";

/** The sessions root: $PI_SESSIONS_DIR, else ~/.pi/agent/sessions. */
export function defaultSessionsRoot(env = process.env) {
	return env[SESSIONS_DIR_ENV] || join(homedir(), ".pi", "agent", "sessions");
}

function renderCalls(lines, calls) {
	if (calls.total === 0) {
		lines.push("  calls:       0");
		return;
	}
	const tools = Object.entries(calls.byTool)
		.sort((a, b) => b[1] - a[1])
		.map(([tool, n]) => `${tool} ${n}`)
		.join(", ");
	lines.push(`  calls:       ${calls.total} (${tools})`);
	const outcomes = OUTCOMES.map((o) => [o, calls.byOutcome[o]]);
	if (calls.byOutcome.other > 0) outcomes.push(["other", calls.byOutcome.other]);
	const shown = outcomes
		.filter(([, n]) => n > 0)
		.map(([o, n]) => `${o} ${n}`)
		.join(", ");
	lines.push(`  outcomes:    ${shown || "none"}`);
	if (calls.avgDurationMs !== undefined) lines.push(`  avg answer:  ${calls.avgDurationMs} ms`);
	lines.push(`  model saw:   ${calls.chars} chars of results`);
}

function renderStream(lines, label, stats, hasErrors) {
	const reported = `${stats.reported} reported, ${stats.total - stats.reported} quiet`;
	const tail = hasErrors ? `, ${stats.errors} with errors` : "";
	lines.push(`  ${label.padEnd(12)} ${stats.total} (${reported}, ${stats.newCount} new diagnostics${tail})`);
}

function renderFollowUps(lines, stats) {
	if (stats.total === 0 && stats.untimed === 0 && stats.noSessions === 0) return;
	if (stats.total === 0) {
		lines.push(`  follow-ups:  not judged (${stats.noSessions} without session files, ${stats.untimed} untimed)`);
		return;
	}
	lines.push(`  follow-ups:  ${stats.acted} of ${stats.total} error annotations acted on (re-edit within ${FOLLOW_UP_CALLS} calls)`);
}

function renderBlock(label, stats) {
	const lines = [label];
	if (stats.calls.total === 0 && stats.annotations.total === 0 && stats.sweeps.total === 0) {
		lines.push("  (no lsp activity)");
		return lines;
	}
	renderCalls(lines, stats.calls);
	renderStream(lines, "annotations:", stats.annotations, true);
	renderStream(lines, "sweeps:", stats.sweeps, false);
	renderFollowUps(lines, stats.followUps);
	if (stats.stderr.total > 0) {
		lines.push(`  server logs: ${stats.stderr.total} stderr logs, ${stats.stderr.nonEmpty} non-empty`);
		for (const log of stats.stderr.logs.filter((l) => l.size > 0)) {
			lines.push(`    ${log.server} (${Math.ceil(log.size / 1024)} KiB)`);
		}
	}
	if (stats.projects.list.length > 1) {
		lines.push("  projects:");
		for (const p of stats.projects.list) {
			lines.push(`    ${p.root}: ${p.calls} calls, ${p.annotations} annotations, ${p.sweeps} sweeps`);
		}
	}
	return lines;
}

function isoDay(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

export function usage() {
	return [
		"Usage: node scripts/lsp-health.mjs [STATE_DIR] [options]",
		"",
		"STATE_DIR   the LSP state directory (per-project usage.jsonl logs)",
		"            default: $PI_CODING_AGENT_DIR/lsp, else ~/.pi/agent/lsp",
		"  --last <Nd|Nw>   also report the trailing window of N days or weeks",
		"  --since <date>   also report the window from <date> (ISO 8601) to now",
		"  --sessions <dir> sessions tree for the follow-up metric",
		"  -h, --help       print this help",
	].join("\n");
}

export async function main(argv) {
	let root;
	let sessionsRoot;
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
				process.stderr.write(`lsp-health: invalid --last value: ${spec ?? "(missing)"} (want e.g. 7d or 2w)\n`);
				return 2;
			}
			windows.push({ fromMs: Date.now() - ms, toMs: Date.now(), label: `last ${spec}` });
			continue;
		}
		if (arg === "--since") {
			const spec = argv[++i];
			const fromMs = spec ? Date.parse(spec) : NaN;
			if (!Number.isFinite(fromMs)) {
				process.stderr.write(`lsp-health: invalid --since date: ${spec ?? "(missing)"} (want ISO 8601)\n`);
				return 2;
			}
			windows.push({ fromMs, toMs: Date.now(), label: `since ${spec}` });
			continue;
		}
		if (arg === "--sessions") {
			const spec = argv[++i];
			if (spec === undefined) {
				process.stderr.write(`lsp-health: --sessions expects a directory\n`);
				return 2;
			}
			sessionsRoot = spec;
			continue;
		}
		if (arg.startsWith("-")) {
			process.stderr.write(`lsp-health: unknown option: ${arg}\n\n${usage()}\n`);
			return 2;
		}
		if (root !== undefined) {
			process.stderr.write("lsp-health: expected at most one STATE_DIR argument\n");
			return 2;
		}
		root = arg;
	}
	if (root === undefined) root = defaultStateRoot();
	if (sessionsRoot === undefined) sessionsRoot = defaultSessionsRoot();

	const records = scanStateDir(root);
	const stderrLogs = listStderrLogs(root);
	const followUps = correlateFollowUps(records, sessionsRoot);
	const lines = [`LSP health`, `state:    ${root}`, `sessions: ${sessionsRoot}`, `projects: ${new Set(records.map((r) => r.root)).size} with activity`, ""];
	lines.push(...renderBlock("all time", aggregateLspRecords(records, stderrLogs, followUps)));
	for (const w of windows) {
		lines.push("");
		lines.push(
			...renderBlock(
				`${w.label} (${isoDay(w.fromMs)} .. ${isoDay(w.toMs)})`,
				aggregateLspRecords(filterWindow(records, w.fromMs, w.toMs), [])
			)
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(err) => {
			process.stderr.write(`lsp-health: ${err && err.message ? err.message : String(err)}\n`);
			process.exitCode = 2;
		},
	);
}
