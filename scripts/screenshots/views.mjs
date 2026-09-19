/**
 * The off-screen views for the docs screenshots.
 *
 * Each builder returns the exact component the extension's /command would
 * mount: the same Box, SettingsList, or TUI factory, the same theme, the
 * same fixture data. The capture harness (offscreen.mjs) mounts the
 * component in an alt-screen TUI and records the settled frame.
 */
import { join } from "node:path";

import { Container, SettingsList } from "@earendil-works/pi-tui";
import { getSettingsListTheme, initTheme } from "@earendil-works/pi-coding-agent";

import { WORK_ROOT } from "./look.mjs";
import { darkTheme } from "./theme.mjs";
import {
	QUOTA_SNAPSHOT,
	NOW_MS,
	initialContextOptions,
	PINNED_PI_PACKAGE_DIR,
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

/**
 * The /quota detail view: the exact component the /quota command mounts
 * (createQuotaDetailComponent in quota/index.ts), over the fixture snapshot.
 */
export async function quotaDetailView() {
	const { renderQuotaDetail } = await import("../../extensions/quota/render.ts");
	const { createQuotaDetailComponent } = await import("../../extensions/quota/index.ts");
	return createQuotaDetailComponent(renderQuotaDetail(QUOTA_SNAPSHOT, false, NOW_MS), theme, () => {});
}

/**
 * The /sync status view: the exact component the /sync command mounts
 * (createSyncStatusComponent in sync/index.ts), over the report lines.
 */
export async function syncStatusView(lines) {
	const { createSyncStatusComponent } = await import("../../extensions/sync/index.ts");
	return createSyncStatusComponent(lines, false, theme, () => {});
}

/** The quota footer line, as a plain terminal line. */
export async function quotaFooterLine() {
	const { renderFooter } = await import("../../extensions/quota/render.ts");
	const { paintQuotaLine } = await import("../../extensions/quota/index.ts");
	const text = renderFooter(QUOTA_SNAPSHOT, false)
		.map((line) => paintQuotaLine(line, theme))
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
	// The default base prompt embeds the pi package paths (the pi docs
	// block). Pin the package dir for the duration of this report so the
	// paths - and the token counts they set - are the same on every machine.
	// The pin is removed immediately after the build: the later pty
	// captures spawn real pi over process.env, and their theme loading
	// must find the real package dir.
	process.env.PI_PACKAGE_DIR = PINNED_PI_PACKAGE_DIR;
	let report;
	try {
		report = buildInitialContext(initialContextOptions(), emptyCaptured(), 128000);
	} finally {
		delete process.env.PI_PACKAGE_DIR;
	}
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

/**
 * The /tools list: the exact rows and header the /tools command mounts
 * (toolSettingItems and toolsHeader in tools.ts), over the fixture tool
 * catalogue with every tool enabled.
 */
export async function toolsView() {
	const { toolSettingItems, toolsHeader } = await import("../../extensions/tools.ts");
	const items = toolSettingItems(toolInfos(), () => true, theme);
	const container = new Container();
	container.addChild(toolsHeader(theme));
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
