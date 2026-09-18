/**
 * Build pi's dark theme instance for off-screen captures.
 *
 * pi-coding-agent does not export its theme loader, so this resolves the
 * bundled dark.json the same way the built-in loader does (variable
 * references, fallbacks, the fg/bg split) and hands the result to the
 * exported Theme class. The output is the exact theme a user sees in
 * interactive mode.
 */
import { readFileSync } from "node:fs";
import { Theme } from "@earendil-works/pi-coding-agent";

import { darkThemePath } from "./look.mjs";

const BG_KEYS = new Set([
	"selectedBg",
	"searchMatchBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

function resolveVarRefs(value, vars, visited = new Set()) {
	if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
	if (visited.has(value)) throw new Error(`circular theme variable: ${value}`);
	if (!(value in vars)) throw new Error(`theme variable not found: ${value}`);
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

/** The dark theme exactly as pi's interactive mode renders it. */
export function darkTheme() {
	const json = JSON.parse(readFileSync(darkThemePath(), "utf8"));
	const colors = {
		...json.colors,
		scrollbarTrack: json.colors.scrollbarTrack ?? json.colors.muted,
		scrollbarThumb: json.colors.scrollbarThumb ?? json.colors.text,
		thinkingMax: json.colors.thinkingMax ?? json.colors.thinkingXhigh,
		searchMatchBg: json.colors.searchMatchBg ?? json.colors.selectedBg,
		searchMatchText: json.colors.searchMatchText ?? json.colors.text,
	};
	const resolved = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, json.vars);
	}
	const fg = {};
	const bg = {};
	for (const [key, value] of Object.entries(resolved)) {
		(BG_KEYS.has(key) ? bg : fg)[key] = value;
	}
	return new Theme(fg, bg, "truecolor", { name: "dark" });
}
