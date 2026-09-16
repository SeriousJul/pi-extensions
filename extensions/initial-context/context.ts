/**
 * Pure core of the initial-context extension.
 *
 * Builds the line-by-line breakdown of the Initial context (the system
 * prompt and the tool definitions, resent to the model on every LLM call)
 * from the same structured inputs pi uses to build the prompt, optionally
 * combined with the last observed provider request payload. All the logic
 * lives here: row construction, provider payload parsing, prompt injection
 * detection, token estimation, and the plain-text rendering. The extension
 * entry only wires pi events and the UI to these functions.
 */
import {
	estimateTokens,
	formatSkillsForPrompt,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One tool entry exactly as it was sent (or rebuilt) to the model. */
export interface ToolEntry {
	name: string;
	/** Raw JSON of the tool entry, the form the model receives. */
	raw: string;
}

/** Parsed shape of one provider request payload. */
export interface ParsedPayload {
	/** The system prompt string sent, when the payload carried one. */
	system?: string;
	/** Tool entries, in the order sent. */
	tools: ToolEntry[];
}

/** State captured from live pi events. Reset on every session start. */
export interface CapturedContext {
	/** Tool entries from the last provider request, if any. */
	tools?: ToolEntry[];
	/** System prompt string sent in the last provider request, if any. */
	sentSystem?: string;
	/** Input tokens the provider reported on the first assistant message. */
	providerInputTokens?: number;
}

export function emptyCaptured(): CapturedContext {
	return {};
}

/** Where one report row comes from. */
export type RowKind = "base" | "append" | "file" | "skill" | "cwd" | "injection" | "tool";

/** One line of the breakdown. */
export interface InitialContextRow {
	key: string;
	label: string;
	kind: RowKind;
	/** The exact text this row contributes to the prompt or tool list. */
	text: string;
	/** Display note, e.g. "built-in schema" or "modified by extension". */
	note?: string;
	tokens: number;
}

/** The full breakdown. */
export interface InitialContextReport {
	rows: InitialContextRow[];
	totalTokens: number;
	contextWindow?: number;
	/** Initial context total as a percentage of the context window. */
	windowPercent?: number;
	/** Provider-reported input tokens from the first call. Display only. */
	providerInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Token estimate of a plain text, using pi's own estimator (chars / 4), so
 * every row shares one consistent scale.
 */
export function estimateTextTokens(text: string): number {
	const message = { role: "user", content: text, timestamp: 0 } as AgentMessage;
	return estimateTokens(message);
}

// ---------------------------------------------------------------------------
// Provider payload parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonStable(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * Extract the system prompt and tool entries from one provider request
 * payload, across the common provider shapes:
 * - OpenAI style: messages[0] is the system message; tools are
 *   { type: "function", function: { name, description, parameters } }.
 * - Anthropic style: system is a string or content-block array; tools are
 *   { name, description, input_schema }.
 * Returns empty results for anything unrecognized. This function only
 * reads the payload; it never mutates it.
 */
export function parseProviderPayload(payload: unknown): ParsedPayload {
	if (!isRecord(payload)) return { tools: [] };

	let system: string | undefined;
	const rawTools: unknown[] = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];

	const rawSystem = payload.system;
	if (typeof rawSystem === "string") {
		system = rawSystem;
	} else if (Array.isArray(rawSystem)) {
		const parts: string[] = [];
		for (const block of rawSystem) {
			if (typeof block === "string") {
				parts.push(block);
			} else if (isRecord(block) && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) system = parts.join("\n");
	} else if (Array.isArray(payload.messages)) {
		for (const message of payload.messages) {
			if (!isRecord(message) || message.role !== "system") continue;
			if (typeof message.content === "string") {
				system = message.content;
				break;
			}
			if (Array.isArray(message.content)) {
				const parts: string[] = [];
				for (const block of message.content) {
					if (typeof block === "string") {
						parts.push(block);
					} else if (isRecord(block) && typeof block.text === "string") {
						parts.push(block.text);
					}
				}
				if (parts.length > 0) {
					system = parts.join("\n");
					break;
				}
			}
		}
	}

	const tools: ToolEntry[] = [];
	for (const entry of rawTools) {
		if (!isRecord(entry)) continue;
		let name: unknown = entry.name;
		let raw: unknown = entry;
		if (isRecord(entry.function)) {
			name = entry.function.name;
			raw = entry.function;
		}
		if (typeof name !== "string" || name.length === 0) continue;
		tools.push({ name, raw: jsonStable(raw) });
	}

	return { system, tools };
}

// ---------------------------------------------------------------------------
// Base prompt reconstruction
// ---------------------------------------------------------------------------

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Reconstruct pi's default base prompt from the same structured inputs pi
 * uses. Duplicates the template in pi's system-prompt.ts, because pi does
 * not export the builder itself. The reconstruction is exact: the E2E test
 * asserts that no injection row appears for an unmodified session.
 */
function defaultBasePrompt(options: BuildSystemPromptOptions): string {
	const tools = options.selectedTools && options.selectedTools.length > 0 ? options.selectedTools : DEFAULT_TOOLS;
	const snippets = options.toolSnippets ?? {};
	const visibleTools = tools.filter((name) => snippets[name] !== undefined && snippets[name] !== "");
	const toolsList =
		visibleTools.length > 0
			? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n")
			: "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const add = (guideline: string): void => {
		if (!guidelinesSet.has(guideline)) {
			guidelinesSet.add(guideline);
			guidelinesList.push(guideline);
		}
	};
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			add("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			add("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			add("Use bash for file operations like ls, rg, find");
		}
	}
	for (const guideline of options.promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) add(normalized);
	}
	add("Be concise in your responses");
	add("Show file paths clearly when working with files");
	const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");

	return [
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
		"",
		"Available tools:",
		toolsList,
		"",
		"In addition to the tools above, you may have access to other custom tools depending on the project.",
		"",
		"Guidelines:",
		guidelines,
		"",
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${getReadmePath()}`,
		`- Additional docs: ${getDocsPath()}`,
		`- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
		"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
		"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
		"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
	].join("\n");
}

