/**
 * Core tests for the initial-context extension: prompt section splitting
 * (including the exact reconstruction of pi's default base prompt),
 * provider payload parsing, prompt injection detection, tool rows, token
 * estimation, percentages, and the plain-text rendering.
 *
 * All fixtures are synthetic, so the tests run anywhere without a real
 * pi session.
 */
import {
	createSyntheticSourceInfo,
	formatSkillsForPrompt,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	type BuildSystemPromptOptions,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	barFor,
	basePromptFor,
	buildInitialContext,
	buildPromptSections,
	capturedToolDescriptions,
	defaultGuidelines,
	duplicatesToolDescription,
	estimateInitialContextTotal,
	estimateTextTokens,
	emptyCaptured,
	formatStatusText,
	longestCommonSubstringLength,
	normalizeForDuplicateCheck,
	parseProviderPayload,
	renderContextText,
	wasteFor,
	type CapturedContext,
	type InitialContextReport,
} from "../../extensions/initial-context/context.ts";

// --- fixtures -------------------------------------------------------------

const skill = (name: string, description: string, filePath: string): Skill => ({
	name,
	description,
	filePath,
	baseDir: "/tmp/skills",
	sourceInfo: createSyntheticSourceInfo(filePath, { source: "test", scope: "project", origin: "top-level" }),
	disableModelInvocation: false,
});

const baseOptions: BuildSystemPromptOptions = {
	cwd: "/tmp/project",
	contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Project instructions here." }],
	skills: [skill("alpha", "First skill", "/tmp/skills/alpha/SKILL.md")],
};

// --- estimation -----------------------------------------------------------

describe("estimateTextTokens", () => {
	it("uses pi's chars/4 estimator", () => {
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abcdefgh")).toBe(2);
	});
});

// --- prompt sections ------------------------------------------------------

describe("buildPromptSections", () => {
	it("reconstructs the default base prompt exactly", () => {
		const sections = buildPromptSections(baseOptions);
		const kinds = sections.map((s) => s.kind);
		// base prompt boilerplate, available-tools block, one section per
		// guideline, then the remaining sections - in prompt text order.
		expect(kinds).toEqual([
			"base",
			"tools",
			"base",
			"guideline",
			"guideline",
			"guideline",
			"base",
			"file",
			"skill",
			"cwd",
		]);
		const full = sections.map((s) => s.text).join("");
		expect(full.startsWith("You are an expert coding assistant operating inside pi")).toBe(true);
		expect(full).toContain("Use bash for file operations like ls, rg, find");
		expect(full).toContain("<project_instructions path=\"/tmp/project/AGENTS.md\">");
		expect(full).toContain("Project instructions here.");
		expect(full).toContain("<available_skills>");
		expect(full).toContain("  <skill>");
		expect(full).toContain("  </skill>");
		expect(full).toContain("</available_skills>");
		expect(full.endsWith("\nCurrent working directory: /tmp/project")).toBe(true);
	});

	it("matches pi's own skill block byte for byte", () => {
		const sections = buildPromptSections(baseOptions);
		const skillText = sections.find((s) => s.kind === "skill")?.text;
		expect(skillText).toBe(formatSkillsForPrompt(baseOptions.skills as Skill[], "read"));
	});

	it("splits multiple skills into one row each, in order", () => {
		const options: BuildSystemPromptOptions = {
			cwd: "/tmp/project",
			skills: [
				skill("one", "First", "/s/one/SKILL.md"),
				skill("two", "Second", "/s/two/SKILL.md"),
			],
		};
		const sections = buildPromptSections(options);
		const skills = sections.filter((s) => s.kind === "skill");
		expect(skills.map((s) => s.label)).toEqual(["one", "two"]);
		expect(skills.map((s) => s.text).join("")).toBe(formatSkillsForPrompt(options.skills as Skill[], "read"));
	});

	it("skips skills that do not invoke the model", () => {
		const options: BuildSystemPromptOptions = {
			cwd: "/tmp/project",
			skills: [skill("hidden", "Hidden", "/s/hidden/SKILL.md")],
		};
		options.skills![0] = { ...options.skills![0], disableModelInvocation: true } as Skill;
		const sections = buildPromptSections(options);
		expect(sections.some((s) => s.kind === "skill")).toBe(false);
	});

	it("splits append, files, and cwd into separate rows", () => {
		const options: BuildSystemPromptOptions = {
			cwd: "/tmp/project",
			appendSystemPrompt: "Always test.",
			contextFiles: [
				{ path: "/tmp/project/AGENTS.md", content: "Root file." },
				{ path: "/tmp/project/sub/AGENTS.md", content: "Sub file." },
			],
		};
		const sections = buildPromptSections(options);
		expect(sections.map((s) => s.kind)).toEqual([
			"base",
			"tools",
			"base",
			"guideline",
			"guideline",
			"guideline",
			"base",
			"append",
			"file",
			"file",
			"cwd",
		]);
		expect(sections.filter((s) => s.kind === "append").map((s) => s.text)).toEqual(["\n\nAlways test."]);
		const files = sections.filter((s) => s.kind === "file");
		expect(files).toHaveLength(2);
		expect(files[0].text.startsWith("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n")).toBe(true);
		expect(files[0].text).toContain("Root file.");
		expect(files[1].text).toContain("Sub file.");
		expect(files[1].text.endsWith("</project_context>\n")).toBe(true);
		// Concatenation reproduces pi's exact file-block layout.
		expect(sections.map((s) => s.text).join("")).toContain("Root file.\n</project_instructions>\n\n<project_instructions path=\"/tmp/project/sub/AGENTS.md\">");
	});

	it("supports a custom prompt", () => {
		const sections = buildPromptSections({ cwd: "/tmp/project", customPrompt: "Be brief." });
		expect(sections[0]).toMatchObject({ label: "custom prompt", kind: "base", text: "Be brief." });
		expect(sections[sections.length - 1].text).toBe("\nCurrent working directory: /tmp/project\n");
	});
});

