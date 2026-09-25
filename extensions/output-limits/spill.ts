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
 * file to state nothing new. The move is a rename when the two directories
 * share a device and a copy when they do not, which is the common case: `/tmp`
 * is usually its own filesystem and the Spill root sits beside the sessions.
 * For grep, find, and ls pi has already dropped the tail past its own 50KB
 * before the hook runs, so their Spill holds pi's result and the user's loss
 * becomes one preserved cut rather than two unpreserved ones.
 *
 * Lossless or no cut (decision 19): every write here returns a failure rather
 * than throwing, and the wiring treats a failure as "do not bound at all". A
 * disk-full run costs context instead of losing text. A device boundary is not
 * a failure: pi's log is copied when it cannot be renamed.
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

export type SpillWrite =
	| { ok: true; path: string; bytes: number; adopted: boolean; sourcePath: string | undefined }
	| { ok: false; error: string };

/**
 * The file operations that move pi's throwaway, injected so a test can make
 * the move fail the way a real device boundary does.
 */
export interface SpillMove {
	exists: (path: string) => boolean;
	rename: (from: string, to: string) => void;
	copy: (from: string, to: string) => void;
	remove: (path: string) => void;
}

const DEVICE_MOVE: SpillMove = {
	exists: (target) => fs.existsSync(target),
	rename: (from, to) => fs.renameSync(from, to),
	copy: (from, to) => fs.copyFileSync(from, to),
	remove: (target) => fs.rmSync(target, { force: true }),
};

/**
 * Write one Spill file.
 *
 * `text` is the whole result the hook received, and it may be handed over
 * lazily: the adopt path does not use it, and building a copy of a 50KB result
 * to throw it away is a cost the caller should not pay to learn the file was
 * already on disk.
 *
 * `adoptPath` is pi's own throwaway log for a bash cut. It holds the command's
 * whole output, including the part pi dropped, so it is moved into the Spill
 * directory and becomes the Spill: pi's throwaway is not left behind, and one
 * call has one complete file. The result text is NOT appended after it, because
 * the log already contains it, and `sourcePath` reports what was moved so the
 * caller can repoint a path pi wrote into the result text.
 *
 * Without an `adoptPath` that this module can move, the file is the result
 * text, which is all the hook has. A pre-existing file is appended to, never
 * truncated, so a re-run of the same call id cannot lose what the first run
 * wrote.
 */
export function writeSpill(
	dir: string,
	name: string,
	text: string | (() => string),
	adoptPath?: string,
	move: SpillMove = DEVICE_MOVE,
): SpillWrite {
	const target = path.join(dir, name);
	try {
		mkdirPrivate(dir);
		if (adoptPath && adoptPath !== target && move.exists(adoptPath) && adoptInto(adoptPath, target, move)) {
			// A mode this module cannot force on a file it has just moved is not
			// worth a dead path: the file is already out of pi's reach, and the
			// 0700 directory around it is what keeps it private.
			try {
				fs.chmodSync(target, 0o600);
			} catch {
				// Reported by `status` as a footprint, and swept with the rest.
			}
			return { ok: true, path: target, bytes: fs.statSync(target).size, adopted: true, sourcePath: adoptPath };
		}
		const body = typeof text === "function" ? text() : text;
		if (fs.existsSync(target)) {
			fs.appendFileSync(target, body, { encoding: "utf8", mode: 0o600 });
		} else {
			fs.writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });
			fs.chmodSync(target, 0o600);
		}
		return { ok: true, path: target, bytes: fs.statSync(target).size, adopted: false, sourcePath: undefined };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Move pi's throwaway log onto the Spill path, whatever device each is on.
 *
 * `renameSync` is the whole job when the agent dir and pi's temp dir share a
 * device. They often do not: `/tmp` is tmpfs on a typical Linux, and the Spill
 * root lives beside the sessions (decision 20), so the rename throws `EXDEV`
 * and a copy is the only way to move the file. Letting a device boundary
 * abandon the Bound would fail the one thing this extension is for, so a copy
 * follows a failed rename, and a copy that cannot finish cleans up after
 * itself and lets the caller write the result text instead. Only an unwritable
 * Spill directory fails the whole write.
 */
function adoptInto(from: string, to: string, move: SpillMove): boolean {
	try {
		move.rename(from, to);
		return true;
	} catch {
		// A rename that threw may still have left a partial target: the copy
		// replaces it, and nothing downstream can tell the two paths apart.
	}
	try {
		move.copy(from, to);
		try {
			move.remove(from);
		} catch {
			// pi's throwaway left behind is pi's own cleanup problem, not a loss:
			// the Spill holds a complete copy either way.
		}
		return true;
	} catch {
		try {
			move.remove(to);
		} catch {
			// Nothing to clean up.
		}
		return false;
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
	for (const entry of readDirectory(root)) {
		if (entry.isDirectory()) {
			const dir = path.join(root, entry.name);
			for (const file of readDirectory(dir)) {
				if (!file.isFile()) continue;
				const fullPath = path.join(dir, file.name);
				const stat = statOrNull(fullPath);
				if (stat?.isFile()) files.push({ dir, name: file.name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
			}
			continue;
		}
		if (!entry.isFile()) continue;
		const fullPath = path.join(root, entry.name);
		const stat = statOrNull(fullPath);
		if (stat?.isFile()) files.push({ dir: root, name: entry.name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
	}
	return files;
}

/** One directory read that cannot fail. A sweep that lost the whole tree to
 * one entry it could not read would stop retention in silence, so a bad entry
 * costs only itself. */
function readDirectory(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function statOrNull(target: string): fs.Stats | null {
	try {
		return fs.statSync(target);
	} catch {
		return null;
	}
}

/** The footprint of one session's Spill directory: `status` reports it. */
export function spillFootprint(dir: string): { files: number; bytes: number } {
	const report = { files: 0, bytes: 0 };
	for (const entry of readDirectory(dir)) {
		if (!entry.isFile()) continue;
		const stat = statOrNull(path.join(dir, entry.name));
		if (!stat) continue;
		report.files += 1;
		report.bytes += stat.size;
	}
	return report;
}

/** One Spill file name: `<seq>-<tool>-<callid8>.log`. */
export function spillName(seq: number, toolName: string, callId: string): string {
	return `${seq}-${toolName}-${callId.slice(0, 8)}.log`;
}
