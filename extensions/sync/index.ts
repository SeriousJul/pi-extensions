/**
 * Sync extension entrypoint (issue #32).
 *
 * Thin wiring over the engine-free core (ops.ts and friends, tested through
 * the in-memory backend fake at the Backend seam): one /sync command with
 * the wizard (init) and the three operations, a passive ahead/behind status
 * line on session start, and the token lifecycle shared with the CLI.
 *
 * The device flow renders as a TUI dialog; the preview confirm uses the
 * built-in confirm dialog. In print and RPC modes there is no prompt: init
 * needs --yes, and the flow never starts (the fix is shown instead). The
 * startup notice is read-only with a short timeout: it never blocks startup,
 * never moves data, and never starts the device flow. It may renew a managed
 * token through the stored refresh token, the same as every other path.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, matchesKey } from "@earendil-works/pi-tui";

import { buildSyncRuntime, parseInitArgs } from "./cli.ts";
import { createAuthSession, type AuthSession } from "./auth.ts";
import { resolveClientId } from "./config.ts";
import { runDeviceFlow, type DeviceFlowResult } from "./deviceflow.ts";
import { probeStartup, runInit, runPull, runPush, runStatus, type SyncOutcome, type SyncRuntime } from "./ops.ts";
import { GITHUB_BASE_URL_ENV, homeFor, stateDirFor } from "./token.ts";

const STATUS_KEY = "sync";
/** The startup notice must never hold startup up. */
const NOTICE_TIMEOUT_MS = 5_000;

const USAGE = [
	"usage: /sync init [gist-id] [--yes] [--force] | /sync push | /sync pull | /sync status",
	"  init [gist-id]  create the shared gist (no id) or join one (id);",
	"                  TUI confirms the preview, non-TUI needs --yes",
	"  push            resolve the merge, then upload this device's tree",
	"  pull            fetch and three-way merge the remote into this tree",
	"  status          compare without moving anything",
].join("\n");

interface ParsedArgs {
	command: string;
	gistId?: string;
	yes: boolean;
	force: boolean;
	error?: string;
}

/** The /sync arg line: a command, then the shared init parser. */
function parseArgs(args: string): ParsedArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const [command, ...rest] = parts;
	const init = parseInitArgs(rest);
	return { command: command ?? "", gistId: init.gistId, yes: init.yes, force: init.force, error: init.error };
}

