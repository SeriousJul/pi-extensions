/**
 * Device-local credential and state locations. The GitHub token is a local
 * fact: it lives in an owner-only file in the sync state directory, and an
 * environment variable overrides it for scripted or CI-like contexts. The
 * token file is never part of the Snapshot.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOKEN_ENV = "PI_SYNC_TOKEN";
export const STATE_DIR_ENV = "PI_SYNC_STATE_DIR";
export const HOME_ENV = "PI_SYNC_HOME";
export const GITHUB_BASE_URL_ENV = "PI_SYNC_GITHUB_BASE_URL";

/** The sync state directory: PI_SYNC_STATE_DIR, else <home>/.pi/sync. */
export function stateDirFor(home: string, env: NodeJS.ProcessEnv = process.env): string {
	return env[STATE_DIR_ENV] || join(home, ".pi", "sync");
}

/** The home directory sync operates on: PI_SYNC_HOME, else the OS home. */
export function homeFor(env: NodeJS.ProcessEnv = process.env): string {
	return env[HOME_ENV] || homedir();
}

/**
 * Resolve the GitHub token: the environment override wins, then the owner-only
 * token file. `error` carries the exact fix to show when neither exists.
 */
export function resolveToken(home: string, env: NodeJS.ProcessEnv = process.env): { token?: string; warning?: string; error?: string } {
	const fromEnv = env[TOKEN_ENV];
	if (fromEnv && fromEnv.trim() !== "") return { token: fromEnv.trim() };

	const stateDir = stateDirFor(home, env);
	const tokenPath = join(stateDir, "token");
	try {
		const stat = statSync(tokenPath);
		if (!stat.isFile()) {
			return { error: `${tokenPath} is not a regular file; write the token as plain text there or set ${TOKEN_ENV}` };
		}
		if ((stat.mode & 0o077) !== 0) {
			// Warn on the happy path too: a token readable by others defeats the point.
			const token = readFileSync(tokenPath, "utf8").trim();
			if (token === "") return { error: noTokenMessage(tokenPath) };
			return { token, warning: `token file is group or world readable; run: chmod 600 ${tokenPath}` };
		}
		const text = readFileSync(tokenPath, "utf8").trim();
		if (text === "") {
			return { error: noTokenMessage(tokenPath) };
		}
		return { token: text };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			return { error: `cannot read ${tokenPath}: ${String(err)}` };
		}
		return { error: noTokenMessage(tokenPath) };
	}
}

function noTokenMessage(tokenPath: string): string {
	return (
		`no GitHub token configured for pi sync. ` +
		`Create a personal access token with gist scope, then either ` +
		`write it to ${tokenPath} (owner-only: mkdir -p $(dirname ${tokenPath}) && printf '%s\\n' <token> > ${tokenPath} && chmod 600 ${tokenPath}), ` +
		`or set ${TOKEN_ENV} for this run.`
	);
}
