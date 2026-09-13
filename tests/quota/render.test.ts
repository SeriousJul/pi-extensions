import { describe, expect, it } from "vitest";
import {
	formatClockSeconds,
	formatClockTime,
	formatDuration,
	formatPercent,
	isExhausted,
	renderFooter,
	renderQuotaDetail,
	type QuotaLine,
} from "../../extensions/quota/render";
import type { UsageSnapshot } from "../../extensions/quota/source";

// A fixed "now" in the local time zone: 2026-01-15 (a Thursday) 14:00.
const NOW = new Date(2026, 0, 15, 14, 0, 0).getTime();
const FIVE_H = 5 * 3600 * 1000;
const SEVEN_D = 7 * 24 * 3600 * 1000;

function makeSnapshot(overrides?: Partial<UsageSnapshot>): UsageSnapshot {
	return {
		planType: "plus",
		accountEmail: "jul@example.com",
		windows: [
			// Weekly window first on purpose: the display must reorder by length.
			{ label: "7d", usedPercent: 18.4, resetsAtMs: NOW + SEVEN_D, windowLengthMs: SEVEN_D },
			{ label: "5h", usedPercent: 42.7, resetsAtMs: NOW + FIVE_H, windowLengthMs: FIVE_H },
		],
		fetchedAtMs: NOW - 4 * 60 * 1000,
		...overrides,
	};
}

/** Join segments into one plain string, like the footer shows it. */
function join(lines: QuotaLine[]): string {
	return lines.map((line) => line.text).join("");
}

// ---------------------------------------------------------------------------
// renderFooter
// ---------------------------------------------------------------------------

describe("renderFooter", () => {
	it("shows both windows as used percentages, 5h first", () => {
		const lines = renderFooter(makeSnapshot(), false);
		expect(join(lines)).toBe("GPT 5h 42% · 7d 18%");
		expect(lines.every((line) => line.tone !== "error")).toBe(true);
	});

	it("does not show reset times", () => {
		const lines = renderFooter(makeSnapshot(), false);
		expect(lines.some((line) => /\d{2}:\d{2}/.test(line.text))).toBe(false);
	});

	it("reads an exhausted window as FULL in the error tone", () => {
		const snapshot = makeSnapshot();
		snapshot.windows = snapshot.windows.map((w) => (w.label === "5h" ? { ...w, usedPercent: 100 } : w));
		const lines = renderFooter(snapshot, false);
		expect(join(lines)).toBe("GPT 5h FULL · 7d 18%");
		const full = lines.find((line) => line.text === "FULL");
		expect(full?.tone).toBe("error");
	});

	it("treats an over-100 percent as exhausted", () => {
		const snapshot = makeSnapshot();
		snapshot.windows = snapshot.windows.map((w) => (w.label === "7d" ? { ...w, usedPercent: 120 } : w));
		const lines = renderFooter(snapshot, false);
		expect(join(lines)).toBe("GPT 5h 42% · 7d FULL");
	});

	it("keeps the 5h window first regardless of the endpoint order", () => {
		const lines = renderFooter(makeSnapshot(), false);
		expect(join(lines)).toMatch(/^GPT 5h /);
	});

	it("shows only the windows the endpoint reports", () => {
		const snapshot = makeSnapshot();
		snapshot.windows = snapshot.windows.filter((w) => w.label === "7d");
		expect(join(renderFooter(snapshot, false))).toBe("GPT 7d 18%");
	});

	it("appends a stale marker to a stale snapshot", () => {
		const lines = renderFooter(makeSnapshot(), true);
		expect(join(lines)).toBe("GPT 5h 42% · 7d 18% stale");
		const marker = lines[lines.length - 1];
		expect(marker).toEqual({ text: " stale", tone: "warning" });
	});

	it("combines FULL and stale", () => {
		const snapshot = makeSnapshot();
		snapshot.windows = snapshot.windows.map((w) => ({ ...w, usedPercent: 100 }));
		expect(join(renderFooter(snapshot, true))).toBe("GPT 5h FULL · 7d FULL stale");
	});
});

// ---------------------------------------------------------------------------
// renderQuotaDetail
// ---------------------------------------------------------------------------

