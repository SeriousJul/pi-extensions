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

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

// Short origin tag for non-built-in tools, e.g. "pi-web-access" or "sdk".
// Returns undefined for built-in tools so the list stays clean.
function originTag(tool: ToolInfo): string | undefined {
	if (tool.sourceInfo.source === "extension") {
		const path = tool.sourceInfo.path;
		const pkg = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
		if (pkg) return pkg[1];
		const file = path.split("/").pop() ?? path;
		return file.replace(/\.[cm]?[jt]s$/, "");
	}
	if (tool.sourceInfo.source === "sdk") return "sdk";
	return undefined;
}

function originDescription(tool: ToolInfo): string {
	const info = tool.sourceInfo;
	if (info.source === "builtin") return "Built-in pi tool";
	if (info.source === "sdk") return "Custom tool registered via SDK";
	return `Extension tool from ${originTag(tool)} (${info.scope} scope)`;
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
			// No saved state - sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
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
				// Build settings items for each tool
				const items: SettingItem[] = allTools.map((tool) => {
					const tag = originTag(tool);
					const label = tag ? `${tool.name} ${theme.fg("muted", `(${tag})`)}` : tool.name;
					return {
						id: tool.name,
						label,
						description: originDescription(tool),
						currentValue: enabledTools.has(tool.name) ? "enabled" : "disabled",
						values: ["enabled", "disabled"],
					};
				});

				const container = new Container();
				container.addChild(
					new (class {
						render(_width: number) {
							return [
								theme.fg("accent", theme.bold("Tool Configuration")),
								theme.fg("muted", "Tag = extension or SDK origin. No tag = built-in."),
								"",
							];
						}
						invalidate() {}
					})(),
				);

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