interface Section {
	key: string;
	label: string;
	kind: RowKind;
	text: string;
}

/**
 * Split the full base prompt into its sections, in the fixed block order
 * (base, append, project files, skills, cwd). Concatenating the section
 * texts reproduces the base prompt exactly.
 */
export function buildPromptSections(options: BuildSystemPromptOptions): Section[] {
	const promptCwd = options.cwd.replace(/\\/g, "/");
	const isCustom = options.customPrompt !== undefined;
	const sections: Section[] = [];

	sections.push({
		key: "base",
		label: isCustom ? "custom prompt" : "base prompt",
		kind: "base",
		text: isCustom ? (options.customPrompt as string) : defaultBasePrompt(options),
	});

	if (options.appendSystemPrompt) {
		sections.push({ key: "append", label: "append text", kind: "append", text: `\n\n${options.appendSystemPrompt}` });
	}

	const files = options.contextFiles ?? [];
	const head = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	const tail = "</project_context>\n";
	files.forEach((file, index) => {
		let text = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
		if (index === 0) text = head + text;
		if (index === files.length - 1) text += tail;
		sections.push({ key: `file:${file.path}`, label: file.path, kind: "file", text });
	});

	const tools = options.selectedTools && options.selectedTools.length > 0 ? options.selectedTools : DEFAULT_TOOLS;
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
	const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skillFileReadTool && skills.length > 0) {
		const block = formatSkillsForPrompt(skills, skillFileReadTool);
		const first = block.indexOf("  <skill>");
		const header = first === -1 ? block : block.slice(0, first);
		const rest = first === -1 ? "" : block.slice(first);
		const endMarker = "  </skill>";
		let start = 0;
		skills.forEach((skill, index) => {
			// The last skill row keeps the trailing `</available_skills>`.
			const isLast = index === skills.length - 1;
			const end = isLast ? rest.length : rest.indexOf(endMarker, start);
			const stop = end === -1 ? rest.length : end + endMarker.length;
			const piece = (index === 0 ? header : "") + rest.slice(start, stop);
			sections.push({ key: `skill:${skill.name}`, label: skill.name, kind: "skill", text: piece });
			start = stop;
		});
	}

	sections.push({
		key: "cwd",
		label: "cwd",
		kind: "cwd",
		text: isCustom ? `\nCurrent working directory: ${promptCwd}\n` : `\nCurrent working directory: ${promptCwd}`,
	});

	return sections;
}

/** The full base prompt pi would build from these options. */
export function basePromptFor(options: BuildSystemPromptOptions): string {
	return buildPromptSections(options).map((section) => section.text).join("");
}

// ---------------------------------------------------------------------------
// Prompt injection detection
// ---------------------------------------------------------------------------

/**
 * Compare the system prompt actually sent to the model with the
 * reconstruction. An exact match means no other extension touched the
 * prompt. A strict suffix is the documented before_agent_start injection.
 * Any other difference is reported as "modified by extension".
 */
