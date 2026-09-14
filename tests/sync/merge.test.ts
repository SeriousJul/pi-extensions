import { describe, expect, it } from "vitest";

import { merge, type MergeFile, type SideMap } from "../../extensions/sync/merge.ts";
import { sha256Hex } from "../../extensions/sync/hash.ts";
import { MANIFEST_KEY } from "../../extensions/sync/types.ts";

function side(content: string, mtimeMs: number): MergeFile {
	return { hash: sha256Hex(content), mtimeMs, content };
}

function baseOnly(content: string, mtimeMs: number): MergeFile {
	return { hash: sha256Hex(content), mtimeMs };
}

function maps(
	base: [string, string, number, boolean?][],
	local: [string, string, number][],
	remote: [string, string, number][],
): SideMap[] {
	const buildBase = (rows: [string, string, number, boolean?][]): SideMap => {
		const map: SideMap = new Map();
		for (const [path, content, mtimeMs, deleted] of rows) {
			const entry = baseOnly(content, mtimeMs);
			if (deleted) (entry as { deleted?: boolean }).deleted = true;
			map.set(path, entry);
		}
		return map;
	};
	const build = (rows: [string, string, number][], withContent: boolean): SideMap => {
		const map: SideMap = new Map();
		for (const [path, content, mtimeMs] of rows) {
			map.set(path, withContent ? side(content, mtimeMs) : baseOnly(content, mtimeMs));
		}
		return map;
	};
	return [buildBase(base), build(local, true), build(remote, true)];
}

const T0 = 1_000;
const T1 = 2_000;
const T2 = 3_000;