// --- payload parsing ------------------------------------------------------

describe("parseProviderPayload", () => {
	it("parses the OpenAI payload shape", () => {
		const parsed = parseProviderPayload({
			messages: [
				{ role: "system", content: "SYSTEM" },
				{ role: "user", content: "hi" },
			],
			tools: [
				{ type: "function", function: { name: "read", description: "Reads a file.", parameters: { type: "object" } } },
				{ type: "function", function: { name: "bash", description: "Runs a command.", parameters: { type: "object" } } },
			],
		});
		expect(parsed.system).toBe("SYSTEM");
		expect(parsed.tools.map((t) => t.name)).toEqual(["read", "bash"]);
		const read = JSON.parse(parsed.tools[0].raw) as { name: string; description: string };
		expect(read.name).toBe("read");
		expect(read.description).toBe("Reads a file.");
	});

	it("parses the Anthropic payload shape", () => {
		const parsed = parseProviderPayload({
			system: [{ type: "text", text: "SYSTEM-A" }],
			tools: [{ name: "bash", description: "Runs a command.", input_schema: { type: "object" } }],
		});
		expect(parsed.system).toBe("SYSTEM-A");
		expect(parsed.tools).toHaveLength(1);
		expect(parsed.tools[0].name).toBe("bash");
	});

	it("parses a string system and string content blocks", () => {
		const parsed = parseProviderPayload({
			system: "PLAIN",
			tools: [{ name: "edit" }],
		});
		expect(parsed.system).toBe("PLAIN");
		expect(parsed.tools[0].name).toBe("edit");
	});

	it("returns empty results for unrecognized payloads", () => {
		expect(parseProviderPayload({ foo: 1 })).toEqual({ tools: [] });
		expect(parseProviderPayload("not an object")).toEqual({ tools: [] });
		expect(parseProviderPayload(null)).toEqual({ tools: [] });
		expect(parseProviderPayload({ tools: [42, { noName: true }] })).toEqual({ tools: [] });
	});

	it("joins multiple system blocks", () => {
		const parsed = parseProviderPayload({ system: [{ type: "text", text: "A" }, { type: "text", text: "B" }] });
		expect(parsed.system).toBe("A\nB");
	});
});

