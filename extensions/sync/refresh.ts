/**
 * Renewal of a managed (device-flow issued) token (ADR 0007, issue #38).
 *
 * The tool holds an 8-hour access token plus a rolling refresh token. It
 * refreshes proactively near expiry (needsProactiveRefresh), and the auth
 * session calls refreshAccessToken again after a mid-operation 401/403.
 * Every successful refresh rewrites the managed token file with the new
 * pair, so the renewal survives a restart. A refresh the server rejects
 * means the refresh token is dead: the device flow must run again.
 *
 * A hand-written token (plain file or environment) never enters this module:
 * the tool does not manage a token it did not create.
 */
import { createFetchOAuthTransport, type OAuthTransport } from "./deviceflow.ts";
import { writeManagedToken, type ManagedTokenPair } from "./token.ts";

/** Refresh this far before the access token actually expires. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface RefreshDeps {
	stateDir: string;
	baseUrl?: string;
	clientId: string;
	refreshToken: string;
	transport?: OAuthTransport;
}

export type RefreshResult =
	| { ok: true; token: ManagedTokenPair }
	| { ok: false; error: string; refreshDead: boolean };

/** True when the access token is expired or inside the refresh window. */
export function needsProactiveRefresh(managed: { expiresMs: number }, now: number = Date.now()): boolean {
	return managed.expiresMs - REFRESH_SKEW_MS <= now;
}

/** Refresh the access token with the rolling refresh token; persist the pair. */
export async function refreshAccessToken(deps: RefreshDeps): Promise<RefreshResult> {
	const baseUrl = (deps.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
	const transport = deps.transport ?? createFetchOAuthTransport();
	let response: { status: number; text: string };
	try {
		response = await transport.request("POST", `${baseUrl}/login/oauth/access_token`, {
			headers: { Accept: "application/json", "User-Agent": "pi-sync", "Content-Type": "application/json" },
			body: JSON.stringify({ grant_type: "refresh_token", client_id: deps.clientId, refresh_token: deps.refreshToken }),
		});
	} catch (err) {
		return { ok: false, error: `could not reach GitHub to refresh the token: ${err instanceof Error ? err.message : String(err)}`, refreshDead: false };
	}
	let json: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } = {};
	try {
		json = JSON.parse(response.text);
	} catch {
		// Non-JSON body: treat as a rejected refresh below.
	}
	if (response.status >= 200 && response.status < 300 && typeof json.access_token === "string") {
		const now = Date.now();
		const expiresInMs = (typeof json.expires_in === "number" ? json.expires_in : 8 * 3600) * 1000;
		// GitHub rolls the refresh token on every use; keep the old one when
		// a response omits it, so the pair never loses its only renewable half.
		const token: ManagedTokenPair = {
			accessToken: json.access_token,
			refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : deps.refreshToken,
			obtainedMs: now,
			expiresMs: now + expiresInMs,
		};
		try {
			await writeManagedToken(deps.stateDir, token);
		} catch (err) {
			// The refresh token was already rotated by this call, so the stored
			// pair is dead even though the write failed: report it as dead.
			return {
				ok: false,
				error: `the refresh succeeded but the new token pair could not be written to the token file: ${err instanceof Error ? err.message : String(err)}`,
				refreshDead: true,
			};
		}
		return { ok: true, token };
	}
	return {
		ok: false,
		error: `GitHub rejected the refresh token (HTTP ${response.status}). The token the tool issued has died and must be re-issued through the device flow.`,
		refreshDead: true,
	};
}
