/**
 * Spill: the lossless file copy of a result the Bound cut.
 *
 * A Spill lives under the agent directory beside the sessions, which is
 * already private (decision 20): `<agentDir>/output-limits/<session-id>/`.
 * One call gets one file, named `<seq>-<tool>-<callid8>.log`, mode 0600 in a
 * directory at 0700. There is no reader tool: the agent has bash, and `rg`
 * over one bounded file is the case that matters (decision 10).
 *
 * Fidelity, stated exactly (ADR 0026). A Spill holds everything the hook
 * received, which is not always everything the tool produced. For bash the
 * hook receives `details.fullOutputPath`, pi's own log of the command's whole
 * output, so this module moves that file into the Spill directory and adopts
 * it as the Spill: one call, one complete file, never two files for one call
 * (decision 9). Nothing is appended to it, because pi's log is a superset of
 * the text the hook received, and copying that text in again would double the
 * file to state nothing new. For grep, find, and ls pi has already dropped the
 * tail past its own 50KB before the hook runs, so their Spill holds pi's result
 * and the user's loss becomes one preserved cut rather than two unpreserved
 * ones.
 *
 * Lossless or no cut (decision 19): every write here returns a failure rather
 * than throwing, and the wiring treats a failure as "do not bound at all". A
 * disk-full run costs context instead of losing text.
 */
import fs from "node:fs";
import path from "node:path";

/** The Spill root for one session. */
export function spillDir(agentDir: string, sessionId: string): string {
	return path.join(agentDir, "output-limits", sessionId);
}

/** The whole extension Spill root, which is what the sweep governs. */
export function spillRoot(agentDir: string): string {
	return path.join(agentDir, "output-limits");
}

export type SpillWrite = { ok: true; path: string; bytes: number; adopted: boolean } | { ok: false; error: string };

/**
 * Write one Spill file.
 *
 * `adoptPath` is pi's own throwaway log for a bash cut. It holds the command's
 * whole output, including the part pi dropped, so it is moved into the Spill
 * directory and becomes the Spill: pi's throwaway is not left behind, and one
 * call has one complete file. The result text the hook received is NOT appended
 * after it, because the log already contains it.
 *
 * Without `adoptPath` the file is the result text, which is all the hook has.
 * A pre-existing file is appended to, never truncated, so a re-run of the same
 * call id cannot lose what the first run wrote.
 */
export function writeSpill(dir: string, name: string, text: string, adoptPath?: string): SpillWrite {
	const target = path.join(dir, name);
	try {
		mkdirPrivate(dir);
		if (adoptPath && adoptPath !== target && fs.existsSync(adoptPath)) {
			fs.renameSync(adoptPath, target);
			fs.chmodSync(target, 0o600);
			return { ok: true, path: target, bytes: fs.statSync(target).size, adopted: true };
		}
		if (fs.existsSync(target)) {
			fs.appendFileSync(target, text, { encoding: "utf8", mode: 0o600 });
		} else {
			fs.writeFileSync(target, text, { encoding: "utf8", mode: 0o600 });
			fs.chmodSync(target, 0o600);
		}
		return { ok: true, path: target, bytes: fs.statSync(target).size, adopted: false };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Create a directory at 0700, and force the mode on a directory that
 * already existed: `recursive: true` applies the mode only when it creates. */
export function mkdirPrivate(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
}

export interface SweepLimits {
	maxTotalBytes: number;
	maxAgeDays: number;
}

export interface SweepReport {
	removed: number;
	bytesFreed: number;
}

interface SpillFile {
	dir: string;
	name: string;
	fullPath: string;
	size: number;
	mtimeMs: number;
}

/**
 * Sweep the extension's own Spill root, at session start.
 *
 * Two limits, in that order: everything older than `maxAgeDays` goes, then
 * the oldest files go until what is left reaches `maxTotalBytes`. Newest
 * first survives, so the files the current session can still name in a
 * notice are the last ones dropped.
 *
 * The sweep never leaves the extension's own directory: pi's own
 * `/tmp/pi-bash-*.log` files are out of scope (ADR 0026 accepted cost).
 */
export function sweepSpills(root: string, limits: SweepLimits): SweepReport {
	const report: SweepReport = { removed: 0, bytesFreed: 0 };
	let files: SpillFile[];
	try {
		files = listSpillFiles(root);
	} catch {
		return report;
	}
	const now = Date.now();
	const maxAgeMs = limits.maxAgeDays * 24 * 60 * 60 * 1000;
	const keep: SpillFile[] = [];
	for (const file of files) {
		if (maxAgeMs > 0 && now - file.mtimeMs > maxAgeMs) {
			if (remove(file, report)) continue;
		}
		keep.push(file);
	}
	keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
	let total = keep.reduce((sum, file) => sum + file.size, 0);
	for (const file of keep) {
		if (limits.maxTotalBytes > 0 && total <= limits.maxTotalBytes) break;
		if (!remove(file, report)) continue;
		total -= file.size;
	}
	return report;
}

function remove(file: SpillFile, report: SweepReport): boolean {
	try {
		fs.rmSync(file.fullPath, { force: true });
		report.removed += 1;
		report.bytesFreed += file.size;
		return true;
	} catch {
		return false;
	}
}

function listSpillFiles(root: string): SpillFile[] {
	const files: SpillFile[] = [];
	if (!fs.existsSync(root)) return files;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			const dir = path.join(root, entry.name);
			for (const name of fs.readdirSync(dir)) {
				const fullPath = path.join(dir, name);
				let stat: fs.Stats;
				try {
					stat = fs.statSync(fullPath);
				} catch {
					continue;
				}
				if (stat.isFile()) files.push({ dir, name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
			}
			continue;
		}
		if (!entry.isFile()) continue;
		const fullPath = path.join(root, entry.name);
		const stat = fs.statSync(fullPath);
		files.push({ dir: root, name: entry.name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
	}
	return files;
}

/** The footprint of one session's Spill directory: `status` reports it. */
export function spillFootprint(dir: string): { files: number; bytes: number } {
	const report = { files: 0, bytes: 0 };
	try {
		if (!fs.existsSync(dir)) return report;
		for (const name of fs.readdirSync(dir)) {
			const stat = fs.statSync(path.join(dir, name));
			if (!stat.isFile()) continue;
			report.files += 1;
			report.bytes += stat.size;
		}
	} catch {
		// A footprint read is informational: an unreadable directory reads 0.
	}
	return report;
}

/** One Spill file name: `<seq>-<tool>-<callid8>.log`. */
export function spillName(seq: number, toolName: string, callId: string): string {
	return `${seq}-${toolName}-${callId.slice(0, 8)}.log`;
}