export default function (pi: ExtensionAPI): void {
	let sessionCtx: ExtensionContext | null = null;

	/**
	 * Passive startup notice (issue #36): a read-only probe with a short
	 * timeout. The line shows the drift when the device is joined, the
	 * `run /sync init` nudge when a token exists but the device has not joined,
	 * and nothing otherwise (no token, zero drift, or a failed read). It never
	 * starts the device flow. It does renew a managed token through the stored
	 * refresh token (the auth session without a flow): the access token lives
	 * 8 hours, and a probe that could not renew would go blind every day.
	 */
	function startupNotice(ctx: ExtensionContext): void {
		void (async () => {
			try {
				if (!ctx.hasUI) return;
				const built = await createAuthSession({ env: process.env }); // no device flow at startup
				if (!built.session) return; // no token: stay silent
				const runtime = withSignal(
					buildSyncRuntime(process.env, built.session.token, built.session.renew),
					AbortSignal.timeout(NOTICE_TIMEOUT_MS),
				);
				const probe = await probeStartup(runtime);
				if (sessionCtx !== ctx) return; // a newer session owns the line now
				if (probe.state === "not-joined") {
					ctx.ui.setStatus(STATUS_KEY, "sync: not joined - run /sync init");
				} else if (probe.state === "drift") {
					// Herdr-style drift: green up-arrow + count when ahead, red
					// down-arrow + count when behind; either side may be absent.
					const theme = ctx.ui.theme;
					const parts: string[] = [];
					if (probe.ahead > 0) parts.push(theme.fg("success", `↑${probe.ahead}`));
					if (probe.behind > 0) parts.push(theme.fg("error", `↓${probe.behind}`));
					ctx.ui.setStatus(STATUS_KEY, `sync: ${parts.join(" ")}`);
				} else {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
			} catch {
				// The notice is best effort. Startup never sees an error.
			}
		})();
	}

	/** Pin the same abort signal into the backend the operations build. */
	function withSignal(runtime: SyncRuntime, signal: AbortSignal): SyncRuntime {
		return {
			...runtime,
			buildBackend: (manifest, extra) => runtime.buildBackend(manifest, { ...extra, signal }),
		};
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

	/**
	 * The device flow as a TUI dialog (issue #37). The dialog shows the URL
	 * and the one-time code and closes itself when the token arrives. Esc
	 * cancels; an expired or denied code closes the dialog and says to
	 * re-run for a fresh code. Never a silent retry.
	 */
	function deviceFlowDialog(ctx: ExtensionContext): Promise<DeviceFlowResult> {
		const home = homeFor(process.env);
		const client = resolveClientId(home, process.env);
		if (!client.clientId) return Promise.resolve({ ok: false, error: client.error ?? "no OAuth client id" });
		return new Promise((resolve) => {
			let statusLine = "starting the GitHub device flow...";
			let settled = false;
			let done: (result?: unknown) => void = () => undefined;
			let requestRender: (() => void) | undefined;
			const controller = new AbortController();
			const theme = ctx.ui.theme;
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("accent", "pi sync: device flow"), 0, 0));
			const status = new Text(statusLine, 0, 0);
			box.addChild(status);
			box.addChild(new Text(theme.fg("dim", "Enter or Esc cancels"), 0, 0));
			// The status line changes after the dialog is mounted (the code and the
			// token arrive over the network). The TUI only repaints a mounted
			// component when it is asked to, so every change invalidates the box
			// and requests a render.
			const paint = (): void => {
				box.invalidate();
				requestRender?.();
			};
			const settle = (result: DeviceFlowResult): void => {
				if (settled) return;
				settled = true;
				done(undefined);
				resolve(result);
			};
			void runDeviceFlow({
				stateDir: stateDirFor(home, process.env),
				baseUrl: process.env[GITHUB_BASE_URL_ENV],
				clientId: client.clientId!,
				signal: controller.signal,
				onStatus: (line) => {
					statusLine = line;
					status.setText(line);
					paint();
				},
				askRetry: async () => {
					// Expired or denied: close the dialog; a re-run gets a fresh code.
					statusLine = "code expired or denied: close this dialog and re-run /sync init";
					status.setText(statusLine);
					paint();
					return false;
				},
			}).then(settle);
			void ctx.ui
				.custom((tui, _theme, _keybindings, d) => {
					requestRender = () => tui.requestRender();
					done = d;
					return {
						render: (width: number) => box.render(width),
						invalidate: () => box.invalidate(),
						handleInput: (data: string) => {
							if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
								controller.abort();
								settle({ ok: false, cancelled: true });
							}
						},
					};
				})
				.catch(() => settle({ ok: false, cancelled: true }));
		});
	}

	/**
	 * The auth session for a user-invoked /sync run. Only a TUI run can show
	 * the device flow dialog; print and RPC modes never start it (the fix is
	 * shown instead). Renewal (refresh) is always wired for the backend.
	 */
	function makeSession(ctx: ExtensionContext): Promise<{ session?: AuthSession; error?: string }> {
		const deviceFlow: { run: () => Promise<DeviceFlowResult> } | undefined = ctx.hasUI && ctx.mode === "tui" ? { run: () => deviceFlowDialog(ctx) } : undefined;
		return createAuthSession({ env: process.env, deviceFlow });
	}

	async function run(args: string, ctx: ExtensionContext): Promise<void> {
		const parsed = parseArgs(args);
		let outcome: SyncOutcome;
		let sessionWarning: string | undefined;
		switch (parsed.command) {
			case "init": {
				const built = await makeSession(ctx);
				if (!built.session) {
					show(ctx, [built.error ?? "could not open the auth session"], true);
					return;
				}
				const session = built.session;
				sessionWarning = session.warning;
				// TUI: the built-in confirm dialog. Non-TUI: --yes, else nothing.
				const ask = ctx.hasUI && ctx.mode === "tui" ? (preview: string[]) => ctx.ui.confirm("pi sync init", preview.join("\n")) : undefined;
				outcome = await runInit(
					withSignal(buildSyncRuntime(process.env, session.token, session.renew), AbortSignal.timeout(300_000)),
					parsed.gistId,
					{ yes: parsed.yes, force: parsed.force, ask },
				);
				break;
			}
			case "push":
			case "pull":
			case "status": {
				const built = await makeSession(ctx);
				if (!built.session) {
					show(ctx, [built.error ?? "could not open the auth session"], true);
					return;
				}
				const session = built.session;
				sessionWarning = session.warning;
				const rt = withSignal(buildSyncRuntime(process.env, session.token, session.renew), AbortSignal.timeout(300_000));
				outcome = parsed.command === "push" ? await runPush(rt) : parsed.command === "pull" ? await runPull(rt) : await runStatus(rt);
				break;
			}
			case "":
				show(ctx, [USAGE], false);
				return;
			default:
				if (parsed.error) {
					show(ctx, [parsed.error, USAGE], true);
					return;
				}
				show(ctx, [`unknown subcommand: ${parsed.command}`, USAGE], true);
				return;
		}
		if (!outcome.ok) {
			// A declined preview was already shown in the confirm dialog; show it only once.
			const preview = outcome.preview && !outcome.previewShown ? outcome.preview : [];
			show(ctx, [...preview, outcome.error], true);
			return;
		}
		// The token warning (loose token file mode) rides with every report, the same as in the CLI.
		// --yes and --force consent still show the preview, before the report.
		show(ctx, [...(outcome.preview ?? []), ...outcome.report.lines, ...(sessionWarning ? [sessionWarning] : []), ...outcome.report.warnings], false);
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
		description: "Sync pi config across devices (init [gist-id] | push | pull | status)",
		handler: (args, ctx) => run(args, ctx),
	});
}
