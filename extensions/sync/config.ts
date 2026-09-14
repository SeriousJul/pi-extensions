/**
 * The OAuth client id config (ADR 0007). The device flow needs a registered
 * GitHub OAuth app; its public client id is a per-account fact, so it lives
 * in a local config file in the sync state directory, written by the one-time
 * setup wizard (scripts/setup-sync-wizard.sh). An environment variable wins
 * for scripted and CI-like contexts. The id is public: it is not a secret,
 * and it stays out of the source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stateDirFor } from "./token.ts";

export const CLIENT_ID_ENV = "PI_SYNC_OAUTH_CLIENT_ID";
export const CLIENT_CONFIG_NAME = "oauth-client.json";

/** Where the setup wizard writes the client id. */
export function clientIdPathFor(stateDir: string): string {
	return join(stateDir, CLIENT_CONFIG_NAME);
}

export interface ClientIdResolution {
	clientId?: string;
	/** A clear error that names the setup step. Never a stack trace. */
	error?: string;
}

/**
 * Resolve the OAuth client id: the environment override wins, then the
 * config file the setup wizard writes.
 */
export function resolveClientId(home: string, env: NodeJS.ProcessEnv = process.env): ClientIdResolution {
	const fromEnv = env[CLIENT_ID_ENV];
	if (fromEnv && fromEnv.trim() !== "") return { clientId: fromEnv.trim() };

	const path = clientIdPathFor(stateDirFor(home, env));
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				error:
					`no OAuth client id for the pi sync device flow. Run scripts/setup-sync-wizard.sh once ` +
					`(it walks the GitHub OAuth app steps and writes ${path}), or set ${CLIENT_ID_ENV}.`,
			};
		}
		return { error: `cannot read ${path}: ${String(err)}` };
	}
	try {
		const data: unknown = JSON.parse(text);
		const id = typeof data === "object" && data !== null ? (data as { oauthClientId?: unknown }).oauthClientId : undefined;
		if (typeof id === "string" && id.trim() !== "") return { clientId: id.trim() };
		return { error: `${path} has no "oauthClientId" string; re-run scripts/setup-sync-wizard.sh or set ${CLIENT_ID_ENV}` };
	} catch {
		return { error: `${path} is not valid JSON; re-run scripts/setup-sync-wizard.sh or set ${CLIENT_ID_ENV}` };
	}
}