describe("three-way merge", () => {
	it("does nothing when all three sides agree", () => {
		const [b, l, r] = maps([["a.md", "same", T0]], [["a.md", "same", T0]], [["a.md", "same", T0]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([]);
		expect(plan.conflicts).toEqual([]);
	});

	it("takes a file changed only on the remote", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "base", T0]], [["a.md", "remote", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "write", path: "a.md", content: "remote", mtimeMs: T1, reason: "remote-change" }]);
		expect(plan.changedRemote).toEqual(["a.md"]);
	});

	it("keeps a file changed only locally", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local", T1]], [["a.md", "base", T0]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "keep", path: "a.md", reason: "local-change" }]);
		expect(plan.changedLocal).toEqual(["a.md"]);
	});

	it("resolves a both-sides change to the newer modification time, local newer", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local", T2]], [["a.md", "remote", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([
			{ kind: "backup", path: "a.md", source: "remote", content: "remote" },
			{ kind: "keep", path: "a.md", reason: "conflict-local-wins" },
		]);
		expect(plan.conflicts).toEqual([{ path: "a.md", kind: "modified-both", winner: "local", backedUp: true }]);
	});

	it("resolves a both-sides change to the newer modification time, remote newer", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local", T1]], [["a.md", "remote", T2]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([
			{ kind: "backup", path: "a.md", source: "local", content: "local" },
			{ kind: "write", path: "a.md", content: "remote", mtimeMs: T2, reason: "conflict-remote-wins" },
		]);
		expect(plan.conflicts).toEqual([{ path: "a.md", kind: "modified-both", winner: "remote", backedUp: true }]);
	});

	it("keeps local on an mtime tie, so a pull never clobbers a same-second edit", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local", T1]], [["a.md", "remote", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([
			{ kind: "backup", path: "a.md", source: "remote", content: "remote" },
			{ kind: "keep", path: "a.md", reason: "conflict-local-wins" },
		]);
	});

	it("normalizes a both-sides change that converged on the same content, without a backup", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "same", T1]], [["a.md", "same", T2]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "write", path: "a.md", content: "same", mtimeMs: T2, reason: "converged" }]);
		expect(plan.conflicts).toEqual([]);
	});

	it("keeps local-only files", () => {
		const [b, l, r] = maps([], [["new.md", "local", T1]], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "keep", path: "new.md", reason: "local-only" }]);
		expect(plan.localOnly).toEqual(["new.md"]);
	});

	it("applies remote-only files", () => {
		const [b, l, r] = maps([], [], [["new.md", "remote", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "write", path: "new.md", content: "remote", mtimeMs: T1, reason: "remote-only" }]);
		expect(plan.remoteOnly).toEqual(["new.md"]);
	});

	it("applies a remote deletion when the local copy is unchanged", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "base", T0]], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "delete", path: "a.md", reason: "remote-delete" }]);
		expect(plan.remoteDeleted).toEqual(["a.md"]);
	});

	it("lets a local deletion stand when the remote copy is unchanged", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [], [["a.md", "base", T0]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([]);
		expect(plan.localDeleted).toEqual(["a.md"]);
	});

	it("backs up the modified local copy and applies a remote deletion", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local", T1]], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([
			{ kind: "backup", path: "a.md", source: "local", content: "local" },
			{ kind: "delete", path: "a.md", reason: "delete-vs-modify" },
		]);
		expect(plan.conflicts).toEqual([{ path: "a.md", kind: "delete-modified", winner: "delete", backedUp: true }]);
	});

	it("backs up the modified remote copy when the file is deleted locally", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [], [["a.md", "remote", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "backup", path: "a.md", source: "remote", content: "remote" }]);
		expect(plan.conflicts).toEqual([{ path: "a.md", kind: "delete-modified", winner: "delete", backedUp: true }]);
	});

	it("does nothing for a file deleted on both sides", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([]);
	});

	it("applies a base-marked deletion to an unchanged local copy", () => {
		const [b, l, r] = maps([["a.md", "base", T0, true]], [["a.md", "base", T0]], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "delete", path: "a.md", reason: "remote-delete" }]);
	});

	it("backs up a modified local copy before applying a base-marked deletion", () => {
		const [b, l, r] = maps([["a.md", "base", T0, true]], [["a.md", "local edit", T1]], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([
			{ kind: "backup", path: "a.md", source: "local", content: "local edit" },
			{ kind: "delete", path: "a.md", reason: "delete-vs-modify" },
		]);
		expect(plan.conflicts).toEqual([{ path: "a.md", kind: "delete-modified", winner: "delete", backedUp: true }]);
	});

	it("does nothing for a base-marked deletion when the local copy is already gone", () => {
		const [b, l, r] = maps([["a.md", "base", T0, true]], [], []);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([]);
	});

	it("applies a restored file after a base-marked deletion", () => {
		const [b, l, r] = maps([["a.md", "base", T0, true]], [], [["a.md", "restored", T1]]);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "write", path: "a.md", content: "restored", mtimeMs: T1, reason: "remote-only" }]);
	});

	it("adopts remote files on a fresh device instead of reading them as local deletions", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [], [["a.md", "base", T0]]);
		const plan = merge(b, l, r, { fresh: true });
		expect(plan.actions).toEqual([{ kind: "write", path: "a.md", content: "base", mtimeMs: T0, reason: "remote-only" }]);
		expect(plan.localDeleted).toEqual([]);
	});

	it("still keeps a local edit on a fresh device (an unexplained local change is not clobbered)", () => {
		const [b, l, r] = maps([["a.md", "base", T0]], [["a.md", "local edit", T1]], [["a.md", "base", T0]]);
		const plan = merge(b, l, r, { fresh: true });
		expect(plan.actions).toEqual([{ kind: "keep", path: "a.md", reason: "local-change" }]);
	});

	it("treats the tool-managed manifest like any other file", () => {
		const [b, l, r] = maps(
			[[MANIFEST_KEY, "base", T0]],
			[[MANIFEST_KEY, "base", T0]],
			[[MANIFEST_KEY, "remote", T1]],
		);
		const plan = merge(b, l, r);
		expect(plan.actions).toEqual([{ kind: "write", path: MANIFEST_KEY, content: "remote", mtimeMs: T1, reason: "remote-change" }]);
	});

	it("produces deterministic, sorted output", () => {
		const [b, l, r] = maps(
			[["z.md", "base", T0], ["a.md", "base", T0]],
			[["z.md", "base", T0], ["a.md", "local", T1]],
			[["z.md", "remote", T1], ["a.md", "base", T0]],
		);
		const first = merge(b, l, r);
		const second = merge(b, l, r);
		expect(first.actions).toEqual(second.actions);
		expect(first.actions.map((a) => a.path)).toEqual(["a.md", "z.md"]);
	});
});
