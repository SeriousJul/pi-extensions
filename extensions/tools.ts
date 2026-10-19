/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools interactively.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Use /tools to open the tool selector
 */

import type { ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

import { classifyToolOrigin, originDescription } from "./shared/tool-origin.ts";

// User-only tools (GLOSSARY.md, "Tool exposure", issue #72): the operator has
// the capability as a command, so as agent tools they start inactive in
// every new session and can be enabled per session through /tools. They pay
// no context cost by default and a new session cannot reach them. The list
// is code, not a settings entry: the extension API has no settings reader,
// and one line per tool is the size of this decision.
const DEFAULT_DISABLED = ["usage_report", "resource_toggle"];

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

/**
 * One settings row per tool, as /tools shows it. Shared with the
 * screenshot pipeline (issue #73), which mounts the same rows over a
 * fixture catalogue.
 *
 * The tag is the shared classifier's Origin tag (issue #154, ADR 0045):
 * the extension's own name for an extension's tool, `mcp` for an MCP
 * server's tool. The list keeps its compact convention of no tag for a
 * built-in, which is also the shape an `unknown` origin takes. The same
 * classifier serves the Tool row header, which tags every row.
 */
export function toolSettingItems(tools: ToolInfo[], isEnabled: (name: string) => boolean, theme: Theme): SettingItem[] {
	return tools.map((tool) => {
		const origin = classifyToolOrigin(tool.name, tool.sourceInfo);
		const tag = origin.kind === "builtin" ? undefined : origin.tag;
		const label = tag ? `${tool.name} ${theme.fg("muted", `(${tag})`)}` : tool.name;
		return {
			id: tool.name,
			label,
			description: originDescription(tool.name, tool.sourceInfo),
			currentValue: isEnabled(tool.name) ? "enabled" : "disabled",
			values: ["enabled", "disabled"],
		};
	});
}

/** The header lines above the /tools list. */
export function toolsHeader(theme: Theme): { render: (width: number) => string[]; invalidate: () => void } {
	return {
		render: () => [
			theme.fg("accent", theme.bold("Tool Configuration")),
			theme.fg("muted", "Tag = Tool origin. No tag = built-in."),
			"",
		],
		invalidate: () => {},
	};
}

export default function toolsExtension(pi: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state
	function persistState() {
		pi.appendEntry<ToolsState>("tools-config", {
			enabledTools: Array.from(enabledTools),
		});
	}

	// Apply current tool selection
	function applyTools() {
		pi.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No saved state - start from the tools currently active, minus
			// the default-disabled list (user-only tools; issue #72). The
			// defaults hold on every start and tree navigation until the
			// operator makes a choice in /tools, which persists and wins.
			enabledTools = new Set(pi.getActiveTools().filter((t: string) => !DEFAULT_DISABLED.includes(t)));
			applyTools();
		}
	}

	// Register /tools command
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			// Refresh tool list
			allTools = pi.getAllTools();

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items = toolSettingItems(allTools, (name) => enabledTools.has(name), theme);

				const container = new Container();
				container.addChild(toolsHeader(theme));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						// Update enabled state and apply immediately
						if (newValue === "enabled") {
							enabledTools.add(id);
						} else {
							enabledTools.delete(id);
						}
						applyTools();
						persistState();
					},
					() => {
						// Close dialog
						done(undefined);
					},
				);

				container.addChild(settingsList);

				const component = {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};

				return component;
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