function injectionRow(sections: Section[], sentSystem: string | undefined): InitialContextRow | undefined {
	if (sentSystem === undefined) return undefined;
	const baseFull = sections.map((section) => section.text).join("");
	if (sentSystem === baseFull) return undefined;
	if (baseFull.length < sentSystem.length && sentSystem.startsWith(baseFull)) {
		const suffix = sentSystem.slice(baseFull.length);
		return {
			key: "injection",
			label: "injection",
			kind: "injection",
			text: suffix,
			tokens: estimateTextTokens(suffix),
		};
	}
	return {
		key: "injection",
		label: "injection",
		kind: "injection",
		note: "modified by extension",
		text: sentSystem,
		tokens: estimateTextTokens(sentSystem),
	};
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

const BUILTIN_TOOL_FACTORIES: Record<string, (cwd: string) => { name: string; description: string; parameters: unknown }> = {
	bash: (cwd) => createBashToolDefinition(cwd),
	edit: (cwd) => createEditToolDefinition(cwd),
	read: (cwd) => createReadToolDefinition(cwd),
	write: (cwd) => createWriteToolDefinition(cwd),
};

function builtinToolRaw(name: string, cwd: string): string | undefined {
	const factory = BUILTIN_TOOL_FACTORIES[name];
	if (!factory) return undefined;
	try {
		const definition = factory(cwd);
		return jsonStable({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
		});
	} catch {
		return undefined;
	}
}

/**
 * Tool rows. Uses the last captured provider request when available (the
 * exact entries, including custom tools); otherwise rebuilds built-in
 * schemas from pi's exported factories and lists unresolvable tools by name.
 * Rows are sorted by estimated size, largest first.
 */
function buildToolRows(options: BuildSystemPromptOptions, captured: CapturedContext): InitialContextRow[] {
	let entries: { name: string; raw: string; note?: string }[];
	if (captured.tools && captured.tools.length > 0) {
		entries = captured.tools.map((tool) => ({ name: tool.name, raw: tool.raw }));
	} else {
		const names = options.selectedTools && options.selectedTools.length > 0 ? options.selectedTools : DEFAULT_TOOLS;
		entries = names.map((name) => {
			const raw = builtinToolRaw(name, options.cwd);
			if (raw !== undefined) {
				return { name, raw, note: "built-in schema" };
			}
			return { name, raw: name, note: "waiting for first call" };
		});
	}
	const rows = entries.map((entry) => ({
		key: `tool:${entry.name}`,
		label: entry.name,
		kind: "tool" as RowKind,
		note: entry.note,
		text: entry.raw,
		tokens: estimateTextTokens(entry.raw),
	}));
	rows.sort((a, b) => b.tokens - a.tokens);
	return rows;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Build the full breakdown from the prompt options and the captured state.
 * Row order: base, append, project files, skills, cwd, injection, tools.
 */
export function buildInitialContext(
	options: BuildSystemPromptOptions,
	captured: CapturedContext,
	contextWindow?: number,
): InitialContextReport {
	const sections = buildPromptSections(options);
	const rows: InitialContextRow[] = sections.map((section) => ({
		key: section.key,
		label: section.label,
		kind: section.kind,
		text: section.text,
		tokens: estimateTextTokens(section.text),
	}));

	const injection = injectionRow(sections, captured.sentSystem);
	if (injection) rows.push(injection);

	rows.push(...buildToolRows(options, captured));

	// The total estimates the prompt exactly as it is sent (one unit, the
	// way the provider sees it) plus the tool entries. The per-row numbers
	// estimate each row's text and sum to within a few tokens.
	const promptText = captured.sentSystem ?? sections.map((section) => section.text).join("");
	const totalTokens = estimateTextTokens(promptText) + rows.filter((row) => row.kind === "tool").reduce((sum, row) => sum + row.tokens, 0);
	const window = contextWindow && contextWindow > 0 ? contextWindow : undefined;
	return {
		rows,
		totalTokens,
		contextWindow: window,
		windowPercent: window ? (totalTokens / window) * 100 : undefined,
		providerInputTokens: captured.providerInputTokens,
	};
}

// ---------------------------------------------------------------------------
// Footer status
// ---------------------------------------------------------------------------

/** Inputs for the lightweight footer estimate. */
export interface StatusEstimateInput {
	/** The live base prompt string from pi. */
	basePrompt: string;
	/** Last known prompt options, when any (for the pre-first-call tool rebuild). */
	options?: BuildSystemPromptOptions;
	/** Working directory for rebuilding built-in schemas when the options are unknown. */
	cwd: string;
	captured: CapturedContext;
	contextWindow?: number;
}

/**
 * Total initial context tokens for the footer, without building the full
 * report. Uses live data wherever possible: the system prompt actually
 * sent (or the live base prompt before the first call) and the last
 * captured tool entries (or the rebuilt built-in schemas before the first
 * call).
 */
export function estimateInitialContextTotal(input: StatusEstimateInput): {
	totalTokens: number;
	windowPercent?: number;
} {
	const promptText = input.captured.sentSystem ?? input.basePrompt;
	let total = estimateTextTokens(promptText);
	if (input.captured.tools && input.captured.tools.length > 0) {
		for (const tool of input.captured.tools) total += estimateTextTokens(tool.raw);
	} else {
		const names =
			input.options && input.options.selectedTools && input.options.selectedTools.length > 0 ? input.options.selectedTools : DEFAULT_TOOLS;
		const factoryCwd = input.options?.cwd ?? input.cwd;
		for (const name of names) {
			const raw = builtinToolRaw(name, factoryCwd);
			if (raw !== undefined) total += estimateTextTokens(raw);
		}
	}
	const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : undefined;
	return {
		totalTokens: total,
		windowPercent: window ? (total / window) * 100 : undefined,
	};
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const INT = new Intl.NumberFormat("en-US");
const BAR_WIDTH = 12;

function formatInt(value: number): string {
	return INT.format(value);
}

/** A block bar for a share of the total, 0-100 percent. */
export function barFor(sharePercent: number | undefined, width: number = BAR_WIDTH): string {
	if (sharePercent === undefined || sharePercent <= 0) return "";
	const filled = Math.max(1, Math.round((sharePercent / 100) * width));
	return "\u2588".repeat(Math.min(width, filled));
}

function percentOf(value: number, total: number): string {
	if (total <= 0) return "0.0%";
	return `${((value / total) * 100).toFixed(1)}%`;
}

function windowPercentOf(value: number, window: number | undefined): string {
	if (!window || window <= 0) return "-";
	return `${((value / window) * 100).toFixed(1)}%`;
}

/** Display label for a row, with its note in parentheses. */
export function rowLabel(row: InitialContextRow): string {
	return row.note ? `${row.label} (${row.note})` : row.label;
}

/**
 * The plain-text breakdown, used by the print and RPC modes.
 *
 *   initial context: 45,230 tokens (11.3% of 400,000 window)
 *
 *     name                    tokens    ctx%   win%
 *     base prompt            12,345   27.3%   3.1%  ████
 *     ...
 *     TOTAL                  45,230  100.0%  11.3%  ████████████
 *     provider report (first call): 44,900 input tokens
 */
export function renderContextText(report: InitialContextReport): string {
	const lines: string[] = [];
	const total = report.totalTokens;
	const window = report.contextWindow;

	lines.push(
		`initial context: ${formatInt(total)} tokens` + (window ? ` (${report.windowPercent?.toFixed(1)}% of ${formatInt(window)} window)` : ""),
	);
	lines.push("");

	const labelWidth = Math.max(4, "TOTAL".length, ...report.rows.map((row) => rowLabel(row).length));
	const tokenWidth = Math.max(6, formatInt(total).length, ...report.rows.map((row) => formatInt(row.tokens).length));

	lines.push(`  name  ${"tokens".padStart(tokenWidth)}  ctx%   win%`);
	for (const row of report.rows) {
		const line =
			`  ${rowLabel(row).padEnd(labelWidth)}  ` +
			`${formatInt(row.tokens).padStart(tokenWidth)}  ` +
			`${percentOf(row.tokens, total)}  ` +
			`${windowPercentOf(row.tokens, window)}` +
			(barFor(total > 0 ? (row.tokens / total) * 100 : 0) ? `  ${barFor((row.tokens / total) * 100)}` : "");
		lines.push(line);
	}
	lines.push(
	`  ${"TOTAL".padEnd(labelWidth)}  ` +
			`${formatInt(total).padStart(tokenWidth)}  ` +
			`${total > 0 ? "100.0%" : "0.0%"}  ` +
			`${windowPercentOf(total, window)}  ` +
			barFor(100),
	);

	if (report.providerInputTokens !== undefined) {
		lines.push(`  provider report (first call): ${formatInt(report.providerInputTokens)} input tokens`);
	}

	return lines.join("\n");
}

/**
 * Compact token count in the system locale's number format
 * (4,492 reads 4.5K in en, 4,5 k in fr).
 */
export function formatCompactTokens(totalTokens: number): string {
	return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(totalTokens);
}

/** The persistent footer status text. */
export function formatStatusText(totalTokens: number, windowPercent?: number): string {
	return `ctx: ${formatCompactTokens(totalTokens)}${windowPercent !== undefined ? ` (${windowPercent.toFixed(1)}%)` : ""}`;
}
