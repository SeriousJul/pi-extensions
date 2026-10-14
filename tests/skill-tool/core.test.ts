import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";

import {
	formatSkillLoaded,
	formatSkillUnknown,
	loadSkillText,
	lookUpSkill,
	normalizeSkillText,
	stripFrontmatter,
} from "../../extensions/skill-tool/core";

const fixtureRoot = join(fileURLToPath(new URL(".", import.meta.url)), "fixture", "skills");

function skill(name: string, filePath: string, baseDir: string, extra: Partial<Skill> = {}): Skill {
	return {
		name,
		description: `fixture ${name}`,
		filePath,
		baseDir,
		disableModelInvocation: false,
		sourceInfo: {} as Skill["sourceInfo"],
		...extra,
	};
}

describe("stripFrontmatter", () => {
	it("drops the block between the first two --- lines", () => {
		const text = "---\nname: x\ndescription: y\n---\n\n# Body\n";
		expect(stripFrontmatter(text)).toBe("\n# Body\n");
	});

	it("handles CRLF line endings", () => {
		const text = "---\r\nname: x\r\n---\r\nbody";
		expect(stripFrontmatter(text)).toBe("body");
	});

	it("leaves text without a frontmatter block unchanged", () => {
		expect(stripFrontmatter("# just a body\n")).toBe("# just a body\n");
	});

	it("leaves an unclosed frontmatter unchanged rather than eating the body", () => {
		const text = "---\nname: x\nno closing fence";
		expect(stripFrontmatter(text)).toBe(text);
	});
});

describe("lookUpSkill", () => {
	const grilling = skill("grilling", `${fixtureRoot}/a-bucket/grilling/SKILL.md`, join(fixtureRoot, "a-bucket", "grilling"));
	const modeling = skill("domain-modeling", `${fixtureRoot}/a-bucket/domain-modeling/SKILL.md`, join(fixtureRoot, "a-bucket", "domain-modeling"));
	const docs = skill("grill-docs", `${fixtureRoot}/b-bucket/grill-docs/SKILL.md`, join(fixtureRoot, "b-bucket", "grill-docs"), {
		disableModelInvocation: true,
	});
	const list = [docs, grilling, modeling];

	it("resolves an exact name", () => {
		const lookup = lookUpSkill(list, "grilling");
		expect(lookup.found).toBe(true);
		if (lookup.found) expect(lookup.skill).toBe(grilling);
	});

	it("resolves a case-variant of a name", () => {
		const lookup = lookUpSkill(list, "Grilling");
		expect(lookup.found).toBe(true);
		if (lookup.found) expect(lookup.skill).toBe(grilling);
	});

	it("prefers the exact match over the case-folded one", () => {
		const upper = skill("GRILLING", "/x/SKILL.md", "/x");
		const lookup = lookUpSkill([grilling, upper], "GRILLING");
		expect(lookup.found).toBe(true);
		if (lookup.found) expect(lookup.skill).toBe(upper);
	});

	it("reports a miss with the sorted loaded names, disabled skills included", () => {
		const lookup = lookUpSkill(list, "nope");
		expect(lookup.found).toBe(false);
		if (!lookup.found) {
			expect(lookup.name).toBe("nope");
			expect(lookup.known).toEqual(["domain-modeling", "grill-docs", "grilling"]);
		}
	});
});

describe("formatSkillLoaded", () => {
	it("emits the same block shape pi's /skill: expansion records", () => {
		const s = skill("grilling", `${fixtureRoot}/a-bucket/grilling/SKILL.md`, join(fixtureRoot, "a-bucket", "grilling"));
		const text = formatSkillLoaded(s, "---\nname: grilling\n---\n# Grilling\n\nGRILLING BODY.\n");
		expect(text).toBe(
			[
				`<skill name="grilling" location="${s.filePath}">`,
				`References are relative to ${s.baseDir}.`,
				"",
				"# Grilling",
				"",
				"GRILLING BODY.",
				"</skill>",
			].join("\n"),
		);
	});
});

describe("normalizeSkillText", () => {
	it("strips a BOM and folds CRLF and lone CR to LF, like pi's frontmatter parse", () => {
		expect(normalizeSkillText("\uFEFFa\r\nb\rc\n")).toBe("a\nb\nc\n");
	});
});

describe("formatSkillUnknown", () => {
	it("names the failed lookup and the loaded skills", () => {
		expect(formatSkillUnknown("nope", ["a", "b"])).toBe(`Skill "nope" is not loaded in this session. Loaded skills: a, b.`);
	});
});

describe("loadSkillText", () => {
	const grilling = skill("grilling", join(fixtureRoot, "a-bucket", "grilling", "SKILL.md"), join(fixtureRoot, "a-bucket", "grilling"));
	const modeling = skill("domain-modeling", join(fixtureRoot, "a-bucket", "domain-modeling", "SKILL.md"), join(fixtureRoot, "a-bucket", "domain-modeling"));

	it("reads and formats the file pi points at", () => {
		const outcome = loadSkillText([grilling, modeling], "grilling");
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.text).toContain("GRILLING BODY.");
			expect(outcome.text).toContain(`<skill name="grilling" location="${grilling.filePath}">`);
			expect(outcome.text).not.toContain("name: grilling");
			// The returned block names a file that exists: re-reading it can never ENOENT.
			const location = /location="([^"]+)"/.exec(outcome.text)?.[1];
			if (!location) throw new Error("no location in the block");
			expect(readFileSync(location, "utf8").length).toBeGreaterThan(0);
		}
	});

	it("fails an unknown name with the loaded names", () => {
		const outcome = loadSkillText([grilling, modeling], "nope");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.text).toBe(`Skill "nope" is not loaded in this session. Loaded skills: domain-modeling, grilling.`);
		}
	});

	it("turns a vanished file into a reload hint instead of a bare ENOENT", () => {
		const ghost = skill("ghost", join(fixtureRoot, "a-bucket", "ghost", "SKILL.md"), join(fixtureRoot, "a-bucket", "ghost"));
		const outcome = loadSkillText([ghost], "ghost");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.text).toContain(ghost.filePath);
			expect(outcome.text).toContain("/reload");
		}
	});

	it("normalizes a CRLF file to the same LF body pi's expansion records", () => {
		const dir = mkdtempSync(join(tmpdir(), "skill-tool-crlf-"));
		const file = join(dir, "SKILL.md");
		writeFileSync(file, "---\r\nname: crlf\r\ndescription: fixture crlf\r\n---\r\n# Body\r\nline two\r\n");
		try {
			const s = skill("crlf", file, dir);
			const outcome = loadSkillText([s], "crlf");
			expect(outcome.ok).toBe(true);
			if (outcome.ok) {
				expect(outcome.text).not.toContain("\r");
				expect(outcome.text).toBe(
					[
						`<skill name="crlf" location="${file}">`,
						`References are relative to ${dir}.`,
						"",
						"# Body",
						"line two",
						"</skill>",
					].join("\n"),
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
