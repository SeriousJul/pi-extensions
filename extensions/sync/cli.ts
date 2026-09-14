/**
 * pi-sync CLI: the Sync wizard plus the four operations (issue #32).
 *
 * First run on a device: `pi-sync init` with no id walks the whole wizard -
 * the OAuth device flow (a tty is required; a non-tty run prints the fix
 * instead), the gist create, the preview, and the confirm - and ends with a
 * joined device. Other devices pair with `pi-sync init <gist-id>`.
 *
 * Home and state locations can be overridden by environment for scripted or
 * CI-like contexts (see token.ts). The same operations run inside pi as
 * /sync commands (index.ts); the code path is shared.
 */
import { createInterface } from "node:readline/promises";
import { createBackend } from "./backends.ts";
import { createAuthSession, type AuthSession, type DeviceFlowHooks } from "./auth.ts";
import { resolveClientId } from "./config.ts";
import { runDeviceFlow, type DeviceFlowResult } from "./deviceflow.ts";
import { runInit, runPull, runPush, runStatus, type SyncOutcome, type SyncRuntime } from "./ops.ts";
import { GITHUB_BASE_URL_ENV, HOME_ENV, STATE_DIR_ENV, TOKEN_ENV, homeFor, stateDirFor } from "./token.ts";
import type { SyncManifest } from "./types.ts";

const HELP = `pi-sync: cross-device pi config sync (issue #32)

usage:
  pi-sync init [gist-id] [--yes] [--force]
      no id:   create the shared secret gist from this device's tree
      with id: join this device to an existing gist
      --yes    confirm the preview without prompting (non-tty runs need this)
      --force  re-init an already-joined device without prompting
  pi-sync push             resolve the merge, then upload this device's tree
  pi-sync pull             fetch and three-way merge the remote into this tree
  pi-sync status           compare without moving anything

first run (once per device):
  1. scripts/setup-sync-wizard.sh   register the GitHub OAuth app (human step)
  2. pi-sync init                   device flow, create the gist, confirm
  other devices: pi-sync init <gist-id>

token:    the device flow stores a gist-only token (JSON) in the state dir;
          the tool renews it while it lives. A hand-written plain-text token
          file or ${TOKEN_ENV} is respected but never managed.
state dir: ${STATE_DIR_ENV} (default <home>/.pi/sync)
home:     ${HOME_ENV} (default the OS home)
github:   ${GITHUB_BASE_URL_ENV} (default https://api.github.com)`;

export interface CliOutput {
	out: (line: string) => void;
	err: (line: string) => void;
}

/** Build the runtime the operations run on. One factory: CLI and pi commands. */
export function buildSyncRuntime(env: NodeJS.ProcessEnv, token: string, renew?: () => Promise<string | undefined>): SyncRuntime {
	const home = homeFor(env);
	const stateDir = stateDirFor(home, env);
	return {
		home,
		stateDir,
		buildBackend: (manifest: SyncManifest, extra) => {
			const built = createBackend(manifest, { token, githubBaseUrl: env[GITHUB_BASE_URL_ENV], signal: extra?.signal, onAuthFailure: renew }, extra);
			if (!built.backend) throw new Error(built.error ?? "could not build the sync backend");
			return built.backend;
		},
	};
}

