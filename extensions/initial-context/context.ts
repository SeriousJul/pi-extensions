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
import { usesForLabel } from "./tool-usage.ts";

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
export type RowKind = "base" | "tools" | "guideline" | "append" | "file" | "skill" | "cwd" | "section" | "injection" | "tool";

/** One line of the breakdown. */
export interface InitialContextRow {
	key: string;
	label: string;
	kind: RowKind;
	/** Where the text comes from: builtin, settings, file, skill, or extension. */
	source: string;
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

/** The requested tool list, or pi's default set when none or an empty list is requested. */
function effectiveTools(options: { selectedTools?: string[] } | null | undefined): string[] {
	const selected = options?.selectedTools;
	return selected && selected.length > 0 ? selected : DEFAULT_TOOLS;
}

/** The preamble of pi's default base prompt. */
const IDENTITY_LINE =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/** The fixed closing line of the tools section. */
const CUSTOM_TOOLS_LINE = "In addition to the tools above, you may have access to other custom tools depending on the project.";

/** The fixed pi-documentation bullets at the end of the base prompt. */
const PI_DOCS_BULLETS = [
	"- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
	"- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)",
	"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
	"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
];

/** The pi documentation block, with this machine's package paths filled in. */
function piDocsBlock(): string {
	return [
		"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
		`- Main documentation: ${getReadmePath()}`,
		`- Additional docs: ${getDocsPath()}`,
		`- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
		...PI_DOCS_BULLETS,
	].join("\n");
}

/** One prompt guideline bullet and where it comes from. */
export interface PromptGuideline {
	text: string;
	/** builtin for pi's default bullets, extension for the rest. */
	source: "builtin" | "extension";
}

const FIXED_GUIDELINES = ["Be concise in your responses", "Show file paths clearly when working with files"];

/** The tool-based default bullet, when the tool set needs it. */
function toolGuideline(tools: string[]): string | undefined {
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	if (!(hasBash || hasPowerShell) || tools.includes("grep") || tools.includes("find") || tools.includes("ls")) return undefined;
	if (hasBash && hasPowerShell) return "Use bash or PowerShell for file operations like listing, searching, and finding files";
	if (hasPowerShell) return "Use PowerShell for file operations like listing, searching, and finding files";
	return "Use bash for file operations like ls, rg, find";
}

/**
 * Every guideline bullet of the default base prompt's rules section, in
 * prompt order, deduplicated on the first occurrence. pi's default bullets
 * are builtin, the bullets a tool or extension registers are extension (a
 * registered bullet identical to a default keeps the builtin source).
 *
 * The order is pi's: the tool-based default bullet, then each selected
 * tool's registered bullets in tool order, then the additional prompt
 * guidelines, then pi's fixed bullets.
 */
export function defaultGuidelines(options: BuildSystemPromptOptions): PromptGuideline[] {
	const tools = effectiveTools(options);
	const builtinTexts = new Set<string>(FIXED_GUIDELINES);
	const bullet = toolGuideline(tools);
	if (bullet) builtinTexts.add(bullet);
	const out: PromptGuideline[] = [];
	const seen = new Set<string>();
	const add = (text: string, source: "builtin" | "extension"): void => {
		if (seen.has(text)) return;
		seen.add(text);
		out.push({ text, source });
	};
	if (bullet) add(bullet, "builtin");
	const toolGuidelines = options.toolGuidelines ?? {};
	for (const name of tools) {
		for (const guideline of toolGuidelines[name] ?? []) {
			const normalized = guideline.trim();
			if (normalized.length > 0) add(normalized, builtinTexts.has(normalized) ? "builtin" : "extension");
		}
	}
	for (const guideline of options.promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) add(normalized, builtinTexts.has(normalized) ? "builtin" : "extension");
	}
	for (const fixed of FIXED_GUIDELINES) add(fixed, "builtin");
	return out;
}

/** The available-tools list of the default base prompt. */
function toolsListFor(options: BuildSystemPromptOptions): string {
	const tools = effectiveTools(options);
	const snippets = options.toolSnippets ?? {};
	const visibleTools = tools.filter((name) => snippets[name] !== undefined && snippets[name] !== "");
	return visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${snippets[name]}`).join("\n") : "(none)";
}

interface Section {
	key: string;
	label: string;
	kind: RowKind;
	source: string;
	text: string;
}

/**
 * Split the full base prompt into its sections, in the fixed block order
 * (base, append, project files, skills, cwd, custom sections).
 * Concatenating the section texts reproduces the base prompt exactly.
 *
 * pi renders the default base prompt as named XML sections (preamble,
 * tools, rules, docs, addendum, project_context, skills, cwd), each
 * wrapped in its own tags and joined by blank lines. The default splits
 * into report-sized pieces (issue #85): the boilerplate (the preamble and
 * the section wrappers around the pi documentation block), the
 * available-tools snippet block, and one section per prompt guideline. The
 * boilerplate lives in the gaps the split pieces fill, so it appears as
 * several sections under one key and concatenates, with the split pieces
 * between them, to the exact base prompt.
 */
export function buildPromptSections(options: BuildSystemPromptOptions): Section[] {
	const promptCwd = options.cwd.replace(/\\/g, "/");
	const sections: Section[] = [];

	if (options.forceSystemPrompt !== undefined) {
		// An opaque full replacement: content only, no sections at all.
		sections.push({ key: "base", label: "forced prompt", kind: "base", source: "builtin", text: options.forceSystemPrompt });
		return sections;
	}

	if (options.customPrompt) {
		sections.push({ key: "base", label: "custom prompt", kind: "base", source: "builtin", text: options.customPrompt });
	} else {
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: IDENTITY_LINE });
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: "\n\n<tools>\n" });
		sections.push({ key: "available-tools", label: "available tools", kind: "tools", source: "builtin", text: toolsListFor(options) });
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: `\n\n${CUSTOM_TOOLS_LINE}\n</tools>` });
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: "\n\n<rules>\n" });
		defaultGuidelines(options).forEach((guideline, index) => {
			sections.push({
				key: `guideline:${index}`,
				label: guideline.text,
				kind: "guideline",
				source: guideline.source,
				text: (index === 0 ? "" : "\n") + `- ${guideline.text}`,
			});
		});
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: "\n</rules>" });
		sections.push({ key: "base", label: "base prompt", kind: "base", source: "builtin", text: `\n\n<docs>\n${piDocsBlock()}\n</docs>` });
	}

	if (options.appendSystemPrompt) {
		sections.push({ key: "append", label: "append text", kind: "append", source: "settings", text: `\n\n<addendum>\n${options.appendSystemPrompt}\n</addendum>` });
	}

	const files = options.contextFiles ?? [];
	files.forEach((file, index) => {
		const block = `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`;
		let text = block;
		if (index === 0) text = `\n\n<project_context>\nProject-specific instructions and guidelines:\n\n${block}`;
		else text = `\n\n${block}`;
		if (index === files.length - 1) text += "\n</project_context>";
		sections.push({ key: `file:${file.path}`, label: file.path, kind: "file", source: "file", text });
	});

	const tools = effectiveTools(options);
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
	const skills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skillFileReadTool && skills.length > 0) {
		const block = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (block.length > 0) {
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
				let piece = (index === 0 ? header : "") + rest.slice(start, stop);
				if (index === 0) piece = `\n\n<skills>\n${piece}`;
				if (isLast) piece += "\n</skills>";
				sections.push({ key: `skill:${skill.name}`, label: skill.name, kind: "skill", source: "skill", text: piece });
				start = stop;
			});
		}
	}

	sections.push({
		key: "cwd",
		label: "cwd",
		kind: "cwd",
		source: "builtin",
		text: `\n\n<cwd>\n${promptCwd}\n</cwd>`,
	});

	for (const [name, content] of Object.entries(options.sections ?? {})) {
		if (!content) continue;
		sections.push({ key: `section:${name}`, label: name, kind: "section", source: "extension", text: `\n\n<${name}>\n${content}\n</${name}>` });
	}

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
			source: "extension",
			text: suffix,
			tokens: estimateTextTokens(suffix),
		};
	}
	return {
		key: "injection",
		label: "injection",
		kind: "injection",
		source: "extension",
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
		const names = effectiveTools(options);
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
		// The default tools are pi built-ins; anything else in the list
		// (custom tools, extension tools) comes from an extension.
		source: DEFAULT_TOOLS.includes(entry.name) ? "builtin" : "extension",
		note: entry.note,
		text: entry.raw,
		tokens: estimateTextTokens(entry.raw),
	}));
	rows.sort((a, b) => b.tokens - a.tokens);
	return rows;
}

