/**
 * Sync extension entrypoint (issue #32).
 *
 * Thin wiring over the engine-free core (ops.ts and friends, tested through
 * the in-memory backend fake at the Backend seam): one /sync command with
 * the four operations, and a passive ahead/behind status line on session
 * start. The startup notice is read-only with a short timeout: it never
 * blocks startup and never moves data.
 *
 * The same operations run from any shell through the pi-sync CLI
 * (cli.ts / cli.mjs), which shares buildSyncRuntime with this file.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey } from "@earendil-works/pi-tui";

import { buildSyncRuntime, tokenFor } from "./cli.ts";
import { runInit, runPull, runPush, runStatus, type SyncOutcome, type SyncRuntime } from "./ops.ts";

const STATUS_KEY = "sync";
/** The startup notice must never hold startup up. */
const NOTICE_TIMEOUT_MS = 5_000;

const USAGE = [
	"usage: /sync init <gist-id> | /sync push | /sync pull | /sync status",
	"  init <gist-id>  join this device to an existing gist (new devices)",
	"  push            resolve the merge, then upload this device's tree",
	"  pull            fetch and three-way merge the remote into this tree",
	"  status          compare without moving anything",
].join("\n");

export default function (pi: ExtensionAPI): void {
	let sessionCtx: ExtensionContext | null = null;

	/** The token warning (for example a group-readable token file) rides with the runtime so every report carries it. */
	function makeRuntime(signal?: AbortSignal): { runtime?: SyncRuntime; warning?: string; error?: string } {
		const token = tokenFor(process.env);
		if (token.error && !token.token) return { error: token.error };
		try {
			const runtime = buildSyncRuntime(process.env, token.token ?? "");
			return signal ? { runtime: withSignal(runtime, signal), warning: token.warning } : { runtime, warning: token.warning };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Pin the same abort signal into the backend the operations build. */
	function withSignal(runtime: SyncRuntime, signal: AbortSignal): SyncRuntime {
		return {
			...runtime,
			buildBackend: (manifest, extra) => runtime.buildBackend(manifest, { ...extra, signal }),
		};
	}

	/**
	 * Passive startup notice: a read-only status with a short timeout.
	 * Reports ahead/behind counts only, or nothing at all: no token, no
	 * manifest, drift of zero, or a failure all leave the status line empty.
	 */
	function startupNotice(ctx: ExtensionContext): void {
		void (async () => {
			try {
				if (!ctx.hasUI) return;
				const built = makeRuntime(AbortSignal.timeout(NOTICE_TIMEOUT_MS));
				if (!built.runtime) return;
				const outcome = await runStatus(built.runtime);
				if (!outcome.ok) return;
				const { ahead, behind } = outcome.report;
				if (sessionCtx !== ctx) return; // a newer session owns the line now
				if (ahead === 0 && behind === 0) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} else {
					ctx.ui.setStatus(STATUS_KEY, `sync: ${ahead} ahead, ${behind} behind`);
				}
			} catch {
				// The notice is best effort. Startup never sees an error.
			}
		})();
	}

	function show(ctx: ExtensionContext, lines: string[], isError: boolean): void {
		if (!ctx.hasUI) {
			if (isError) console.error(`sync: ${lines.join("\n")}`);
			else console.log(lines.join("\n"));
			return;
		}
		if (ctx.mode !== "tui") {
			// Print and RPC modes: the report goes to the stream, nothing to draw.
			console.log(lines.join("\n"));
			return;
		}
		void ctx.ui
			.custom((_tui, theme: Theme, _keybindings, done) => {
				const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
				box.addChild(new Text(theme.fg("accent", `pi sync${isError ? " (error)" : ""}`), 0, 0));
				for (const line of lines) {
					box.addChild(new Text(isError ? theme.fg("error", line) : line, 0, 0));
				}
				box.addChild(new Text(theme.fg("dim", "Press Enter or Esc to close"), 0, 0));
				return {
					render: (width: number) => box.render(width),
					invalidate: () => box.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
					},
				};
			})
			.catch(() => undefined);
	}

	async function run(args: string, ctx: ExtensionContext): Promise<void> {
		const [command, ...rest] = args.trim().split(/\s+/);
		let outcome: SyncOutcome;
		let tokenWarning: string | undefined;
		switch (command) {
			case "init": {
				const gistId = rest[0];
				if (!gistId) {
					show(ctx, ["usage: /sync init <gist-id>"], true);
					return;
				}
				const built = makeRuntime();
				if (!built.runtime) {
					show(ctx, [built.error ?? "could not build the sync backend"], true);
					return;
				}
				tokenWarning = built.warning;
				outcome = await runInit(built.runtime, gistId);
				break;
			}
			case "push":
			case "pull":
			case "status": {
				const built = makeRuntime();
				if (!built.runtime) {
					show(ctx, [built.error ?? "could not build the sync backend"], true);
					return;
				}
				tokenWarning = built.warning;
				outcome =
					command === "push"
						? await runPush(built.runtime)
						: command === "pull"
							? await runPull(built.runtime)
							: await runStatus(built.runtime);
				break;
			}
			case undefined:
				show(ctx, [USAGE], false);
				return;
			default:
				show(ctx, [`unknown subcommand: ${command}`, USAGE], true);
				return;
		}
		if (!outcome.ok) {
			show(ctx, [outcome.error], true);
			return;
		}
		// The token warning (loose token file mode) rides with every report, the same as in the CLI.
		show(ctx, [...outcome.report.lines, ...(tokenWarning ? [tokenWarning] : []), ...outcome.report.warnings], false);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		startupNotice(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionCtx = null;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("sync", {
		description: "Sync pi config across devices (init <gist-id> | push | pull | status)",
		handler: (args, ctx) => run(args, ctx),
	});
}