// --- injection detection --------------------------------------------------

describe("injection detection", () => {
	it("reports no injection row for an unmodified prompt", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		expect(report.rows.some((r) => r.kind === "injection")).toBe(false);
	});

	it("reports a clean suffix as an injection row", () => {
		const base = basePromptFor(baseOptions);
		const suffix = "\n\nYou are now helping with E2E work.";
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		const row = report.rows.find((r) => r.kind === "injection");
		expect(row).toBeUndefined();
		const captured = emptyCaptured();
		captured.sentSystem = base + suffix;
		const injected = buildInitialContext(baseOptions, captured, 200000);
		const inRow = injected.rows.find((r) => r.kind === "injection");
		expect(inRow?.text).toBe(suffix);
		expect(inRow?.note).toBeUndefined();
		expect(inRow?.source).toBe("extension");
	});

	it("flags any other modification", () => {
		const captured = emptyCaptured();
		captured.sentSystem = "TOTALLY DIFFERENT PROMPT";
		const report = buildInitialContext(baseOptions, captured, 200000);
		const row = report.rows.find((r) => r.kind === "injection");
		expect(row?.note).toBe("modified by extension");
		expect(row?.text).toBe("TOTALLY DIFFERENT PROMPT");
		expect(row?.source).toBe("extension");
	});
});

// --- base prompt split rows (issue #85) ----------------------------------

