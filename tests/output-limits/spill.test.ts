import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirPrivate, spillDir, spillFootprint, spillName, spillRoot, sweepSpills, writeSpill } from "../../extensions/output-limits/spill";

// The Spill file contract: one call, one file, private modes, a sweep that
// touches only this extension's own directory, and writes that report failure
// instead of throwing, because "lossless or no cut" is the wiring's rule and
// it can only follow it if this module tells the truth about a bad write.

let root: string;
let dir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "output-limits-spill-"));
	dir = spillDir(root, "session-abc");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("paths and names", () => {
	it("puts the Spills under the agent dir, beside the sessions", () => {
		expect(spillDir("/agent", "s1")).toBe(join("/agent", "output-limits", "s1"));
		expect(spillRoot("/agent")).toBe(join("/agent", "output-limits"));
	});

	it("names one file per call: sequence, tool, and the first eight of the call id", () => {
		expect(spillName(4, "bash", "c1d2e3f4a5b6")).toBe("4-bash-c1d2e3f4.log");
		// A short call id is used whole rather than padded.
		expect(spillName(1, "grep", "abc")).toBe("1-grep-abc.log");
	});
});

describe("writeSpill", () => {
	it("creates the directory at 0700 and the file at 0600", () => {
		const result = writeSpill(dir, "1-bash-aaaa.log", "whole result\n");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
		expect(readFileSync(result.path, "utf8")).toBe("whole result\n");
		expect(result.bytes).toBe(13);
		expect(result.adopted).toBe(false);
	});

	it("forces the mode when the directory already existed loose", () => {
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		// `recursive: true` only applies the mode on creation, so the mode has
		// to be asserted again or a pre-existing loose directory stays loose.
		writeSpill(dir, "1-bash-aaaa.log", "x\n");
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it("appends to a file that is already there instead of truncating it", () => {
		writeSpill(dir, "1-bash-aaaa.log", "first\n");
		writeSpill(dir, "1-bash-aaaa.log", "second\n");
		expect(readFileSync(join(dir, "1-bash-aaaa.log"), "utf8")).toBe("first\nsecond\n");
	});

	it("adopts pi's own log as the Spill and leaves the result text out of it", () => {
		const piLog = join(root, "pi-bash-throwaway.log");
		writeFileSync(piLog, "the whole command output\n");
		const result = writeSpill(dir, "1-bash-aaaa.log", "the tail pi showed\n", piLog);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adopted).toBe(true);
		// pi's log is a superset of the text the hook received, so copying that
		// text in again would double the file to state nothing new.
		expect(readFileSync(result.path, "utf8")).toBe("the whole command output\n");
		// pi's throwaway is moved, not left behind: one call, one file.
		expect(existsSync(piLog)).toBe(false);
		expect(statSync(result.path).mode & 0o777).toBe(0o600);
	});

	it("writes the result text when pi left no log to adopt", () => {
		const result = writeSpill(dir, "1-grep-aaaa.log", "grep output\n", join(root, "never-existed.log"));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.adopted).toBe(false);
		expect(readFileSync(result.path, "utf8")).toBe("grep output\n");
	});

	it("reports a failed write instead of throwing", () => {
		// A file where the session's Spill directory must be created: mkdir
		// fails, and the write has to report that rather than throw.
		mkdirSync(spillRoot(root), { recursive: true });
		writeFileSync(dir, "not a directory");
		const result = writeSpill(dir, "1-bash-aaaa.log", "text\n");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.length).toBeGreaterThan(0);
	});

	it("refuses to move a file onto itself", () => {
		mkdirPrivate(dir);
		const same = join(dir, "1-bash-aaaa.log");
		writeFileSync(same, "already here\n");
		const result = writeSpill(dir, "1-bash-aaaa.log", "more\n", same);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// adoptPath === target is the no-op case: the text is appended instead.
		expect(readFileSync(same, "utf8")).toBe("already here\nmore\n");
	});
});

