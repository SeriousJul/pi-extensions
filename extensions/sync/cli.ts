/**
 * pi-sync CLI: the same four operations as the pi commands, runnable from any
 * shell. Home and state locations can be overridden by environment for
 * scripted or CI-like contexts (see token.ts).
 */
import { createBackend } from "./backends.ts";
import { GITHUB_BASE_URL_ENV, homeFor, resolveToken, stateDirFor } from "./token.ts";
import { runInit, runPull, runPush, runStatus, type SyncOutcome, type SyncRuntime } from "./ops.ts";
import type { SyncManifest } from "./types.ts";

const HELP = `pi-sync: cross-device pi config sync (issue #32)

usage:
  pi-sync init <gist-id>   join a new device to an existing gist
  pi-sync push             resolve the merge, then upload this device's tree
  pi-sync pull             fetch and three-way merge the remote into this tree
  pi-sync status           compare without moving anything

token:    owner-only file in the sync state dir, or PI_SYNC_TOKEN
state dir: PI_SYNC_STATE_DIR (default <home>/.pi/sync)
home:     PI_SYNC_HOME (default the OS home)
github:   ${GITHUB_BASE_URL_ENV} (default https://api.github.com)`;

export interface CliOutput {
	out: (line: string) => void;
	err: (line: string) => void;
}

/** Build the runtime the operations run on. One factory: CLI and pi commands. */
export function buildSyncRuntime(env: NodeJS.ProcessEnv, token: string): SyncRuntime {
	const home = homeFor(env);
	const stateDir = stateDirFor(home, env);
	return {
		home,
		stateDir,
		buildBackend: (manifest: SyncManifest, extra) => {
			const built = createBackend(manifest, { token, githubBaseUrl: env[GITHUB_BASE_URL_ENV], signal: extra?.signal }, extra);
			if (!built.backend) throw new Error(built.error ?? "could not build the sync backend");
			return built.backend;
		},
	};
}

/** Resolve the device-local token for a run. */
export function tokenFor(env: NodeJS.ProcessEnv): { token?: string; warning?: string; error?: string } {
	const home = homeFor(env);
	return resolveToken(home, env);
}

export async function main(argv: string[], output: CliOutput = { out: (l) => console.log(l), err: (l) => console.error(l) }): Promise<number> {
	const [command, ...rest] = argv;
	try {
		const withRuntime = async (run: (rt: SyncRuntime) => Promise<SyncOutcome>): Promise<SyncOutcome> => {
			const token = tokenFor(process.env);
			if (token.error && !token.token) return { ok: false, error: token.error };
			const outcome = await run(buildSyncRuntime(process.env, token.token ?? ""));
			if (outcome.ok && token.warning) outcome.report.warnings = [token.warning, ...outcome.report.warnings];
			return outcome;
		};

		switch (command) {
			case "init": {
				const gistId = rest[0];
				if (!gistId) {
					output.err("usage: pi-sync init <gist-id>");
					return 2;
				}
				return finish(await withRuntime((rt) => runInit(rt, gistId)), output);
			}
			case "push":
				return finish(await withRuntime((rt) => runPush(rt)), output);
			case "pull":
				return finish(await withRuntime((rt) => runPull(rt)), output);
			case "status":
				return finish(await withRuntime((rt) => runStatus(rt)), output);
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
		output.err(`pi-sync: ${outcome.error}`);
		return 1;
	}
	for (const line of outcome.report.lines) output.out(line);
	for (const warning of outcome.report.warnings) output.out(warning);
	return 0;
}
