/**
 * The skill-command normalization (ADR 0033).
 *
 * pi expands a "/skill:name args" command by parsing the name up to the FIRST
 * SPACE, so a newline between the name and the arguments breaks the parse:
 * the "name" becomes the name plus newlines plus the start of the argument
 * text, nothing matches, and the command passes through unexpanded. That is
 * the shape injected skill commands arrive in - the factory's consultation
 * templates start with the command on its own line (issue #126).
 *
 * normalizeSkillCommand rewrites that one separator to the single space pi
 * parses, so pi's built-in expansion runs and stays the owner of the
 * expansion format. It returns the rewritten text, or undefined when the
 * text is not a skill command with a newline separator (pi already handles
 * the space form, and any other input is not touched).
 */

/**
 * A skill command at the start of the text: the name (per the Agent Skills
 * spec: lowercase letters, numbers, hyphens), then a separator that contains
 * at least one newline, then the arguments (everything else, verbatim).
 */
const SKILL_COMMAND = /^\/skill:([a-z0-9-]+)[ \t]*(?:\r\n|\n|\r)[ \t]*([\s\S]*)$/;

export function normalizeSkillCommand(text: string): string | undefined {
	const match = SKILL_COMMAND.exec(text);
	if (!match) return undefined;
	const [, name, args] = match;
	// pi trims the arguments when it expands, so only the arguments' leading
	// whitespace is dropped here (the rest stays byte-identical); empty
	// arguments leave the bare command.
	const trimmed = args.replace(/^[ \t\r\n]+/, "");
	return trimmed.length > 0 ? `/skill:${name} ${trimmed}` : `/skill:${name}`;
}