// ---------------------------------------------------------------------------
// Guideline duplication check (issue #86)
// ---------------------------------------------------------------------------

/**
 * The normalized form for the duplicate comparison: lowercase, punctuation
 * replaced by spaces, runs of whitespace collapsed to one space.
 */
export function normalizeForDuplicateCheck(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The length of the longest substring common to both strings. */
export function longestCommonSubstringLength(a: string, b: string): number {
	if (a.length === 0 || b.length === 0) return 0;
	let best = 0;
	let prev = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		const curr = new Array<number>(b.length + 1).fill(0);
		for (let j = 1; j <= b.length; j++) {
			if (a[i - 1] !== b[j - 1]) continue;
			const value = prev[j - 1] + 1;
			curr[j] = value;
			if (value > best) best = value;
		}
		prev = curr;
	}
	return best;
}

/** A common substring shorter than this is never flagged. */
const DUPLICATE_FLOOR_CHARS = 24;
/** The share of the guideline the common substring must cover. */
const DUPLICATE_SHARE = 0.8;

/**
 * True when the guideline largely restates one of the tool descriptions:
 * the longest common substring (normalized form) covers at least 80% of the
 * guideline and is at least 24 characters. Deliberately conservative: it
 * catches verbatim and prefixed-verbatim shapes, misses paraphrases.
 */