/** Ask one question on the tty. Only ever called on a tty. */
export async function ttyQuestion(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

/** The tty hooks the device flow and the preview confirm share. */
export function ttyFlowHooks(output: CliOutput): DeviceFlowHooks {
	return {
		onStatus: (line) => output.out(line),
		askRetry: async () => {
			const answer = await ttyQuestion("Retry the device flow with a fresh code? (y/n) ");
			return /^y(es)?$/i.test(answer);
		},
	};
}

function defaultOpenBrowser(url: string): void {
	if (process.env.PI_SYNC_NO_BROWSER) return;
	void import("open")
		.then((m) => (m.default ?? m)(url))
		.catch(() => undefined); // no browser available: the URL is already shown
}

/**
 * The device flow for a CLI on a tty. Non-tty runs never start the flow
 * (issue #37): the caller gets a fix instead of a prompt.
 */
export async function cliDeviceFlow(env: NodeJS.ProcessEnv, hooks: DeviceFlowHooks): Promise<DeviceFlowResult> {
	const home = homeFor(env);
	const stateDir = stateDirFor(home, env);
	return runDeviceFlow({
		stateDir,
		baseUrl: env[GITHUB_BASE_URL_ENV],
		clientId: resolveClientId(home, env).clientId ?? "",
		signal: undefined,
		onStatus: (line) => hooks.onStatus(line),
		askRetry: () => hooks.askRetry(),
		openBrowser: defaultOpenBrowser,
	});
}

interface ParsedInitArgs {
	gistId?: string;
	yes: boolean;
	force: boolean;
	error?: string;
}

function parseInitArgs(rest: string[]): ParsedInitArgs {
	let gistId: string | undefined;
	let yes = false;
	let force = false;
	for (const arg of rest) {
		if (arg === "--yes") yes = true;
		else if (arg === "--force") force = true;
		else if (arg.startsWith("-")) return { gistId, yes, force, error: `unknown flag: ${arg}` };
		else if (gistId === undefined) gistId = arg;
		else return { gistId, yes, force, error: `unexpected argument: ${arg}` };
	}
	return { gistId, yes, force };
}

export async function main(argv: string[], output: CliOutput = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
	const [command, ...rest] = argv;
	try {
		const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

		const withSession = async (run: (rt: SyncRuntime) => Promise<SyncOutcome>): Promise<SyncOutcome> => {
			// The device flow only starts on a tty; a non-tty run gets the fix.
			const deviceFlow = interactive
				? { hooks: ttyFlowHooks(output), run: (hooks: DeviceFlowHooks) => cliDeviceFlow(process.env, hooks) }
				: undefined;
			const built = await createAuthSession({ env: process.env, deviceFlow });
			if (!built.session) return { ok: false, error: built.error ?? "could not open the auth session" };
			const session = built.session;
			const rt = buildSyncRuntime(process.env, session.token, session.renew);
			const outcome = await run(rt);
			if (outcome.ok && session.warning) outcome.report.warnings = [session.warning, ...outcome.report.warnings];
			return outcome;
		};

		// The preview confirm: a tty asks at a prompt; a non-tty run needs --yes.
		const ask = interactive
			? async (preview: string[]): Promise<boolean> => {
					for (const line of preview) output.out(line);
					const answer = await ttyQuestion("Proceed? (y/n) ");
					return /^y(es)?$/i.test(answer);
				}
			: undefined;

		switch (command) {
			case "init": {
				const parsed = parseInitArgs(rest);
				if (parsed.error) {
					output.err(`pi-sync: ${parsed.error}`);
					output.err("usage: pi-sync init [gist-id] [--yes] [--force]");
					return 2;
				}
				return finish(await withSession((rt) => runInit(rt, parsed.gistId, { yes: parsed.yes, force: parsed.force, ask })), output);
			}
			case "push":
				return finish(await withSession((rt) => runPush(rt)), output);
			case "pull":
				return finish(await withSession((rt) => runPull(rt)), output);
			case "status":
				return finish(await withSession((rt) => runStatus(rt)), output);
			case undefined:
			case "help":
				output.out(HELP);
				return command === undefined ? 2 : 0;
			default:
				output.err(`unknown command: ${command}`);
				output.err(HELP);
				return 2;
		}
	} catch (err) {
		output.err(`pi-sync: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

function finish(outcome: SyncOutcome, output: CliOutput): number {
	if (!outcome.ok) {
		for (const line of outcome.preview ?? []) output.out(line);
		output.err(`pi-sync: ${outcome.error}`);
		return 1;
	}
	for (const line of outcome.report.lines) output.out(line);
	for (const warning of outcome.report.warnings) output.out(warning);
	return 0;
}
