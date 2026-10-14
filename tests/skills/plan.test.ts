import { describe, expect, it } from "vitest";

import { parseAddTarget, planSource, type SkillTree } from "../../scripts/skills/core.mjs";

import type { SkillSource } from "../../scripts/skills/core.d.mts";

/**
 * Deterministic stand-in for git merge-file: a side that is unchanged from
 * the base loses to the changed side; two different changes are a conflict
 * with markers; two identical changes are clean.
 */
function fakeMerge(base: string | null, ours: string | null, theirs: string | null): { clean: boolean; content: string } {
	const b = base ?? "";
	const o = ours ?? "";
	const t = theirs ?? "";
	if (o === b) return { clean: true, content: t };
	if (t === b) return { clean: true, content: o };
	if (o === t) return { clean: true, content: t };
	return { clean: false, content: `<<<<<<< local\n${o}\n=======\n${t}\n>>>>>>> upstream` };
}

type Entry = [name: string, files: Record<string, string>];

function treeOf(...entries: Entry[]): SkillTree {
	const tree: SkillTree = {};
	for (const [name, files] of entries) tree[name] = { files };
	return tree;
}

function plan(partial: Partial<{ pin: string; fetched: string; localSkills: SkillTree; pinTree: SkillTree; fetchedTree: SkillTree }>) {
	return planSource({
		pin: partial.pin ?? "aaa",
		fetched: partial.fetched ?? "bbb",
		localSkills: partial.localSkills ?? {},
		pinTree: partial.pinTree ?? {},
		fetchedTree: partial.fetchedTree ?? {},
		mergeFile: fakeMerge,
	});
}

const twoSources: Record<string, SkillSource> = {
	mattpocock: { repo: "r", root: "skills/mattpocock", pin: "p" },
	"anti-slop": { repo: "r", root: "skills/anti-slop", pin: "p" },
};

describe("parseAddTarget", () => {
	it("parses a bucketed skill with its source slug", () => {
		expect(parseAddTarget("mattpocock/engineering/tdd", twoSources)).toEqual({ slug: "mattpocock", path: "engineering/tdd" });
	});

	it("parses a bucket-less skill with its source slug", () => {
		expect(parseAddTarget("anti-slop/antislop-ui", twoSources)).toEqual({ slug: "anti-slop", path: "antislop-ui" });
	});

	it("still demands the slug with a single-source manifest", () => {
		expect(parseAddTarget("fixture/engineering/alpha", { fixture: { repo: "r", root: "skills/fixture", pin: "p" } })).toEqual({ slug: "fixture", path: "engineering/alpha" });
	});

	it("rejects a bare bucket-less name", () => {
		expect(() => parseAddTarget("antislop-ui", twoSources)).toThrow(/usage/);
	});

	it("rejects a bucketed path without a source slug", () => {
		expect(() => parseAddTarget("engineering/tdd", twoSources)).toThrow(/unknown source engineering/);
	});

	it("rejects an unknown source slug", () => {
		expect(() => parseAddTarget("nosuch/antislop-ui", twoSources)).toThrow(/unknown source nosuch/);
	});

	it("rejects empty segments", () => {
		expect(() => parseAddTarget("anti-slop//antislop-ui", twoSources)).toThrow(/usage/);
		expect(() => parseAddTarget("anti-slop/", twoSources)).toThrow(/usage/);
	});
});