describe("sweepSpills", () => {
	const day = 24 * 60 * 60 * 1000;

	function aged(name: string, ageDays: number, bytes = 100): string {
		const sessionDir = spillDir(root, "sweep-session");
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, name);
		writeFileSync(file, "x".repeat(bytes));
		const at = (Date.now() - ageDays * day) / 1000;
		utimesSync(file, at, at);
		return file;
	}

	it("removes files past the age limit and keeps the rest", () => {
		const stale = aged("1-bash-oldold.log", 10);
		const fresh = aged("2-bash-newnew.log", 1);
		const report = sweepSpills(spillRoot(root), { maxTotalBytes: 10_000_000, maxAgeDays: 7 });
		expect(report).toEqual({ removed: 1, bytesFreed: 100 });
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("enforces the total by dropping the oldest first", () => {
		const oldest = aged("1-bash-aaaa.log", 3, 900);
		const middle = aged("2-bash-bbbb.log", 2, 900);
		const newest = aged("3-bash-cccc.log", 1, 900);
		const report = sweepSpills(spillRoot(root), { maxTotalBytes: 1_000, maxAgeDays: 365 });
		expect(report.removed).toBe(2);
		expect(existsSync(newest)).toBe(true);
		expect(existsSync(middle)).toBe(false);
		expect(existsSync(oldest)).toBe(false);
	});

	it("goes under the total even when that means the newest file goes too", () => {
		// The limit is a footprint limit, so the sweep does not stop at the
		// newest survivor out of politeness: one file larger than the total is
		// removed like any other. A session that wants its Spill kept sets a
		// total that holds it.
		const only = aged("1-bash-aaaa.log", 1, 5_000);
		const report = sweepSpills(spillRoot(root), { maxTotalBytes: 100, maxAgeDays: 365 });
		expect(report.removed).toBe(1);
		expect(existsSync(only)).toBe(false);
	});

	it("sweeps every session directory under the root", () => {
		const other = spillDir(root, "other-session");
		mkdirSync(other, { recursive: true });
		const file = join(other, "1-bash-aaaa.log");
		writeFileSync(file, "x".repeat(50));
		utimesSync(file, 0, 0);
		expect(sweepSpills(spillRoot(root), { maxTotalBytes: 10_000_000, maxAgeDays: 1 }).removed).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	it("is silent about a root that does not exist yet", () => {
		expect(sweepSpills(join(root, "nothing-here"), { maxTotalBytes: 10, maxAgeDays: 1 })).toEqual({ removed: 0, bytesFreed: 0 });
	});

	it("never reaches outside its own root", () => {
		// pi's own throwaway sits beside the Spill root, not inside it.
		const outside = join(root, "pi-bash-not-mine.log");
		writeFileSync(outside, "pi's own throwaway, from a call this extension never touched\n");
		utimesSync(outside, 0, 0);
		sweepSpills(spillRoot(root), { maxTotalBytes: 10, maxAgeDays: 1 });
		expect(existsSync(outside)).toBe(true);
	});
});

describe("spillFootprint", () => {
	it("counts the files and bytes of one session directory", () => {
		mkdirPrivate(dir);
		writeFileSync(join(dir, "1-bash-aaaa.log"), "abc");
		writeFileSync(join(dir, "2-grep-bbbb.log"), "defgh");
		expect(spillFootprint(dir)).toEqual({ files: 2, bytes: 8 });
	});

	it("is zero for a session that never spilled", () => {
		expect(spillFootprint(join(root, "absent"))).toEqual({ files: 0, bytes: 0 });
	});

	it("reads a file standing where the directory should be as nothing", () => {
		mkdirSync(spillRoot(root), { recursive: true });
		writeFileSync(dir, "not a directory");
		expect(spillFootprint(dir)).toEqual({ files: 0, bytes: 0 });
	});
});
