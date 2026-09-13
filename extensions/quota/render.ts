/**
 * Quota display module: turns a Usage snapshot (source.ts) into footer
 * segments and /quota detail lines (issue #28 design).
 *
 * Pure and engine-free: it knows no theme, no pi API, and no clock (the
 * caller passes `now`). The extension wiring (index.ts) maps tones to theme
 * colors and places the text, so the exact strings are unit-tested here.
 */
import type { QuotaWindow, UsageSnapshot } from "./source.ts";

/** How the wiring should color a piece of text. */
export type Tone = "normal" | "dim" | "error" | "warning";

/** One piece of display text with the tone it should be shown in. */
export interface QuotaLine {
	text: string;
	tone: Tone;
}

/** At or above this the window is exhausted and reads FULL. */
export function isExhausted(window: QuotaWindow): boolean {
	return window.usedPercent >= 100;
}

/**
 * The footer line for one snapshot: `GPT 5h 42% · 7d 18%`. Windows are
 * ordered by length, so the 5-hour window leads even when the endpoint
 * reports the weekly one first. An exhausted window reads FULL (error
 * tone). A stale snapshot appends a `stale` marker (warning tone). Reset
 * times never appear in the footer.
 */
export function renderFooter(snapshot: UsageSnapshot, stale: boolean): QuotaLine[] {
	const windows = byLength(snapshot.windows);
	const lines: QuotaLine[] = [{ text: "GPT", tone: "dim" }];
	windows.forEach((window, i) => {
		lines.push({ text: i === 0 ? ` ${window.label} ` : ` · ${window.label} `, tone: "dim" });
		lines.push(usedText(window));
	});
	if (stale) lines.push({ text: " stale", tone: "warning" });
	return lines;
}

/**
 * The /quota detail lines: plan type, account email, both windows with
 * reset time and time left, and the last fetched time. A stale snapshot
 * appends one line that says the numbers are the last good ones.
 */
export function renderQuotaDetail(snapshot: UsageSnapshot, stale: boolean, nowMs: number): QuotaLine[] {
	const lines: QuotaLine[] = [
		{ text: `Plan: ${snapshot.planType ?? "unknown"}`, tone: "normal" },
		{ text: `Account: ${snapshot.accountEmail ?? "unknown"}`, tone: "normal" },
		{ text: "", tone: "dim" },
	];
	for (const window of byLength(snapshot.windows)) {
		const left = formatDuration(window.resetsAtMs - nowMs);
		const reset = `resets ${formatClockTime(window.resetsAtMs, nowMs)} (in ${left})`;
		lines.push({
			text: `${window.label}  ${isExhausted(window) ? "FULL" : formatPercent(window.usedPercent)}   ${reset}`,
			tone: isExhausted(window) ? "error" : "normal",
		});
	}
	lines.push({ text: "", tone: "dim" });
	lines.push({
		text: `Fetched: ${formatClockSeconds(snapshot.fetchedAtMs)} (${formatDuration(nowMs - snapshot.fetchedAtMs)} ago)`,
		tone: "dim",
	});
	if (stale) {
		lines.push({ text: "stale: the latest read failed; these are the last good numbers", tone: "warning" });
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function byLength(windows: QuotaWindow[]): QuotaWindow[] {
	return [...windows].sort((a, b) => a.windowLengthMs - b.windowLengthMs);
}

function usedText(window: QuotaWindow): QuotaLine {
	return isExhausted(window)
		? { text: "FULL", tone: "error" }
		: { text: formatPercent(window.usedPercent), tone: "normal" };
}

/**
 * Floor, so a window that is not exhausted never displays 100%: 99.6% reads
 * "99%", and only a window the endpoint reports as full reads FULL.
 */
export function formatPercent(usedPercent: number): string {
	return `${Math.floor(usedPercent)}%`;
}

/** "2d 4h", "2h 14m", "38m", or "45s". Non-positive durations read "0s". */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

/**
 * Local clock time, "HH:MM". A reset on another calendar day gets a weekday
 * prefix, "Mon 14:32", so the day is never ambiguous. Built from the date's
 * own local components, so output does not depend on the machine locale.
 */
export function formatClockTime(ms: number, nowMs: number): string {
	const date = new Date(ms);
	const now = new Date(nowMs);
	const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
	if (isSameDay(date, now)) return clock;
	const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
	return `${weekday} ${clock}`;
}

/** Local clock time with seconds, "HH:MM:SS". */
export function formatClockSeconds(ms: number): string {
	const date = new Date(ms);
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function isSameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}