describe("planSource", () => {
	it("reports unchanged and writes nothing when all sides agree", () => {
		const p = plan({
			pin: "aaa",
			fetched: "bbb",
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
		});
		expect(p.skills).toEqual([{ name: "engineering/tdd", status: "unchanged", files: [{ path: "SKILL.md", action: "keep" }], notes: [] }]);
		expect(p.writes).toEqual({});
		expect(p.advancePin).toBe(true); // the tree agrees, so the pin may follow upstream
	});

	it("applies a clean upstream change and advances the pin", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "base" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "base" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "upstream" }]),
		});
		expect(p.skills[0].status).toBe("clean");
		expect(p.writes).toEqual({ "engineering/tdd": { "SKILL.md": "upstream" } });
		expect(p.advancePin).toBe(true);
	});

	it("keeps a local-only change and advances the pin", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "tweaked" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "base" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "base" }]),
		});
		expect(p.skills[0].status).toBe("unchanged");
		expect(p.writes).toEqual({});
		expect(p.advancePin).toBe(true);
	});

	it("marks a both-sides change with conflict markers and holds the pin", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "ours" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "base" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "theirs" }]),
		});
		expect(p.skills[0].status).toBe("conflict");
		expect(p.writes["engineering/tdd"]["SKILL.md"]).toBe("<<<<<<< local\nours\n=======\ntheirs\n>>>>>>> upstream");
		expect(p.advancePin).toBe(false);
	});

	it("names offers by upstream path so the CLI can prefix the source slug", () => {
		const p = plan({
			localSkills: {},
			pinTree: {},
			fetchedTree: treeOf(
				["antislop-ui", { "SKILL.md": "flat" }],
				["engineering/tdd", { "SKILL.md": "bucketed" }],
			),
		});
		expect(p.offers).toEqual(["antislop-ui", "engineering/tdd"]);
	});

	it("lists a new upstream skill as an offer and never adds it", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			fetchedTree: treeOf(
				["engineering/tdd", { "SKILL.md": "same" }],
				["engineering/new", { "SKILL.md": "new" }],
			),
		});
		expect(p.offers).toEqual(["engineering/new"]);
		expect(p.writes).toEqual({});
		expect(p.skills.find((s) => s.name === "engineering/new")?.status).toBe("offer");
		expect(p.advancePin).toBe(true);
	});

	it("reports a local skill absent upstream as an orphan and holds the pin", () => {
		const p = plan({
			localSkills: treeOf(
				["engineering/tdd", { "SKILL.md": "same" }],
				["engineering/gone", { "SKILL.md": "orphan" }],
			),
			pinTree: treeOf(
				["engineering/tdd", { "SKILL.md": "same" }],
				["engineering/gone", { "SKILL.md": "orphan" }],
			),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
		});
		expect(p.orphans).toEqual(["engineering/gone"]);
		expect(p.skills.find((s) => s.name === "engineering/gone")?.status).toBe("orphan");
		expect(p.writes).toEqual({});
		expect(p.advancePin).toBe(false);
	});

	it("brings in a new upstream file inside a tracked skill", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same", "refs.md": "new reference" }]),
		});
		expect(p.skills[0].status).toBe("clean");
		expect(p.writes["engineering/tdd"]["refs.md"]).toBe("new reference");
		expect(p.advancePin).toBe(true);
	});

	it("keeps a file upstream deleted when the local copy is unchanged", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same", "old.md": "kept" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same", "old.md": "kept" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
		});
		expect(p.skills[0].status).toBe("unchanged");
		expect(p.writes).toEqual({});
		expect(p.skills[0].notes.join(" ")).toContain("upstream deleted engineering/tdd/old.md");
		expect(p.advancePin).toBe(true);
	});

	it("conflicts on a file upstream deleted while the local copy changed", () => {
		const p = plan({
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same", "old.md": "modified" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same", "old.md": "kept" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
		});
		expect(p.skills[0].status).toBe("conflict");
		expect(p.writes).toEqual({});
		expect(p.advancePin).toBe(false);
	});

	it("merges an adopted skill whose base is absent at the pin", () => {
		const p = plan({
			localSkills: treeOf(["engineering/new", { "SKILL.md": "upstream" }]),
			pinTree: {},
			fetchedTree: treeOf(["engineering/new", { "SKILL.md": "upstream" }]),
		});
		expect(p.skills[0].status).toBe("unchanged");
		expect(p.writes).toEqual({});
		expect(p.advancePin).toBe(true);
	});

	it("does not advance the pin when the fetched commit is the pin", () => {
		const p = plan({
			pin: "aaa",
			fetched: "aaa",
			localSkills: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			pinTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
			fetchedTree: treeOf(["engineering/tdd", { "SKILL.md": "same" }]),
		});
		expect(p.advancePin).toBe(false);
	});

	it("sorts skills by name, tracked and offers together", () => {
		const p = plan({
			localSkills: treeOf(["misc/b", { "SKILL.md": "s" }]),
			pinTree: treeOf(["misc/b", { "SKILL.md": "s" }]),
			fetchedTree: treeOf(
				["misc/b", { "SKILL.md": "s" }],
				["engineering/a", { "SKILL.md": "n" }],
			),
		});
		expect(p.skills.map((s) => s.name)).toEqual(["engineering/a", "misc/b"]);
	});
});
