/**
 * skill-command extension entrypoint.
 *
 * pi's built-in skill-command expansion parses the name up to the first
 * space, so an injected command whose name and arguments are separated by a
 * newline - the shape the factory's consultation templates use - passes
 * through unexpanded (issue #126). The input event fires before the
 * expansion, so this handler rewrites that one separator to a single space
 * (ADR 0033); pi then expands the command itself and keeps owning the
 * expansion format.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeSkillCommand } from "./core";

export default function (pi: ExtensionAPI): void {
	pi.on("input", (event) => {
		const normalized = normalizeSkillCommand(event.text);
		if (normalized === undefined) return { action: "continue" };
		return { action: "transform", text: normalized };
	});
}