describe("renderQuotaDetail", () => {
	it("shows plan type and account email", () => {
		const text = join(renderQuotaDetail(makeSnapshot(), false, NOW));
		expect(text).toContain("Plan: plus");
		expect(text).toContain("Account: jul@example.com");
	});

	it("shows both windows with reset time and time left", () => {
		const lines = renderQuotaDetail(makeSnapshot(), false, NOW);
		const five = lines.find((line) => line.text.startsWith("5h"));
		const seven = lines.find((line) => line.text.startsWith("7d"));
		expect(five?.tone).toBe("normal");
		expect(five?.text).toBe("5h  42%   resets 19:00 (in 5h)");
		expect(seven?.text).toBe("7d  18%   resets Thu 14:00 (in 7d)");
	});

	it("reads an exhausted window as FULL in the error tone", () => {
		const snapshot = makeSnapshot();
		snapshot.windows = snapshot.windows.map((w) => (w.label === "5h" ? { ...w, usedPercent: 100 } : w));
		const lines = renderQuotaDetail(snapshot, false, NOW);
		const five = lines.find((line) => line.text.startsWith("5h"));
		expect(five?.text).toContain("FULL");
		expect(five?.tone).toBe("error");
	});

	it("shows the last fetched time", () => {
		const lines = renderQuotaDetail(makeSnapshot(), false, NOW);
		const fetched = lines.find((line) => line.text.startsWith("Fetched: "));
		expect(fetched?.text).toBe(`Fetched: ${formatClockSeconds(NOW - 4 * 60 * 1000)} (4m ago)`);
		expect(fetched?.tone).toBe("dim");
	});

	it("marks a stale snapshot and keeps the numbers", () => {
		const lines = renderQuotaDetail(makeSnapshot(), true, NOW);
		const staleLine = lines[lines.length - 1];
		expect(staleLine.tone).toBe("warning");
		expect(staleLine.text).toContain("stale");
		const text = join(lines);
		expect(text).toContain("5h  42%");
	});

	it("does not show a stale line for a fresh snapshot", () => {
		const lines = renderQuotaDetail(makeSnapshot(), false, NOW);
		expect(lines.every((line) => !line.text.startsWith("stale"))).toBe(true);
	});

	it("falls back to unknown for missing plan or account", () => {
		const snapshot = makeSnapshot();
		snapshot.planType = undefined;
		snapshot.accountEmail = undefined;
		const text = join(renderQuotaDetail(snapshot, false, NOW));
		expect(text).toContain("Plan: unknown");
		expect(text).toContain("Account: unknown");
	});
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
	it("renders days, hours, minutes, and seconds", () => {
		expect(formatDuration(2 * 86_400_000 + 4 * 3_600_000)).toBe("2d 4h");
		expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
		expect(formatDuration(38 * 60_000)).toBe("38m");
		expect(formatDuration(45_000)).toBe("45s");
	});

	it("clamps non-positive durations to 0s", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(-1_000)).toBe("0s");
	});
});

describe("formatClockTime", () => {
	it("shows HH:MM for a reset on the current day", () => {
		expect(formatClockTime(NOW + FIVE_H, NOW)).toBe("19:00");
	});

	it("prefixes a weekday for a reset on another day", () => {
		// NOW is a Thursday; NOW + 7d 2h is a Thursday one week later.
		expect(formatClockTime(NOW + SEVEN_D + 2 * 3_600_000, NOW)).toBe("Thu 16:00");
	});

	it("pads single digits", () => {
		expect(formatClockTime(NOW + 2 * 3_600_000 + 7 * 60_000, NOW)).toBe("16:07");
	});
});

describe("formatPercent and isExhausted", () => {
	it("floors to whole percent", () => {
		expect(formatPercent(42.7)).toBe("42%");
		expect(formatPercent(18.4)).toBe("18%");
		expect(formatPercent(99.6)).toBe("99%");
	});

	it("exhausted at 100 and above", () => {
		expect(isExhausted({ label: "5h", usedPercent: 99.6, resetsAtMs: 0, windowLengthMs: FIVE_H })).toBe(false);
		expect(isExhausted({ label: "5h", usedPercent: 100, resetsAtMs: 0, windowLengthMs: FIVE_H })).toBe(true);
	});
});
