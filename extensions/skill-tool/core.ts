/**
 * Skill tool core (issue #143).
 *
 * The pure logic behind the `skill` tool: name lookup against the skill
 * list pi itself loaded, frontmatter stripping, and the result text the
 * tool returns. Nothing here touches pi or the event loop, so it tests in
 * milliseconds. The entrypoint (index.ts) owns the pi wiring: it captures
 * the registry from `before_agent_start` and registers the tool.
 */
import { readFileSync } from "node:fs";
import type { Skill } from "@earendil-works/pi-coding-agent";

/**
 * Drop a leading YAML frontmatter block, the one between the first `---`
 * line and the next `---` line. Text without a frontmatter block, or with
 * an unclosed one, comes back unchanged: a skill pi loaded always carries
 * a parseable block, so the unchanged case is a guard, not a path.
 */
export function stripFrontmatter(text: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
	return match ? text.slice(match[0].length) : text;
}

export type SkillLookup = { found: true; skill: Skill } | { found: false; name: string; known: string[] };

/**
 * Resolve a name against the loaded skills: exact first, then case-folded,
 * then a miss carrying the sorted known names so the caller's error text
 * steers the model back in one retry.
 */
export function lookUpSkill(skills: readonly Skill[], name: string): SkillLookup {
	const exact = skills.find((skill) => skill.name === name);
	if (exact) return { found: true, skill: exact };
	const folded = name.toLowerCase();
	const caseFolded = skills.find((skill) => skill.name.toLowerCase() === folded);
	if (caseFolded) return { found: true, skill: caseFolded };
	return { found: false, name, known: skills.map((skill) => skill.name).sort() };
}

/**
 * The success text: the same block shape pi's own /skill: expansion records
 * (tag with name and location, the base-directory line, the body with the
 * frontmatter stripped), so a name-based load and an explicit command land
 * the model in the same place.
 */
export function formatSkillLoaded(skill: Skill, rawBody: string): string {
	return [
		`<skill name="${skill.name}" location="${skill.filePath}">`,
		`References are relative to ${skill.baseDir}.`,
		"",
		// The blank line after the frontmatter fence is head, not body: drop
		// it so the block shows one blank line, exactly the shape pi's own
		// expansion records.
		stripFrontmatter(rawBody)
			.replace(/^\s*\n+/, "")
			.trimEnd(),
		"</skill>",
	].join("\n");
}

export function formatSkillUnknown(name: string, known: string[]): string {
	return `Skill "${name}" is not loaded in this session. Loaded skills: ${known.join(", ")}.`;
}

/**
 * Mirror pi's own input pipeline for a skill file: pi strips a BOM and
 * normalizes line endings before it parses the frontmatter (see pi's
 * `extractFrontmatter`), so the tool does the same. A CRLF or BOM checkout
 * then yields the same LF body pi's `/skill:` expansion records, and the
 * byte-for-byte claim in ADR 0035 holds on every checkout, not only LF.
 */
export function normalizeSkillText(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export type SkillLoadOutcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * One tool call end to end: resolve the name, read the SKILL.md pi points
 * at, and format it. A file that vanished after the run started (a /reload
 * race) is reported with the reload hint instead of a bare ENOENT.
 */
export function loadSkillText(skills: readonly Skill[], name: string): SkillLoadOutcome {
	const lookup = lookUpSkill(skills, name);
	if (!lookup.found) return { ok: false, text: formatSkillUnknown(lookup.name, lookup.known) };
	let raw: string;
	try {
		raw = readFileSync(lookup.skill.filePath, "utf8");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			text: `Skill "${name}" points at ${lookup.skill.filePath}, which cannot be read (${reason}). Run /reload if the skill tree changed since this run started.`,
		};
	}
	// Normalize before the frontmatter strip so a CRLF file returns the
	// same LF body pi's /skill: expansion records.
	return { ok: true, text: formatSkillLoaded(lookup.skill, normalizeSkillText(raw)) };
}
