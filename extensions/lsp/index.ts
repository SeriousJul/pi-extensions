/**
 * lsp extension entrypoint (issue #136, ADRs 0040-0043).
 *
 * The extension speaks the Language Server Protocol in-process to the
 * language servers already on the machine. Its primary job is the
 * Post-edit diagnostics loop: after an edit, the project's real language
 * server reports what the edit broke, and the agent reads it in the result
 * it is already looking at. The loop cannot depend on pi's edit tools,
 * because agents also edit through scripts, sed, and builds, so a file
 * watcher discovers changed paths and a stat check verifies currency.
 *
 * Navigation is a narrow second set - exact references, the real type, an
 * explicit diagnostics call - taken only where a language server clearly
 * beats codegraph, which keeps symbol search, file reading, and the call
 * trail (ADR 0040). v1 is read-only.
 *
 * This module is the thin pi wiring: it registers the three tools and the
 * /lsp command, and points the hooks at the LspSession, which owns every
 * decision. The client behind the session is the one seam the tests drive
 * with a scripted fake server (ADR 0041).
 */
import { statSync } from "node:fs";

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Box, Text, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { promptNoteFor } from "./format.ts";
import { readyByLang, resolveRegistry } from "./registry.ts";
import { LspSession } from "./session.ts";
import { readLspSettings } from "./settings.ts";

export const LSP_TOOL_NAMES = ["lsp_diagnostics", "lsp_references", "lsp_hover"] as const;
export type LspToolName = (typeof LSP_TOOL_NAMES)[number];

/** The custom message the Sweep appends; it starts the next turn. */
export const SWEEP_CUSTOM_TYPE = "lsp-sweep";

type ToolResult = AgentToolResult<unknown>;

function okResult(text: string, details: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function failResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], details: undefined };
}

/**
 * The /lsp status view: the exact component the command mounts in TUI mode
 * (and the offscreen screenshot renders over fixture data, ADR 0017).
 */
export function createLspStatusComponent(lines: string[], theme: Theme, onClose: () => void): Component {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", "lsp"), 0, 0));
	for (const line of lines) {
		box.addChild(new Text(line, 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 0, 0));
	return {
		render: (width: number) => box.render(width),
		invalidate: () => box.invalidate(),
		handleInput: (data: string) => {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) onClose();
		},
	};
}

/** True when at least one server can run for this project. */
function projectAvailable(ctx: ExtensionContext, env: NodeJS.ProcessEnv): boolean {
	const { settings, projectExplicitlyEnabled } = readLspSettings(ctx.cwd, env);
	if (!settings.enabled) return false;
	if (!ctx.isProjectTrusted() && !projectExplicitlyEnabled) return false;
	const resolved = resolveRegistry(settings, env, ctx.cwd);
	return resolved.some((r) => r.status === "ready");
}