export function duplicatesToolDescription(guideline: string, descriptions: string[]): boolean {
	const normalized = normalizeForDuplicateCheck(guideline);
	for (const description of descriptions) {
		const lcs = longestCommonSubstringLength(normalized, normalizeForDuplicateCheck(description));
		if (lcs >= DUPLICATE_FLOOR_CHARS && lcs >= DUPLICATE_SHARE * normalized.length) return true;
	}
	return false;
}

/**
 * The tool descriptions from the last captured provider request, the text
 * actually sent to the model. Entries whose raw is not a JSON object with a
 * string description (name-only placeholders) carry none.
 */
export function capturedToolDescriptions(captured: CapturedContext): string[] {
	if (!captured.tools) return [];
	const out: string[] = [];
	for (const tool of captured.tools) {
		try {
			const parsed: unknown = JSON.parse(tool.raw);
			if (isRecord(parsed) && typeof parsed.description === "string" && parsed.description.length > 0) {
				out.push(parsed.description);
			}
		} catch {
			// Not JSON: the placeholder name carries no description.
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Build the full breakdown from the prompt options and the captured state.
 * Row order: size, largest first (the stable sort keeps prompt order for ties).
 *
 * The base-prompt boilerplate sections (one key, split around the
 * available-tools and guideline sections) merge into the single
 * `base prompt` row; the split sections stay separate rows.
 */
export function buildInitialContext(
	options: BuildSystemPromptOptions,
	captured: CapturedContext,
	contextWindow?: number,
): InitialContextReport {
	const sections = buildPromptSections(options);
	const rows: InitialContextRow[] = [];
	let baseRow: InitialContextRow | undefined;
	for (const section of sections) {
		if (section.key === "base" && baseRow) {
			baseRow.text += section.text;
			continue;
		}
		const row: InitialContextRow = {
			key: section.key,
			label: section.label,
			kind: section.kind,
			source: section.source,
			text: section.text,
			tokens: 0,
		};
		if (section.key === "base") baseRow = row;
		rows.push(row);
	}
	for (const row of rows) row.tokens = estimateTextTokens(row.text);

	const injection = injectionRow(sections, captured.sentSystem);
	if (injection) rows.push(injection);

	rows.push(...buildToolRows(options, captured));

	// A guideline that largely restates a sent tool description pays cost
	// without adding information: mark it, but only once the session has
	// seen at least one provider request (the descriptions of the last one).
	// Prompt snippets are never flagged: the one-line restatement is the
	// design of the available-tools section.
	const descriptions = capturedToolDescriptions(captured);
	if (descriptions.length > 0) {
		for (const row of rows) {
			if (row.kind === "guideline" && !row.note && duplicatesToolDescription(row.label, descriptions)) {
				row.note = "duplicates tool description";
			}
		}
	}
	rows.sort((a, b) => b.tokens - a.tokens);

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
		const names = effectiveTools(input.options);
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
 * The derived waste value of one row for the usage view (issue #72): the
 * cost a use pays (tokens per use) for a tool the window saw, `never` for a
 * tool the window never used, and `-` for rows a usage count does not
 * describe (non-tool rows and the absent usage view). Computed from data
 * the report already carries: the row's tokens and its call count.
 */
export function wasteFor(row: InitialContextRow, counts?: Record<string, number>): string {
	if (!counts) return "-";
	if (row.kind !== "tool") return "-";
	const uses = usesForLabel(row.label, row.kind, counts) ?? 0;
	if (uses === 0) return "never";
	return `${(row.tokens / uses).toFixed(1)}/u`;
}

/**
 * The plain-text breakdown, used by the print and RPC modes.
 *
 * Rows are sorted by size, largest first.
 *
 *   initial context: 45,230 tokens (11.3% of 400,000 window)
 *
 *     name             src       tokens  ctx%   win%
 *     base prompt      builtin  12,345  27.3%   3.1%  ████
 *     ...
 *     TOTAL                  45,230  100.0%  11.3%  ████████████
 *     provider report (first call): 44,900 input tokens
 *
 * With a usage view, a `uses(<window>)` column is added: the call count of
 * each tool in the window (section rows show `-`, TOTAL the sum), and a
 * derived `waste` column: tokens per use for a tool the window saw, `never`
 * for a tool the window never used (section rows and TOTAL show `-`).
 */
export function renderContextText(report: InitialContextReport, usage?: { window: string; counts: Record<string, number> }): string {
	const lines: string[] = [];
	const total = report.totalTokens;
	const window = report.contextWindow;

	lines.push(
		`initial context: ${formatInt(total)} tokens` + (window ? ` (${report.windowPercent?.toFixed(1)}% of ${formatInt(window)} window)` : ""),
	);
	lines.push("");

	const labelWidth = Math.max(4, "TOTAL".length, ...report.rows.map((row) => rowLabel(row).length));
	const sourceWidth = Math.max(3, ...report.rows.map((row) => row.source.length));
	const tokenWidth = Math.max(6, formatInt(total).length, ...report.rows.map((row) => formatInt(row.tokens).length));

	const usesText = (row: InitialContextRow): string =>
		usage ? String(usesForLabel(row.label, row.kind, usage.counts) ?? "-") : "";
	const usesWidth = usage ? Math.max(4, ...report.rows.map((row) => usesText(row).length)) : 0;
	const wasteText = (row: InitialContextRow): string => (usage ? wasteFor(row, usage.counts) : "-");
	const wasteWidth = usage ? Math.max(5, ...report.rows.map((row) => wasteText(row).length)) : 0;
	let totalUses = 0;
	if (usage) {
		for (const [key, n] of Object.entries(usage.counts)) {
			if (!key.startsWith("skill:")) totalUses += n;
		}
	}

	lines.push(
		`  name  ${"src".padEnd(sourceWidth)}  ${"tokens".padStart(tokenWidth)}  ctx%   win%` +
		(usage ? `  uses(${usage.window})  waste` : ""),
	);
	for (const row of report.rows) {
		const line =
			`  ${rowLabel(row).padEnd(labelWidth)}  ` +
			`${row.source.padEnd(sourceWidth)}  ` +
			`${formatInt(row.tokens).padStart(tokenWidth)}  ` +
			`${percentOf(row.tokens, total)}  ` +
			`${windowPercentOf(row.tokens, window)}` +
			(usage ? `  ${usesText(row).padStart(usesWidth)}  ${wasteText(row).padStart(wasteWidth)}` : "") +
			(barFor(total > 0 ? (row.tokens / total) * 100 : 0) ? `  ${barFor((row.tokens / total) * 100)}` : "");
		lines.push(line);
	}
	lines.push(
		`  ${"TOTAL".padEnd(labelWidth)}  ${" ".repeat(sourceWidth)}  ` +
			`${formatInt(total).padStart(tokenWidth)}  ` +
			`${total > 0 ? "100.0%" : "0.0%"}  ` +
			`${windowPercentOf(total, window)}  ` +
			(usage ? `${formatInt(totalUses).padStart(usesWidth)}  ${"-".padStart(wasteWidth)}  ` : "") +
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
