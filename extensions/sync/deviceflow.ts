/**
 * The OAuth device flow (ADR 0007): the tool shows a one-time code and the
 * verification URL at github.com/login/device, and polls every few seconds.
 * When the user enters the code, GitHub hands the tool a gist-scoped token
 * pair: an 8-hour access token plus a rolling refresh token. The pair is
 * stored in the managed JSON token file the moment it arrives.
 *
 * An expired or denied code offers retry (a fresh code) or cancel; there is
 * never a silent retry. Callers decide where the status lines and the retry
 * prompt go (CLI tty, pi TUI dialog), so this module owns only the protocol
 * and the storage.
 */
import { writeManagedToken, type ManagedTokenPair } from "./token.ts";

export const DEVICE_FLOW_SCOPE = "gist";
export const DEVICE_VERIFICATION_URL = "https://github.com/login/device";
/** GitHub's documented polling cadence when the server does not say otherwise. */
export const DEVICE_POLL_INTERVAL_MS = 5_000;

/** The transport seam: one POST function. Production uses the global fetch. */
export interface OAuthTransport {
	request(
		method: "POST",
		url: string,
		options: { headers: Record<string, string>; body?: string; signal?: AbortSignal },
	): Promise<{ status: number; text: string }>;
}

/** The default transport: Node's global fetch. */
export function createFetchOAuthTransport(): OAuthTransport {
	return {
		async request(method, url, options) {
			const response = await fetch(url, {
				method,
				headers: options.headers,
				body: options.body,
				signal: options.signal,
			});
			return { status: response.status, text: await response.text() };
		},
	};
}

export interface DeviceFlowDeps {
	/** The managed token is written here (the sync state dir). */
	stateDir: string;
	/** GitHub API base. Overridable for tests and GitHub-compatible hosts. */
	baseUrl?: string;
	clientId: string;
	transport?: OAuthTransport;
	/** Aborting cancels the flow cleanly. */
	signal?: AbortSignal;
	/** One line per user-facing event (the code to enter, expiry, storage). */
	onStatus: (line: string) => void;
	/** Asked when the code expired or was denied. False cancels the flow. */
	askRetry: () => Promise<boolean>;
}

export interface DeviceFlowResult {
	ok: boolean;
	/** Set when the user cancelled (Esc / no at a retry prompt). */
	cancelled?: boolean;
	/** Set when the flow failed without a user cancellation. */
	error?: string;
	/** Present only when ok. */
	token?: ManagedTokenPair;
}

interface DeviceCodeResponse {
	device_code?: unknown;
	user_code?: unknown;
	verification_uri?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface TokenEndpointResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	error?: unknown;
}

/** Run the device flow until it yields a token, is cancelled, or fails. */
export async function runDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceFlowResult> {
	const baseUrl = (deps.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
	const transport = deps.transport ?? createFetchOAuthTransport();

	async function post<T>(path: string, body: Record<string, string>): Promise<{ status: number; json: T }> {
		const response = await transport.request("POST", `${baseUrl}${path}`, {
			headers: { Accept: "application/json", "User-Agent": "pi-sync", "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: deps.signal,
		});
		let json: T = {} as T;
		try {
			json = JSON.parse(response.text) as T;
		} catch {
			// Non-JSON body: the caller's switch falls through to a clean error.
		}
		return { status: response.status, json };
	}

	async function pollIntervalSleep(ms: number): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const signal = deps.signal;
			let timer: ReturnType<typeof setTimeout>;
			const onAbort = () => {
				clearTimeout(timer);
				reject(new AbortError());
			};
			timer = setTimeout(() => {
				// A long poll runs many sleeps; each one drops its abort
				// listener when it resolves, so the signal never grows them.
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	try {
		outer: for (;;) {
			if (deps.signal?.aborted) return { ok: false, cancelled: true };
			const deviceRequest = await post<DeviceCodeResponse>("/login/device/code", { client_id: deps.clientId, scope: DEVICE_FLOW_SCOPE });
			const device = deviceRequest.json;
			if (deviceRequest.status < 200 || deviceRequest.status >= 300 || typeof device.device_code !== "string" || typeof device.user_code !== "string") {
				return { ok: false, error: `could not start the device flow (HTTP ${deviceRequest.status}). Check the OAuth client id config.` };
			}
			const verificationUrl = typeof device.verification_uri === "string" && device.verification_uri !== "" ? device.verification_uri : DEVICE_VERIFICATION_URL;
			const expiresIn = typeof device.expires_in === "number" ? device.expires_in : 900;
			deps.onStatus(`Open ${verificationUrl} and enter the code ${device.user_code} (it expires in ${Math.round(expiresIn / 60)} minutes)`);

			let intervalMs = typeof device.interval === "number" && device.interval > 0 ? device.interval * 1000 : DEVICE_POLL_INTERVAL_MS;
			for (;;) {
				const tokenRequest = await post<TokenEndpointResponse>("/login/oauth/access_token", {
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: device.device_code,
					client_id: deps.clientId,
				});
				const json = tokenRequest.json;
				if (tokenRequest.status >= 200 && tokenRequest.status < 300 && typeof json.access_token === "string" && typeof json.refresh_token === "string") {
					const now = Date.now();
					const expiresInMs = (typeof json.expires_in === "number" ? json.expires_in : 8 * 3600) * 1000;
					const token: ManagedTokenPair = { accessToken: json.access_token, refreshToken: json.refresh_token, obtainedMs: now, expiresMs: now + expiresInMs };
					await writeManagedToken(deps.stateDir, token);
					deps.onStatus(`token stored (gist scope, expires in ${Math.round(expiresInMs / 3_600_000)} h; the tool renews it while it lives)`);
					return { ok: true, token };
				}
				const error = typeof json.error === "string" ? json.error : undefined;
				switch (error) {
					case "authorization_pending":
						break; // keep polling on the same cadence
					case "slow_down":
						intervalMs += 5_000; // RFC 8628: raise the interval by 5 seconds
						break;
					case "expired_token":
						deps.onStatus("the code expired before it was entered");
						if (!(await deps.askRetry())) return { ok: false, cancelled: true };
						continue outer; // fresh code, never a silent retry
					case "denied":
						deps.onStatus("the code was denied on GitHub");
						if (!(await deps.askRetry())) return { ok: false, cancelled: true };
						continue outer;
					default:
						return { ok: false, error: `the GitHub device flow reported: ${error ?? `HTTP ${tokenRequest.status}`}` };
				}
				await pollIntervalSleep(intervalMs);
			}
		}
	} catch (err) {
		if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) return { ok: false, cancelled: true };
		return { ok: false, error: `device flow failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

class AbortError extends Error {
	constructor() {
		super("aborted");
		this.name = "AbortError";
	}
}
