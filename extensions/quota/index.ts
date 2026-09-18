/**
 * Quota extension entrypoint (issue #28).
 *
 * Thin wiring over the Quota source module (source.ts, which owns all data
 * logic and the ChatGPT token refresh, ADR 0005): one footer line with the
 * 5-hour and weekly windows, one `/quota` command for a fresh read and the
 * detail view, and a fixed 5-minute poll. The wiring mirrors context-cap:
 * flags, events, and UI calls only.
 *
 * State is one Usage snapshot per session. A successful read replaces it;
 * a failed read marks it stale, so the last good numbers stay visible.
 * Exactly one error notification goes out per new failure; repeated
 * failures while polling are silent. A dead login is told with a
 * re-login error instead.
 *
 * All UI calls are guarded, so print and JSON modes never see quota output.
 * The poll interval is a fixed constant on purpose: there is no
 * configuration surface for it.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey } from "@earendil-works/pi-tui";

import { renderFooter, renderQuotaDetail, type QuotaLine } from "./render.ts";
import { createQuotaSource, type QuotaSource, type UsageSnapshot } from "./source.ts";
import { setPiece } from "../shared/status-line.ts";
/** Fixed by design: the interval is not configurable (issue #28). */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Paint one quota line with the theme color its tone names. */
export function paintQuotaLine(line: QuotaLine, theme: Theme): string {
	if (line.tone === "error") return theme.fg("error", line.text);
	if (line.tone === "warning") return theme.fg("warning", line.text);
	if (line.tone === "dim") return theme.fg("dim", line.text);
	return line.text;
}

/**
 * The /quota detail view: the detail lines in a boxed panel, closed with
 * Enter or Esc. The extension command and the screenshot pipeline (issue
 * #73) mount this same component, so the committed shot cannot drift from
 * what the command shows.
 */
export function createQuotaDetailComponent(lines: QuotaLine[], theme: Theme, onClose: () => void) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("accent", "ChatGPT plan quota"), 0, 0));
	for (const line of lines) {
		box.addChild(new Text(paintQuotaLine(line, theme), 0, 0));
	}
	box.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 0, 0));
	return {
		render: (width: number) => box.render(width),
		invalidate: () => box.invalidate(),
		handleInput: (data: string) => {
			if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
				onClose();
			}
		},
	};
}

export default function (pi: ExtensionAPI): void {
	let source: QuotaSource | null = null;
	let sessionCtx: ExtensionContext | null = null;
	let snapshot: UsageSnapshot | undefined;
	let stale = false;
	/** Reason of the failure already notified, or null when no failure is live. */
	let notifiedFailure: string | null = null;
	/** The in-flight read, so a /quota and a poll never double-read. */
	let activeRefresh: Promise<void> | null = null;
	/** Monotonic id per read, so a late-finished old read cannot clear a newer one. */
	let refreshId = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function updateFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!snapshot) {
			setPiece(ctx, "quota", "right", undefined);
			return;
		}
		setPiece(ctx, "quota", "right", renderFooter(snapshot, stale).map((line) => paintQuotaLine(line, ctx.ui.theme)).join(""));
	}

	function notifyFailure(ctx: ExtensionContext, reason: string, message: string): void {
		if (!ctx.hasUI) return;
		const suffix = reason === "login-dead" ? " Log in again with /login openai-codex." : "";
		ctx.ui.notify(`quota: ${message}${suffix}`, "error");
	}

	/**
	 * One quota read. Concurrent callers share the in-flight read. On
	 * success the snapshot is replaced and the failure marker cleared; on
	 * failure the snapshot (if any) is marked stale and one error goes out,
	 * unless the same reason was already reported.
	 */
	function refresh(ctx: ExtensionContext): Promise<void> {
		if (!source) return Promise.resolve();
		if (activeRefresh) return activeRefresh;
		const currentSource = source;
		const id = ++refreshId;
		const run = (async () => {
			try {
				const result = await currentSource.read();
				if (result.ok) {
					snapshot = result.snapshot;
					stale = false;
					notifiedFailure = null;
				} else {
					// no-login has nothing to keep stale and nothing to report:
					// the extension stays invisible until a login exists.
					if (result.reason !== "no-login" && snapshot) stale = true;
					if (result.reason !== "no-login" && notifiedFailure !== result.reason) {
						notifiedFailure = result.reason;
						notifyFailure(ctx, result.reason, result.message);
					}
				}
				updateFooter(ctx);
			} finally {
				if (refreshId === id) activeRefresh = null;
			}
		})();
		activeRefresh = run;
		return run;
	}

	pi.on("session_start", (_event, ctx) => {
		// Each session starts clean; the handler set persists across sessions.
		stopTimer();
		source = createQuotaSource();
		sessionCtx = ctx;
		snapshot = undefined;
		stale = false;
		notifiedFailure = null;
		updateFooter(ctx);
		void refresh(ctx);
		timer = setInterval(() => {
			if (sessionCtx) void refresh(sessionCtx);
		}, POLL_INTERVAL_MS);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		source = null;
		sessionCtx = null;
		snapshot = undefined;
		stale = false;
		notifiedFailure = null;
		if (ctx.hasUI) setPiece(ctx, "quota", "right", undefined);
	});

	pi.registerCommand("quota", {
		description: "Read the ChatGPT plan quota now and show the detail view",
		handler: async (_args, ctx) => {
			await refresh(ctx);
			if (ctx.mode !== "tui") return;
			if (!snapshot) {
				ctx.ui.notify("quota: no usage numbers yet, the last read failed", "error");
				return;
			}
			const lines = renderQuotaDetail(snapshot, stale, Date.now());
			await ctx.ui.custom((_tui, theme, _keybindings, done) => createQuotaDetailComponent(lines, theme, () => done(undefined)));
		},
	});
}
