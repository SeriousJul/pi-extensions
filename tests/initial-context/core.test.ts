/**
 * Core tests for the initial-context extension: prompt section splitting
 * (including the exact reconstruction of pi's default base prompt),
 * provider payload parsing, prompt injection detection, tool rows, token
 * estimation, percentages, and the plain-text rendering.
 *
 * All fixtures are synthetic, so the tests run anywhere without a real
 * pi session.
 */
import { createSyntheticSourceInfo, formatSkillsForPrompt, type BuildSystemPromptOptions, type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	barFor,
	basePromptFor,
	buildInitialContext,
	buildPromptSections,
	estimateInitialContextTotal,
	estimateTextTokens,
	emptyCaptured,
	formatStatusText,
	parseProviderPayload,
	renderContextText,
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
		expect(kinds).toEqual(["base", "file", "skill", "cwd"]);
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
		expect(sections.map((s) => s.kind)).toEqual(["base", "append", "file", "file", "cwd"]);
		expect(sections[1].text).toBe("\n\nAlways test.");
		expect(sections[2].text.startsWith("\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n")).toBe(true);
		expect(sections[2].text).toContain("Root file.");
		expect(sections[3].text).toContain("Sub file.");
		expect(sections[3].text.endsWith("</project_context>\n")).toBe(true);
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
		// The injection row lands after the cwd row and before the tools.
		const order = injected.rows.map((r) => r.kind);
		expect(order.indexOf("injection")).toBeGreaterThan(order.indexOf("cwd"));
		expect(order.indexOf("injection")).toBeLessThan(order.indexOf("tool"));
	});

	it("flags any other modification", () => {
		const captured = emptyCaptured();
		captured.sentSystem = "TOTALLY DIFFERENT PROMPT";
		const report = buildInitialContext(baseOptions, captured, 200000);
		const row = report.rows.find((r) => r.kind === "injection");
		expect(row?.note).toBe("modified by extension");
		expect(row?.text).toBe("TOTALLY DIFFERENT PROMPT");
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
		expect(lines[2]).toMatch(/^\s+name\s+tokens\s+ctx%\s+win%$/);
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
		expect(baseLine).toMatch(/^\s+base prompt\s+\d[\d,]*\s+\d+\.\d%\s+\d+\.\d%\s+█+$/);
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
