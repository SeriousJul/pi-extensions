/**
 * The off-screen views for the docs screenshots.
 *
 * Each builder returns the exact component the extension's /command would
 * mount: the same Box, SettingsList, or TUI factory, the same theme, the
 * same fixture data. The capture harness (offscreen.mjs) mounts the
 * component in an alt-screen TUI and records the settled frame.
 */
import { join } from "node:path";

import { Box, Text, Container, SettingsList } from "@earendil-works/pi-tui";
import { getSettingsListTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { WORK_ROOT } from "./look.mjs";
import { darkTheme } from "./theme.mjs";
import {
	QUOTA_SNAPSHOT,
	NOW_MS,
	initialContextOptions,
	CONTEXT_SESSIONS_ROOT,
	RESOURCE_MACHINE,
	resourceInfos,
	resourceSettings,
	toolInfos,
	USAGE_SESSIONS_ROOT,
} from "./fixtures.mjs";

// getSettingsListTheme reads the global theme pi's interactive mode sets at
// startup; initialize it with the same bundled dark theme. The color mode
// comes from look.mjs's env pins (COLORTERM=truecolor), which run before
// this module body because look.mjs is imported above.
initTheme("dark");
const theme = darkTheme();

/** Map a quota line tone to its theme paint, like the extension wiring does. */
function paint(line) {
	if (line.tone === "error") return theme.fg("error", line.text);
	if (line.tone === "warning") return theme.fg("warning", line.text);
	if (line.tone === "dim") return theme.fg("dim", line.text);
	return line.text;
}

/** The /quota detail view: the Box exactly as quota/index.ts builds it. */
export async function quotaDetailView() {
	const { renderQuotaDetail } = await import("../../extensions/quota/render.ts");
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", "ChatGPT plan quota"), 0, 0));
	for (const line of renderQuotaDetail(QUOTA_SNAPSHOT, false, NOW_MS)) {
		box.addChild(new Text(paint(line), 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 0, 0));
	return {
		render: (width) => box.render(width),
		invalidate: () => box.invalidate(),
		handleInput: () => {},
	};
}

/** The /sync status view: the Box exactly as sync/index.ts builds it. */
export function syncStatusView(lines) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", "pi sync"), 0, 0));
	for (const line of lines) {
		box.addChild(new Text(line, 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 0, 0));
	return {
		render: (width) => box.render(width),
		invalidate: () => box.invalidate(),
		handleInput: () => {},
	};
}

/** The quota footer line, as a plain terminal line. */
export async function quotaFooterLine() {
	const { renderFooter } = await import("../../extensions/quota/render.ts");
	const text = renderFooter(QUOTA_SNAPSHOT, false)
		.map((line) => paint(line))
		.join("");
	return {
		render: (width) => [text, ...Array.from({ length: Math.max(0, width - 1) }, () => " ")],
		invalidate: () => {},
		handleInput: () => {},
	};
}

/** The compress status bar piece, as a plain terminal line. */
export function compressStatusLine() {
	const spans = 3;
	const tokensSaved = 12400;
	const formatTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	const text = theme.fg("dim", `${spans} span${spans === 1 ? "" : "s"}, ${formatTokens(tokensSaved)} saved`);
	return {
		render: () => [text, " "],
		invalidate: () => {},
		handleInput: () => {},
	};
}

/** The pruning settings view: the two notify lines the command prints. */
export function pruningSettingsLines() {
	const lines = [
		theme.fg("dim", "pruning: enabled=true, minResultTokens=1000, protectCurrentTurn=true"),
		theme.fg("dim", "state: no outputs pruned yet; last gate: none"),
	];
	return {
		render: () => [...lines, " ", " "],
		invalidate: () => {},
		handleInput: () => {},
	};
}

/** The /usage TUI over the committed session fixture. */
export async function usageTui(tui) {
	const { createUsageTui } = await import("../../extensions/usage/tui.ts");
	const { scanUsage } = await import("../../extensions/usage/lib/scan.ts");
	return createUsageTui({
		tui,
		theme,
		// "all" window: no clock involved, every fixture event is in range.
		initial: { bucket: "week", window: "all", groupBy: "providerModel", sort: "time" },
		load: () => Promise.resolve(scanUsage(USAGE_SESSIONS_ROOT).events),
		viewport: () => Math.max(8, Math.min(tui.terminal.rows - 12, 24)),
		close: () => {},
	});
}

/** The /ctx view over the committed prompt and session fixtures. */
export async function contextTui(tui) {
	const { createContextTui } = await import("../../extensions/initial-context/tui.ts");
	const { buildInitialContext, emptyCaptured } = await import("../../extensions/initial-context/context.ts");
	const { createToolUsageSource } = await import("../../extensions/initial-context/tool-usage.ts");
	const report = buildInitialContext(initialContextOptions(), emptyCaptured(), 128000);
	const usage = createToolUsageSource({
		sessionsRoot: CONTEXT_SESSIONS_ROOT,
		cacheFile: join(WORK_ROOT, "initial-context", "tool-usage-cache.json"),
		now: () => NOW_MS,
	});
	return createContextTui({
		tui,
		theme,
		report,
		usage,
		copy: async () => {},
		viewport: () => Math.max(6, Math.min(tui.terminal.rows - 10, 24)),
		close: () => {},
	});
}

/** The origin tag, exactly as tools.ts derives it. */
function originTag(tool) {
	const source = tool.sourceInfo.source;
	if (source === "sdk") return "sdk";
	if (source === "builtin") return undefined;
	const path = tool.sourceInfo.path;
	const pkg = path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
	if (pkg) return pkg[1];
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.[cm]?[jt]s$/, "");
}

/** The row description, exactly as tools.ts derives it. */
function originDescription(tool) {
	const info = tool.sourceInfo;
	if (info.source === "builtin") return "Built-in pi tool";
	if (info.source === "sdk") return "Custom tool registered via SDK";
	return `Extension tool from ${originTag(tool)}: ${info.path}`;
}

/** The /tools list over the fixture tool catalogue. */
export function toolsView() {
	const items = toolInfos().map((tool) => {
		const tag = originTag(tool);
		const label = tag ? `${tool.name} ${theme.fg("muted", `(${tag})`)}` : tool.name;
		return {
			id: tool.name,
			label,
			description: originDescription(tool),
			currentValue: "enabled",
			values: ["enabled", "disabled"],
		};
	});
	const header = {
		render: () => [
			theme.fg("accent", theme.bold("Tool Configuration")),
			theme.fg("muted", "Tag = extension or SDK origin. No tag = built-in."),
			"",
		],
		invalidate: () => {},
	};
	const container = new Container();
	container.addChild(header);
	container.addChild(new SettingsList(items, Math.min(items.length + 2, 15), getSettingsListTheme(), () => {}, () => {}));
	return {
		render: (width) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: () => {},
	};
}

/** The /resources TUI over the fixture resource list. */
export async function resourcesTui(tui) {
	const { createResourceToggleTui } = await import("../../extensions/resource-toggle/tui.ts");
	return createResourceToggleTui({
		tui,
		theme,
		resources: resourceInfos(),
		settings: resourceSettings(),
		machine: RESOURCE_MACHINE,
		projectTrusted: true,
		apply: async () => ({ ok: true }),
		viewport: () => Math.max(5, tui.terminal.rows - 8),
		close: () => {},
	});
}
