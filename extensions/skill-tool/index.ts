/**
 * skill-tool extension entrypoint (issue #143).
 *
 * Skills reference each other by name: "call the Skill tool with
 * 'domain-modeling'". The upstream skills say this because their home
 * environment has a Skill tool; pi does not. The model only learns where a
 * skill lives from the skills section of the system prompt, so a name
 * reference makes it re-type the long install path by hand - and it gets
 * the path wrong (a sibling-bucket guess, a mangled directory name), and
 * the read dies with ENOENT (issue #143, session 01a13a4d).
 *
 * This extension supplies the missing tool: one `skill` tool that takes a
 * name and loads the skill. The name list is pi's own registry, captured
 * from `before_agent_start` at every run, so the tool can only ever point
 * at a skill pi loaded, and a name pi does not know gets back the loaded
 * names to correct against. The tool never scans the filesystem itself,
 * the same way skill-command never re-implements pi's expansion (ADR 0033):
 * pi stays the owner of discovery, and this tool only resolves a name
 * against what pi already told the model.
 */
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadSkillText } from "./core";

export default function (pi: ExtensionAPI): void {
	/** The skill list of the run in flight, captured at its start. */
	let skills: readonly Skill[] = [];

	pi.on("before_agent_start", (event) => {
		// Older pi versions lack the field; an empty registry degrades the
		// tool to a lookup that only ever reports the (empty) loaded list.
		skills = event.systemPromptOptions.skills ?? [];
	});

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description:
			"Load a skill by name: returns the skill's full instructions, its file location, and the base directory its relative file references resolve against. Use it when a skill's instructions say to call the Skill tool for another skill by name; the name comes from the skills listed in the system prompt.",
		promptSnippet: "Load a skill by name and return its instructions; the skill's file path is never guessed.",
		parameters: Type.Object({
			name: Type.String({
				description: "The skill name, as listed in the skills section of the system prompt or named by another skill's instructions.",
			}),
		}),
		promptGuidelines: [
			"When a skill's instructions say to call the Skill tool for another skill, call the skill tool with that skill's name; never guess or re-type the skill's file path.",
		],
		async execute(_toolCallId, params) {
			const result = loadSkillText(skills, params.name);
			if (!result.ok) {
				return { content: [{ type: "text" as const, text: result.text }], details: {}, isError: true };
			}
			return { content: [{ type: "text" as const, text: result.text }], details: {} };
		},
	});
}
