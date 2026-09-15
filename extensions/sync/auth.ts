/**
 * The auth session: one token lifecycle per run (issue #38, ADR 0007).
 *
 * It resolves the credential, renews a managed token near expiry before any
 * operation, and hands the caller a `renew` callback the Gist backend invokes
 * after a mid-operation 401/403. The bounds, in full:
 *
 * - at most one refresh and at most one device-flow re-run per run, then a
 *   clean error (the backend retries the request exactly once);
 * - a device-flow re-run happens only for a token the tool issued, and only
 *   when this context can show the flow (a CLI tty or a pi TUI dialog);
 * - a hand-written token (plain file or PI_SYNC_TOKEN) is never refreshed,
 *   rotated, or re-run: a rejection of it is a plain error;
 * - a 404 never touches this module: the backend only renews on 401/403.
 */
import { resolveClientId } from "./config.ts";
import type { DeviceFlowResult, OAuthTransport } from "./deviceflow.ts";
import { needsProactiveRefresh, refreshAccessToken } from "./refresh.ts";
import { GITHUB_BASE_URL_ENV, homeFor, resolveToken, stateDirFor, tokenPathFor, type ManagedTokenData, type TokenSource } from "./token.ts";

export interface DeviceFlowHooks {
	/** One user-facing status line (the code to enter, expiry, storage). */
	onStatus: (line: string) => void;
	/** Asked when the code expired or was denied. False cancels the flow. */
	askRetry: () => Promise<boolean>;
}

export interface AuthSessionEnv {
	env: NodeJS.ProcessEnv;
	/**
	 * Present when this context can show the device flow (CLI on a tty, pi
	 * TUI dialog). Absent for non-tty runs and background work: the flow
	 * never starts and the fix is printed instead. The flow owns its own
	 * hooks (status lines, retry prompt); the wiring only supplies the run.
	 */
	deviceFlow?: {
		run: () => Promise<DeviceFlowResult>;
	};
	/** OAuth transport for the refresh calls (tests stub it). */
	oauthTransport?: OAuthTransport;
}

export interface AuthSession {
	/** The token for this run. */
	token: string;
	/** Advisory warning from the token file (for example a loose mode). */
	warning?: string;
	source: TokenSource;
	managed?: ManagedTokenData;
	/**
	 * Called by the backend after a 401/403: one refresh, then one
	 * device-flow re-run (when allowed), then undefined so the caller fails
	 * cleanly. Effectively callable once: later calls return undefined.
	 */
	renew: () => Promise<string | undefined>;
}

interface SessionState {
	token: string;
	warning?: string;
	source: TokenSource;
	managed?: ManagedTokenData;
}

/** Open an auth session for one run. Never throws: errors are reported. */
export async function createAuthSession(sessionEnv: AuthSessionEnv): Promise<{ session?: AuthSession; error?: string }> {
	const home = homeFor(sessionEnv.env);
	const stateDir = stateDirFor(home, sessionEnv.env);
	const baseUrl = sessionEnv.env[GITHUB_BASE_URL_ENV] ?? "https://api.github.com";
	const flow = sessionEnv.deviceFlow;

	const flowState = (accessToken: string, refreshToken: string, obtainedMs: number, expiresMs: number): SessionState => ({
		token: accessToken,
		source: "managed-file",
		managed: { refreshToken, obtainedMs, expiresMs },
	});

	async function tryFlow(): Promise<{ state?: SessionState; error?: string }> {
		if (!flow?.run) return { error: "the device flow is not available in this context" };
		const result = await flow.run();
		if (result.ok) return { state: flowState(result.token!.accessToken, result.token!.refreshToken, result.token!.obtainedMs, result.token!.expiresMs) };
		if (result.cancelled) return { error: "device flow cancelled; nothing was done" };
		return { error: result.error };
	}

	const resolution = resolveToken(home, sessionEnv.env);
	let current: SessionState;
	if (!resolution.token) {
		if (flow) {
			const clientId = resolveClientId(home, sessionEnv.env);
			if (!clientId.clientId) return { error: clientId.error }; // interactive: name the setup step
			const started = await tryFlow();
			if (started.error) return { error: started.error };
			current = started.state!;
		} else {
			return { error: resolution.error ?? `no GitHub token; see ${tokenPathFor(stateDir)}` }; // non-tty: print the fix
		}
	} else {
		current = { token: resolution.token!, warning: resolution.warning, source: resolution.source!, managed: resolution.managed };
	}

	// Proactive renewal of a managed token near expiry (issue #38).
	if (current.source === "managed-file" && current.managed && needsProactiveRefresh(current.managed)) {
		const clientId = resolveClientId(home, sessionEnv.env);
		if (clientId.clientId) {
			const refresh = await refreshAccessToken({ stateDir, baseUrl, clientId: clientId.clientId, refreshToken: current.managed.refreshToken, transport: sessionEnv.oauthTransport });
			if (refresh.ok) {
				current = flowState(refresh.token.accessToken, refresh.token.refreshToken, refresh.token.obtainedMs, refresh.token.expiresMs);
				current.warning = resolution.warning;
			} else if (refresh.refreshDead) {
				if (flow) {
					const started = await tryFlow();
					if (started.state) current = { ...started.state, warning: resolution.warning };
					else if (started.error) return { error: started.error };
				} else if (current.managed.expiresMs <= Date.now()) {
					return {
						error:
							`the stored token is expired and its refresh token is dead. Re-run pi-sync in a terminal to ` +
							`re-authenticate (device flow), or write a fresh token to ${tokenPathFor(stateDir)} / set PI_SYNC_TOKEN.`,
					};
				}
				// Still unexpired: proceed with the old token; a mid-operation
				// 401/403 falls through to renew() below.
			} else if (current.managed.expiresMs <= Date.now()) {
				return { error: `the stored token is expired and the refresh failed: ${refresh.error}` };
			}
			// Transient failure with an unexpired token: proceed; renew() retries once.
		} else if (current.managed.expiresMs <= Date.now()) {
			return {
				error: `the stored token is expired and its refresh needs the OAuth client id. Run scripts/setup-sync-wizard.sh once, or re-run in a terminal.`,
			};
		}
	}

	// The mid-operation renewal callback the backend can use once.
	let renewUsed = false;
	const renew = async (): Promise<string | undefined> => {
		if (renewUsed) return undefined;
		renewUsed = true;
		if (current.source !== "managed-file" || !current.managed) return undefined; // hand-written: never managed
		const clientId = resolveClientId(home, sessionEnv.env);
		if (!clientId.clientId) return undefined;
		const refresh = await refreshAccessToken({ stateDir, baseUrl, clientId: clientId.clientId, refreshToken: current.managed.refreshToken, transport: sessionEnv.oauthTransport });
		if (refresh.ok) {
			current = { ...flowState(refresh.token.accessToken, refresh.token.refreshToken, refresh.token.obtainedMs, refresh.token.expiresMs), warning: current.warning };
			return current.token;
		}
		if (refresh.refreshDead) {
			const started = await tryFlow();
			if (started.state) {
				current = { ...started.state, warning: current.warning };
				return current.token;
			}
		}
		return undefined;
	};

	return { session: { token: current.token, warning: current.warning, source: current.source, managed: current.managed, renew } };
}