export default function lspExtension(pi: ExtensionAPI): void {
	const session = new LspSession();
	const env = process.env;

	const bindUi = (ctx: ExtensionContext): void => {
		session.setUi(ctx);
	};

	// The tools register always and activate only when at least one server
	// is available for the project (issue #136). Activation is one-direction:
	// this extension adds the tools; removing them is the operator's choice
	// in /tools, and it holds for the session.
	const syncActivation = (ctx: ExtensionContext): void => {
		if (!projectAvailable(ctx, env)) return;
		const active = pi.getActiveTools();
		const toAdd = LSP_TOOL_NAMES.filter((name) => !active.includes(name));
		if (toAdd.length > 0) pi.setActiveTools([...active, ...toAdd]);
	};

	pi.on("session_start", (_event, ctx) => {
		bindUi(ctx);
		const { errors } = readLspSettings(ctx.cwd, env);
		for (const error of errors) {
			ctx.ui.notify(`lsp: ${error}`, "error");
		}
		syncActivation(ctx);
	});

	// The prompt note (3 lines) appears only while a server is available
	// and the tools are active: it states the boundary, so the agent is
	// never steered at a tool that would fail (stories 10, 11).
	pi.on("before_agent_start", (event, ctx) => {
		bindUi(ctx);
		if (!projectAvailable(ctx, env)) return undefined;
		if (!LSP_TOOL_NAMES.some((name) => pi.getActiveTools().includes(name))) return undefined;
		const { settings } = readLspSettings(ctx.cwd, env);
		const ready = resolveRegistry(settings, env, ctx.cwd).filter((r) => r.status === "ready");
		const languages = Object.keys(readyByLang(ready));
		if (languages.length === 0) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${promptNoteFor(languages)}` };
	});

	// Rebind the UI sink so the status line and notifications reach the
	// current terminal, the same way the codegraph extension does.
	pi.on("tool_execution_start", (event, ctx) => {
		if ((LSP_TOOL_NAMES as readonly string[]).includes(event.toolName)) bindUi(ctx);
	});

	// The loop cannot depend on which tool the agent edited with, so the
	// hooks run whether or not the lsp tools are active. They do nothing
	// but open a document at call time; every cost happens at result time.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const { settings, projectExplicitlyEnabled } = readLspSettings(ctx.cwd, env);
		if (!settings.annotate) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string" || input.path.length === 0) return;
		const resolved = input.path.startsWith("/") ? input.path : `${ctx.cwd}/${input.path}`;
		let existed = true;
		try {
			existed = statSync(resolved).isFile();
		} catch {
			existed = false;
		}
		await session.onEditToolCall(ctx.cwd, input.path, ctx.isProjectTrusted(), projectExplicitlyEnabled, existed);
	});

	// Post-edit diagnostics: the changed file's Diagnostics after pi's
	// stock text, in the same result (story 1). The stock text stays
	// verbatim in its own block; the annotation is a separate block.
	pi.on("tool_result", async (event, ctx) => {
		const name = event.toolName;
		if (name !== "edit" && name !== "write") {
			if (name === "read" && !event.isError) {
				// A read enters the file into the Open document set, which
				// settles the Diagnostic baseline for its pre-existing
				// errors (story 2).
				const { settings, projectExplicitlyEnabled } = readLspSettings(ctx.cwd, env);
				if (!settings.enabled) return undefined;
				const input = event.input as { path?: unknown };
				if (typeof input.path !== "string" || input.path.length === 0) return undefined;
				void session
					.onReadToolCall(ctx.cwd, input.path, ctx.isProjectTrusted(), projectExplicitlyEnabled)
					.catch(() => undefined);
				return undefined;
			}
			return undefined;
		}
		if (event.isError) return undefined; // a failed edit changed nothing
		const { settings, projectExplicitlyEnabled } = readLspSettings(ctx.cwd, env);
		if (!settings.annotate) return undefined;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string" || input.path.length === 0) return undefined;
		const annotation = await session.annotateEdit(ctx.cwd, input.path, name, ctx.isProjectTrusted(), projectExplicitlyEnabled);
		if (annotation === undefined) return undefined;
		return { content: [...event.content, { type: "text", text: annotation }] };
	});

	// The Sweep (ADR 0040): at turn end, new error-severity diagnostics
	// append one custom message. No continuation is requested: the report
	// starts the agent's next turn, so it can never loop the session.
	pi.on("turn_end", async (event, ctx) => {
		const { settings } = readLspSettings(ctx.cwd, env);
		if (!settings.enabled) return undefined;
		const report = await session.sweep(ctx.cwd);
		if (report === undefined) return undefined;
		return {
			entries: [
				{
					type: "custom_message",
					customType: SWEEP_CUSTOM_TYPE,
					content: [{ type: "text", text: report.text }],
					display: true,
				},
			],
			continue: false,
		};
	});

	pi.on("session_shutdown", async () => {
		await session.closeAll();
	});

	registerLspTools(pi, session);
	registerLspCommand(pi, session);
}

// Tools

const FileParam = Type.String({
	description: "The file to query, as you would pass it to the read tool (relative or absolute).",
});
const LineParam = Type.Integer({
	minimum: 1,
	description: "The 1-based line number the symbol sits on (the line the read tool printed it on).",
});
const CharacterParam = Type.Optional(
	Type.Integer({
		minimum: 0,
		description: "The 0-based character offset of the symbol on its line. Defaults to the start of the line.",
	}),
);

	function toolDetails(result: { text: string; details: { server?: string; partial?: boolean; counts?: Record<string, number> } }): unknown {
	const { server, partial, counts } = result.details;
	if (server === undefined && partial === undefined && counts === undefined) return undefined;
	return { server, partial, counts };
}

function registerLspTools(pi: ExtensionAPI, session: LspSession): void {
	const run =
		(tool: LspToolName) =>
		(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ToolResult> => {
			return session
				.runTool(tool, ctx.cwd, {
					file: String(params.file ?? ""),
					line: typeof params.line === "number" ? params.line : undefined,
					character: typeof params.character === "number" ? params.character : undefined,
					includeDeclaration: typeof params.includeDeclaration === "boolean" ? params.includeDeclaration : undefined,
				}, ctx.isProjectTrusted(), readLspSettings(ctx.cwd).projectExplicitlyEnabled)
				.then((r) => okResult(r.text, toolDetails(r)))
				.catch((err: unknown) => failResult(`lsp: ${err instanceof Error ? err.message : String(err)}`));
		};

	const callComponent =
		(showPosition: boolean) =>
		(args: { file: string; line?: number; character?: number }, theme: Theme): Component => {
			const pos = showPosition && typeof args.line === "number" ? ` L${args.line}:${(args.character ?? 0) + 1}` : "";
			const text = `${args.file}${pos} - ${theme.fg("muted", "lsp")}`;
			return { render: () => [text], invalidate: () => {} };
		};

	const resultComponent =
		(_label: string) =>
		(result: ToolResult, _options: unknown, theme: Theme): Component => {
			const details = (result.details ?? {}) as { partial?: boolean; counts?: Record<string, number> };
			const bits: string[] = [];
			if (details.partial) bits.push(theme.fg("warning", "partial"));
			if (details.counts) {
				const c = details.counts;
				if (c.error) bits.push(theme.fg("error", `${c.error} error${c.error === 1 ? "" : "s"}`));
				if (c.warning) bits.push(theme.fg("warning", `${c.warning} warning${c.warning === 1 ? "" : "s"}`));
				if (c.info) bits.push(`${c.info} info`);
				if (c.hint) bits.push(`${c.hint} hint`);
			}
			const text = bits.length > 0 ? ` - ${bits.join(", ")}` : "";
			return { render: () => [theme.fg("muted", text)], invalidate: () => {} };
		};

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "lsp diagnostics",
		description:
			"The current diagnostics of one file from the project's real language server: what is broken in the file right now, with severities. " +
			"Use it to check a file before or after touching it. The answer is labeled partial while the server is still indexing.",
		promptSnippet: "lsp_diagnostics: the file's current diagnostics from the real language server.",
		parameters: Type.Object({ file: FileParam }),
		defaultActive: false,
		execute: run("lsp_diagnostics"),
		renderCall: callComponent(false),
		renderResult: resultComponent("lsp_diagnostics"),
	});
	pi.registerTool({
		name: "lsp_references",
		label: "lsp references",
		description:
			"Exact call sites of a symbol: the references the language server finds for the symbol at file, line, character. " +
			"Where grep finds text, this finds the symbol's real usages. codegraph carries symbol search and the call trail; use this for the exact sites.",
		promptSnippet: "lsp_references: the exact call sites of a symbol at a position.",
		parameters: Type.Object({
			file: FileParam,
			line: LineParam,
			character: CharacterParam,
			includeDeclaration: Type.Optional(
				Type.Boolean({ description: "Include the declaration itself. Defaults to true." }),
			),
		}),
		defaultActive: false,
		execute: run("lsp_references"),
		renderCall: callComponent(true),
		renderResult: resultComponent("lsp_references"),
	});
	pi.registerTool({
		name: "lsp_hover",
		label: "lsp hover",
		description:
			"The real type behind a symbol: the language server's hover (type, signature, doc) at file, line, character. " +
			"Use it to stop guessing a receiver or a type a grep cannot resolve.",
		promptSnippet: "lsp_hover: the real type behind a symbol at a position.",
		parameters: Type.Object({ file: FileParam, line: LineParam, character: CharacterParam }),
		defaultActive: false,
		execute: run("lsp_hover"),
		renderCall: callComponent(true),
		renderResult: resultComponent("lsp_hover"),
	});
}

// The /lsp command

function registerLspCommand(pi: ExtensionAPI, session: LspSession): void {
	pi.registerCommand("lsp", {
		description: "Language server status: running servers, refused languages, open documents, watcher state",
		handler: async (_args, ctx) => {
			const { projectExplicitlyEnabled } = readLspSettings(ctx.cwd);
			const lines = session.statusLines(ctx.cwd, ctx.isProjectTrusted(), projectExplicitlyEnabled);
			if (ctx.mode === "tui" && ctx.hasUI) {
				await ctx.ui
					.custom((_tui, theme, _keybindings, done) => createLspStatusComponent(lines, theme, () => done(undefined)))
					.catch(() => ctx.ui.notify(lines.join("\n"), "info"));
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