describe("base prompt split rows", () => {
	const splitOptions: BuildSystemPromptOptions = {
		...baseOptions,
		toolSnippets: { read: "Read files.", bash: "Run commands." },
		promptGuidelines: ["Prefer small, boring commits."],
	};

	it("renders the boilerplate, the available-tools block, and one row per guideline", () => {
		const report = buildInitialContext(splitOptions, emptyCaptured(), 200000);
		const labels = report.rows.map((r) => r.label);
		expect(labels).toContain("base prompt");
		expect(labels).toContain("available tools");
		expect(labels).toContain("Use bash for file operations like ls, rg, find");
		expect(labels).toContain("Prefer small, boring commits.");
		expect(labels).toContain("Be concise in your responses");
		expect(labels).toContain("Show file paths clearly when working with files");
		const toolsRow = report.rows.find((r) => r.kind === "tools") as InitialContextReport["rows"][number];
		expect(toolsRow.text).toBe("- read: Read files.\n- bash: Run commands.");
		expect(toolsRow.source).toBe("builtin");
		const guidelines = report.rows.filter((r) => r.kind === "guideline");
		expect(
			guidelines
				.map((g) => [g.label, g.source])
				.sort((a, b) => a[0].localeCompare(b[0])),
		).toEqual([
			["Be concise in your responses", "builtin"],
			["Prefer small, boring commits.", "extension"],
			["Show file paths clearly when working with files", "builtin"],
			["Use bash for file operations like ls, rg, find", "builtin"],
		]);
		// Each guideline row carries its bullet exactly as the prompt sends it;
		// rows after the first own the separator newline before their bullet.
		expect(guidelines.every((g) => g.text.replace(/^\n/, "").startsWith("- "))).toBe(true);
	});

	it("keeps the split section texts concatenating to the exact base prompt", () => {
		// No append, files, or skills: the sections are the base-prompt pieces only.
		const sections = buildPromptSections({
			cwd: "/tmp/project",
			toolSnippets: { read: "Read files.", bash: "Run commands." },
			promptGuidelines: ["Prefer small, boring commits."],
		} as BuildSystemPromptOptions);
		const expected = [
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			"",
			"Available tools:",
			"- read: Read files.",
			"- bash: Run commands.",
			"",
			"In addition to the tools above, you may have access to other custom tools depending on the project.",
			"",
			"Guidelines:",
			"- Use bash for file operations like ls, rg, find",
			"- Prefer small, boring commits.",
			"- Be concise in your responses",
			"- Show file paths clearly when working with files",
			"",
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
			`- Main documentation: ${getReadmePath()}`,
			`- Additional docs: ${getDocsPath()}`,
			`- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
			"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
			"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
			"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
			"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
			"Current working directory: /tmp/project",
		].join("\n");
		expect(sections.map((s) => s.text).join("")).toBe(expected);
	});

	it("leaves the report total unchanged: the prompt as one unit plus the tool rows", () => {
		const report = buildInitialContext(splitOptions, emptyCaptured(), 200000);
		const toolSum = report.rows.filter((r) => r.kind === "tool").reduce((sum, r) => sum + r.tokens, 0);
		expect(report.totalTokens).toBe(estimateTextTokens(basePromptFor(splitOptions)) + toolSum);
	});

	it("keeps a custom prompt as a single row without a split", () => {
		const report = buildInitialContext({ cwd: "/tmp/project", customPrompt: "Be brief." } as BuildSystemPromptOptions, emptyCaptured(), 200000);
		const base = report.rows.find((r) => r.kind === "base") as InitialContextReport["rows"][number];
		expect(base.label).toBe("custom prompt");
		expect(base.text).toBe("Be brief.");
		expect(report.rows.some((r) => r.kind === "tools")).toBe(false);
		expect(report.rows.some((r) => r.kind === "guideline")).toBe(false);
	});
});

describe("defaultGuidelines", () => {
	it("attributes pi's default bullets to builtin and the registered rest to extension", () => {
		const guidelines = defaultGuidelines({
			cwd: "/tmp/project",
			promptGuidelines: ["Prefer small, boring commits.", "Be concise in your responses"],
		} as BuildSystemPromptOptions);
		expect(guidelines).toEqual([
			{ text: "Use bash for file operations like ls, rg, find", source: "builtin" },
			{ text: "Prefer small, boring commits.", source: "extension" },
			{ text: "Be concise in your responses", source: "builtin" },
			{ text: "Show file paths clearly when working with files", source: "builtin" },
		]);
	});

	it("drops the tool bullet when a dedicated search tool is available", () => {
		const guidelines = defaultGuidelines({ cwd: "/tmp/project", selectedTools: ["read", "bash", "grep"] } as BuildSystemPromptOptions);
		expect(guidelines.map((g) => g.text)).toEqual(["Be concise in your responses", "Show file paths clearly when working with files"]);
	});

	it("deduplicates on the first occurrence, keeping the prompt order", () => {
		const guidelines = defaultGuidelines({
			cwd: "/tmp/project",
			promptGuidelines: ["Use bash for file operations like ls, rg, find"],
		} as BuildSystemPromptOptions);
		expect(guidelines.filter((g) => g.text === "Use bash for file operations like ls, rg, find")).toHaveLength(1);
	});
});

// --- duplicate tool description flag (issue #86) ----------------------------

const LONG_DESCRIPTION =
	"Read file contents. Supports text files and images. Use offset and limit for large files. Output is truncated to the last 2000 lines or 50KB, whichever is hit first.";

function capturedWithTools(entries: { name: string; raw: string }[]): CapturedContext {
	const captured = emptyCaptured();
	captured.tools = entries;
	return captured;
}

function toolEntry(name: string, description: string): { name: string; raw: string } {
	return { name, raw: JSON.stringify({ name, description, parameters: {} }) };
}

describe("duplicate tool description flag", () => {
	const flaggedOptions: BuildSystemPromptOptions = {
		...baseOptions,
		promptGuidelines: [LONG_DESCRIPTION],
	};

	it("flags a verbatim copy of a sent tool description, after the first provider request", () => {
		const report = buildInitialContext(flaggedOptions, capturedWithTools([toolEntry("read", LONG_DESCRIPTION)]), 200000);
		const row = report.rows.find((r) => r.kind === "guideline" && r.label === LONG_DESCRIPTION);
		expect(row?.note).toBe("duplicates tool description");
	});

	it("flags the prefixed shape 'Use my_tool to <verbatim description>'", () => {
		const guideline = `Use my_tool to ${LONG_DESCRIPTION}`;
		const options = { ...flaggedOptions, promptGuidelines: [guideline] };
		const report = buildInitialContext(options, capturedWithTools([toolEntry("my_tool", LONG_DESCRIPTION)]), 200000);
		const row = report.rows.find((r) => r.kind === "guideline" && r.label === guideline);
		expect(row?.note).toBe("duplicates tool description");
	});

	it("does not flag a guideline that only adds trigger conditions", () => {
		const guideline = "Use my_tool to read a file's contents when the user asks to see what is in it.";
		const options = { ...flaggedOptions, promptGuidelines: [guideline] };
		const report = buildInitialContext(options, capturedWithTools([toolEntry("my_tool", LONG_DESCRIPTION)]), 200000);
		const row = report.rows.find((r) => r.kind === "guideline" && r.label === guideline);
		expect(row?.note).toBeUndefined();
	});

	it("does not flag a short guideline under the 24-character floor", () => {
		const guideline = "Read files.";
		const options = { ...flaggedOptions, promptGuidelines: [guideline] };
		const report = buildInitialContext(options, capturedWithTools([toolEntry("read", `blah ${guideline} blah`)]), 200000);
		const row = report.rows.find((r) => r.kind === "guideline" && r.label === guideline);
		expect(row?.note).toBeUndefined();
	});

	it("shows no flag before the first provider request", () => {
		const report = buildInitialContext(flaggedOptions, emptyCaptured(), 200000);
		expect(report.rows.find((r) => r.kind === "guideline")?.note).toBeUndefined();
	});

	it("never flags the available-tools snippets", () => {
		const options = { ...baseOptions, toolSnippets: { read: LONG_DESCRIPTION } };
		const report = buildInitialContext(options, capturedWithTools([toolEntry("read", LONG_DESCRIPTION)]), 200000);
		const row = report.rows.find((r) => r.kind === "tools");
		expect(row?.note).toBeUndefined();
	});

	it("shows the note in the text table", () => {
		const report = buildInitialContext(flaggedOptions, capturedWithTools([toolEntry("read", LONG_DESCRIPTION)]), 200000);
		expect(renderContextText(report)).toContain("(duplicates tool description)");
	});
});

describe("duplicatesToolDescription", () => {
	it("normalizes case, punctuation, and whitespace on both sides", () => {
		expect(normalizeForDuplicateCheck("  Hello,  WORLD;  ")).toBe("hello world");
	});

	it("measures the longest common substring", () => {
		expect(longestCommonSubstringLength("abcde", "zabcy")).toBe(3);
		expect(longestCommonSubstringLength("", "abc")).toBe(0);
	});

	it("requires the common substring to cover 80 percent of the guideline", () => {
		const shared = "a".repeat(80);
		const guideline = shared + "b".repeat(20);
		expect(duplicatesToolDescription(guideline, [shared + "c".repeat(50)])).toBe(true);
		expect(duplicatesToolDescription(shared.slice(0, 79) + "b".repeat(21), [shared + "c".repeat(50)])).toBe(false);
	});

	it("requires the common substring to be at least 24 characters", () => {
		const shared = "a".repeat(23);
		expect(duplicatesToolDescription(shared + "b", [shared + "c".repeat(50)])).toBe(false);
	});

	it("ignores case, punctuation, and extra spaces when comparing", () => {
		const description = "Run a shell command and report the output.";
		expect(duplicatesToolDescription(`run a shell command and report the output?`, [description])).toBe(true);
	});
});

describe("capturedToolDescriptions", () => {
	it("reads the descriptions off the captured entries and skips placeholders", () => {
		const captured = capturedWithTools([toolEntry("read", "Reads a file."), { name: "mcp", raw: "mcp tool schema" }]);
		expect(capturedToolDescriptions(captured)).toEqual(["Reads a file."]);
	});

	it("returns none before the first provider request", () => {
		expect(capturedToolDescriptions(emptyCaptured())).toEqual([]);
	});
});

// --- tool rows ------------------------------------------------------------

describe("tool rows", () => {
	it("rebuilds built-in schemas before the first call", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		const tools = report.rows.filter((r) => r.kind === "tool");
		expect([...tools.map((t) => t.label)].sort()).toEqual(["bash", "edit", "read", "write"]);
		expect(tools.every((t) => t.note === "built-in schema")).toBe(true);
		const bash = JSON.parse(tools.find((t) => t.label === "bash")!.text) as { name: string; description: string; parameters: unknown };
		expect(bash.name).toBe("bash");
		expect(typeof bash.description).toBe("string");
		expect(bash.parameters).toBeTruthy();
	});

	it("lists unresolvable custom tools by name", () => {
		const options: BuildSystemPromptOptions = { cwd: "/tmp/project", selectedTools: ["read", "my_tool"] };
		const report = buildInitialContext(options, emptyCaptured(), 200000);
		const tools = report.rows.filter((r) => r.kind === "tool");
		expect(tools.map((t) => t.label)).toEqual(["read", "my_tool"]);
		const myTool = tools.find((t) => t.label === "my_tool");
		expect(myTool?.note).toBe("waiting for first call");
		expect(myTool?.text).toBe("my_tool");
	});

	it("sorts tools by estimated size, largest first", () => {
		const options: BuildSystemPromptOptions = { cwd: "/tmp/project", selectedTools: ["bash", "read"] };
		const report = buildInitialContext(options, emptyCaptured(), 200000);
		const tools = report.rows.filter((r) => r.kind === "tool");
		const sizes = tools.map((t) => t.tokens);
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
	});

	it("prefers captured provider tool entries, including custom tools", () => {
		const captured = emptyCaptured();
		captured.tools = [
			{ name: "read", raw: JSON.stringify({ name: "read", description: "d", parameters: {} }) },
			{ name: "my_tool", raw: JSON.stringify({ name: "my_tool", description: "x".repeat(400), parameters: {} }) },
		];
		const report = buildInitialContext(baseOptions, captured, 200000);
		const tools = report.rows.filter((r) => r.kind === "tool");
		expect(tools.map((t) => t.label)).toEqual(["my_tool", "read"]);
		expect(tools.every((t) => t.note === undefined)).toBe(true);
	});
});

// --- report totals and percentages ----------------------------------------

describe("buildInitialContext", () => {
	it("estimates the sent prompt as one unit plus the tool rows", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		const toolSum = report.rows.filter((r) => r.kind === "tool").reduce((s, r) => s + r.tokens, 0);
		expect(report.totalTokens).toBe(estimateTextTokens(basePromptFor(baseOptions)) + toolSum);
		expect(report.windowPercent).toBeCloseTo((report.totalTokens / 200000) * 100, 5);
	});

	it("uses the sent prompt for the total when captured", () => {
		const captured = emptyCaptured();
		captured.sentSystem = "SENT";
		const report = buildInitialContext(baseOptions, captured, 200000);
		const toolSum = report.rows.filter((r) => r.kind === "tool").reduce((s, r) => s + r.tokens, 0);
		expect(report.totalTokens).toBe(estimateTextTokens("SENT") + toolSum);
	});

	it("omits window fields without a context window", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured());
		expect(report.contextWindow).toBeUndefined();
		expect(report.windowPercent).toBeUndefined();
	});

	it("carries the provider reference through", () => {
		const captured = emptyCaptured();
		captured.providerInputTokens = 44900;
		const report = buildInitialContext(baseOptions, captured, 200000);
		expect(report.providerInputTokens).toBe(44900);
	});

	it("estimates every row with pi's estimator", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		for (const row of report.rows) {
			expect(row.tokens).toBe(Math.ceil(row.text.length / 4));
		}
	});

	it("sorts rows by size, largest first", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		const sizes = report.rows.map((r) => r.tokens);
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
	});

	it("labels the source of every row kind", () => {
		const captured = emptyCaptured();
		captured.tools = [
			{ name: "read", raw: JSON.stringify({ name: "read", description: "d", parameters: {} }) },
			{ name: "my_tool", raw: JSON.stringify({ name: "my_tool", description: "d", parameters: {} }) },
		];
		const rows = buildInitialContext(baseOptions, captured, 200000).rows;
		expect(rows.find((r) => r.kind === "base")?.source).toBe("builtin");
		expect(rows.find((r) => r.kind === "file")?.source).toBe("file");
		expect(rows.find((r) => r.kind === "skill")?.source).toBe("skill");
		expect(rows.find((r) => r.kind === "cwd")?.source).toBe("builtin");
		expect(rows.find((r) => r.key === "tool:read")?.source).toBe("builtin");
		expect(rows.find((r) => r.key === "tool:my_tool")?.source).toBe("extension");
	});

	it("labels append text as settings-sourced", () => {
		const options = { ...baseOptions, appendSystemPrompt: "Be concise." };
		const rows = buildInitialContext(options, emptyCaptured(), 200000).rows;
		expect(rows.find((r) => r.kind === "append")?.source).toBe("settings");
	});
});

// --- footer estimate ------------------------------------------------------

describe("estimateInitialContextTotal", () => {
	it("matches the full report before the first call", () => {
		const report = buildInitialContext(baseOptions, emptyCaptured(), 200000);
		const estimate = estimateInitialContextTotal({
			basePrompt: basePromptFor(baseOptions),
			options: baseOptions,
			cwd: baseOptions.cwd,
			captured: emptyCaptured(),
			contextWindow: 200000,
		});
		expect(estimate.totalTokens).toBe(report.totalTokens);
	});

	it("uses the sent prompt and captured tools after the first call", () => {
		const captured = emptyCaptured();
		captured.sentSystem = "SENT SYSTEM";
		captured.tools = [{ name: "read", raw: JSON.stringify({ name: "read", description: "d", parameters: {} }) }];
		const estimate = estimateInitialContextTotal({
			basePrompt: "IGNORED LIVE PROMPT",
			cwd: "/tmp/project",
			captured,
			contextWindow: 100000,
		});
		expect(estimate.totalTokens).toBe(estimateTextTokens("SENT SYSTEM") + estimateTextTokens(captured.tools![0].raw));
		expect(estimate.windowPercent).toBeCloseTo((estimate.totalTokens / 100000) * 100, 5);
	});

	it("falls back to the default tools when the options are unknown", () => {
		const estimate = estimateInitialContextTotal({
			basePrompt: "PROMPT",
			cwd: "/tmp/project",
			captured: emptyCaptured(),
			contextWindow: 100000,
		});
		const tools = buildInitialContext({ cwd: "/tmp/project" }, emptyCaptured()).rows.filter((r) => r.kind === "tool");
		expect(estimate.totalTokens).toBe(estimateTextTokens("PROMPT") + tools.reduce((s, r) => s + r.tokens, 0));
	});
});

// --- rendering ------------------------------------------------------------

describe("renderContextText", () => {
	const report = (): InitialContextReport => {
		const captured = emptyCaptured();
		captured.providerInputTokens = 44900;
		return buildInitialContext(baseOptions, captured, 200000);
	};

	it("renders the title, rows, total, and reference", () => {
		const text = renderContextText(report());
		const lines = text.split("\n");
		expect(lines[0]).toMatch(/^initial context: [\d,]+ tokens \(\d+\.\d% of 200,000 window\)$/);
		expect(lines[1]).toBe("");
		expect(lines[2]).toMatch(/^\s+name\s+src\s+tokens\s+ctx%\s+win%$/);
		expect(text).toContain("base prompt");
		expect(text).toContain("/tmp/project/AGENTS.md");
		expect(text).toContain("alpha");
		expect(text).toContain("cwd");
		expect(text).toContain("(built-in schema)");
		expect(text).toMatch(/\bTOTAL\b/);
		expect(text).toContain("provider report (first call): 44,900 input tokens");
	});

	it("renders each row's percentages and a bar", () => {
		const text = renderContextText(report());
		const lines = text.split("\n");
		const baseLine = lines.find((l) => l.trimStart().startsWith("base prompt")) as string;
		expect(baseLine).toMatch(/^\s+base prompt\s+builtin\s+\d[\d,]*\s+\d+\.\d%\s+\d+\.\d%\s+█+$/);
	});

	it("renders a header without window info", () => {
		const text = renderContextText(buildInitialContext(baseOptions, emptyCaptured()));
		expect(text.split("\n")[0]).toMatch(/^initial context: [\d,]+ tokens$/);
		expect(text).not.toContain("provider report");
	});

	it("renders a TOTAL row at 100% of the initial context", () => {
		const text = renderContextText(report());
		const totalLine = text.split("\n").find((l) => /\bTOTAL\b/.test(l)) as string;
		expect(totalLine).toMatch(/\bTOTAL\b\s+\d[\d,]*\s+100\.0%\s+\d+\.\d%\s+█{12}$/);
	});

	it("renders the waste column only with a usage view", () => {
		// No usage view: no waste column at all.
		expect(renderContextText(report())).not.toContain("waste");

		// With a usage view: the header gains the column, a tool the window
		// saw shows tokens per use, and a tool it never used shows the mark.
		const counts: Record<string, number> = {};
		for (const row of report().rows) if (row.kind === "tool") counts[row.label] = 0;
		counts.read = 4;
		const text = renderContextText(report(), { window: "30d", counts });
		expect(text).toContain("uses(30d)  waste");
		const readLine = text.split("\n").find((l) => l.trim().startsWith("read")) as string;
		const readTokens = report().rows.find((r) => r.label === "read")!.tokens;
		expect(readLine).toContain(`${(readTokens / 4).toFixed(1)}/u`);
		const bashLine = text.split("\n").find((l) => l.trim().startsWith("bash")) as string;
		expect(bashLine).toContain("never");
		// Section rows and TOTAL carry no waste value.
		const totalLine = text.split("\n").find((l) => /\bTOTAL\b/.test(l)) as string;
		expect(totalLine).toMatch(/\s-  █{12}$/);
		const baseLine = text.split("\n").find((l) => l.trim().startsWith("base prompt")) as string;
		expect(baseLine).toContain("  -  ");
	});
});

describe("wasteFor", () => {
	const row = (label: string, kind: string, tokens: number) => ({
		key: `tool:${label}`,
		label,
		kind,
		source: "builtin",
		text: label,
		tokens,
	}) as InitialContextReport["rows"][number];

	it("computes tokens per use, the never mark, and dashes for non-tool rows", () => {
		expect(wasteFor(row("bash", "tool", 936), { bash: 3 })).toBe("312.0/u");
		expect(wasteFor(row("bash", "tool", 936), { bash: 0 })).toBe("never");
		expect(wasteFor(row("bash", "tool", 936), undefined)).toBe("-");
		expect(wasteFor(row("alpha", "skill", 100), { alpha: 2 })).toBe("-");
		expect(wasteFor(row("base", "base", 500), { base: 9 })).toBe("-");
	});
});

describe("formatStatusText", () => {
	// The count is human-readable and locale-aware (system prefs): the test
	// builds the expectation with the same system-locale formatter.
	const compact = (n: number) =>
		new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

	it("formats the footer with and without a window", () => {
		expect(formatStatusText(45230, 11.3075)).toBe(`ctx: ${compact(45230)} (11.3%)`);
		expect(formatStatusText(45230)).toBe(`ctx: ${compact(45230)}`);
	});

	it("reads a mid-thousands count as a K value, not a digit-grouped one", () => {
		expect(formatStatusText(4492)).not.toContain("4,492");
		expect(formatStatusText(4492)).toContain(compact(4492));
	});
});

describe("barFor", () => {
	it("scales to the width with a minimum of one block", () => {
		expect(barFor(100, 12)).toBe("█".repeat(12));
		expect(barFor(50, 12)).toBe("█".repeat(6));
		expect(barFor(0.1, 12)).toBe("█");
		expect(barFor(0)).toBe("");
		expect(barFor(undefined)).toBe("");
	});
});
