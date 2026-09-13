/**
 * Quota source module: the one module that owns all data logic for reading
 * the OpenAI ChatGPT plan's quota windows (issue #28 design, ADR 0005).
 *
 * It is a library module, not an extension: there is no index.ts, so pi's
 * loader never runs it as an extension. The Quota extension's UI (footer,
 * /quota, polling) will sit on top of it, and the Model router (#29) already
 * reuses it for every usage read and token refresh, so neither duplicates
 * endpoint parsing or OAuth plumbing.
 *
 * Credentials come from pi's own auth store (~/.pi/agent/auth.json, or
 * $PI_CODING_AGENT_DIR/auth.json). When the access token is expired, or a
 * usage fetch answers 401, the module refreshes through the same token
 * endpoint and client id pi's bundled OAuth uses, writes the rotated token
 * pair back with a read-modify-write, and retries once after re-reading.
 * A failed refresh declares the login dead; the user is told to log in
 * again. Response shape drift is a supported failure (the "parse" reason),
 * not a crash.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One rolling usage budget reported by the plan. */
export interface QuotaWindow {
	/** "5h" for the 5-hour window (identified by window length), "7d" for the weekly one. */
	label: string;
	/** Used fraction of the window as a percentage, 0-100. */
	usedPercent: number;
	/** Epoch milliseconds when the window resets. */
	resetsAtMs: number;
	/** Rolling window length in milliseconds. */
	windowLengthMs: number;
}

/** The latest successful read of a plan's quota windows. */
export interface UsageSnapshot {
	/** Plan type as reported by the endpoint, e.g. "plus" or "pro". */
	planType?: string;
	/** Account email as reported by the endpoint. */
	accountEmail?: string;
	windows: QuotaWindow[];
	/** Epoch milliseconds when the read was fetched. */
	fetchedAtMs: number;
}

/** Outcome of one quota read. `ok: false` never throws; callers decide display. */
export type QuotaRead =
	| { ok: true; snapshot: UsageSnapshot }
	| {
			ok: false;
			reason:
				| "no-login" // no usable openai-codex OAuth entry in the auth store
				| "login-dead" // token refresh failed; the user must log in again
				| "network" // the usage endpoint is unreachable
				| "parse"; // the endpoint answered, but the shape is not the expected one
			message: string;
		};

/** The pi provider id whose requests draw on the ChatGPT subscription. */
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** The client id pi's bundled OpenAI Codex OAuth uses for token exchange. */
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** The 5-hour window is identified by length, not by position. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const FIVE_HOUR_TOLERANCE_MS = 15 * 60 * 1000;
/** Endpoints that answer in seconds (resets_at, window_seconds). */
const SECONDS_CUTOFF = 1e12;
const FETCH_TIMEOUT_MS = 15_000;

/** The shape of the openai-codex entry in pi's auth.json. */
interface OAuthCredentialLike {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
}

export interface QuotaSourceOptions {
	/** Path to pi's auth store. Default: $PI_CODING_AGENT_DIR/auth.json or ~/.pi/agent/auth.json. */
	authPath?: string;
	/** fetch implementation. Default: globalThis.fetch. Injectable for tests. */
	fetchImpl?: typeof fetch;
	/** Clock in milliseconds. Injectable for tests. */
	now?: () => number;
	tokenUrl?: string;
	usageUrl?: string;
	clientId?: string;
	env?: NodeJS.ProcessEnv;
}

export interface QuotaSource {
	/** The pi provider id whose requests draw on this plan's quota. */
	readonly providerId: string;
	/** Read the plan's quota windows once. Never throws. */
	read(): Promise<QuotaRead>;
}

/**
 * Build the OpenAI ChatGPT plan quota source. All network and file access is
 * injectable, so the module is fully testable without a login.
 */
export function createQuotaSource(options: QuotaSourceOptions = {}): QuotaSource {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const now = options.now ?? Date.now;
	const tokenUrl = options.tokenUrl ?? OPENAI_TOKEN_URL;
	const usageUrl = options.usageUrl ?? OPENAI_USAGE_URL;
	const clientId = options.clientId ?? OPENAI_CLIENT_ID;
	const authPath = options.authPath ?? defaultAuthPath(options.env ?? process.env);

	return {
		providerId: OPENAI_CODEX_PROVIDER,
		read: () => readUsage({ fetchImpl, now, tokenUrl, usageUrl, clientId, authPath }),
	};
}

export function defaultAuthPath(env: NodeJS.ProcessEnv): string {
	return env.PI_CODING_AGENT_DIR
		? join(env.PI_CODING_AGENT_DIR, "auth.json")
		: join(homedir(), ".pi", "agent", "auth.json");
}

interface ReadContext {
	fetchImpl: typeof fetch;
	now: () => number;
	tokenUrl: string;
	usageUrl: string;
	clientId: string;
	authPath: string;
}

async function readUsage(ctx: ReadContext): Promise<QuotaRead> {
	let credential = readCredential(ctx.authPath);
	if (!credential) {
		return { ok: false, reason: "no-login", message: "no openai-codex login in pi's auth store; run /login" };
	}

	let refreshed = false;
	if (credential.expires <= ctx.now()) {
		const refresh = await refreshCredential(credential, ctx);
		if (!refresh.ok) return { ok: false, reason: "login-dead", message: refresh.message };
		credential = refresh.credential;
		refreshed = true;
	}

	let response = await fetchUsage(credential, ctx);
	// One retry after a re-read: pi may have rotated the same refresh token in
	// between, and the re-read picks that up (ADR 0005).
	if (response.status === 401 && !refreshed) {
		const refresh = await refreshCredential(credential, ctx);
		if (!refresh.ok) return { ok: false, reason: "login-dead", message: refresh.message };
		credential = { ...refresh.credential, ...reReadCredential(ctx.authPath) };
		response = await fetchUsage(credential, ctx);
	}
	if (response.status === 401) {
		return { ok: false, reason: "login-dead", message: "the usage endpoint rejected the refreshed token; log in again" };
	}
	if (response.status === 0) {
		return { ok: false, reason: "network", message: `could not reach the usage endpoint: ${response.message}` };
	}
	if (response.status !== 200) {
		return { ok: false, reason: "network", message: `the usage endpoint answered ${response.status}` };
	}
	const snapshot = parseUsageResponse(response.body, ctx.now());
	if (!snapshot) {
		return { ok: false, reason: "parse", message: "the usage endpoint answered, but its shape is not the expected one" };
	}
	return { ok: true, snapshot };
}

// ---------------------------------------------------------------------------
// Auth store
// ---------------------------------------------------------------------------

function readCredential(authPath: string): OAuthCredentialLike | undefined {
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		const entry = data?.[OPENAI_CODEX_PROVIDER];
		if (
			typeof entry === "object" &&
			entry !== null &&
			(entry as OAuthCredentialLike).type === "oauth" &&
			typeof (entry as OAuthCredentialLike).access === "string" &&
			typeof (entry as OAuthCredentialLike).refresh === "string" &&
			typeof (entry as OAuthCredentialLike).expires === "number"
		) {
			return entry as OAuthCredentialLike;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function reReadCredential(authPath: string): Partial<OAuthCredentialLike> | undefined {
	return readCredential(authPath);
}

function writeCredential(authPath: string, credential: OAuthCredentialLike): void {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		if (typeof data !== "object" || data === null) data = {};
	} catch {
		data = {};
	}
	data[OPENAI_CODEX_PROVIDER] = credential;
	mkdirSync(dirname(authPath), { recursive: true });
	writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshCredential(
	credential: OAuthCredentialLike,
	ctx: ReadContext,
): Promise<{ ok: true; credential: OAuthCredentialLike } | { ok: false; message: string }> {
	try {
		const response = await ctx.fetchImpl(ctx.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: credential.refresh,
				client_id: ctx.clientId,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return { ok: false, message: `token refresh failed (${response.status}): ${text.slice(0, 200) || response.statusText}` };
		}
		const body = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string" || typeof body.expires_in !== "number") {
			return { ok: false, message: "the token endpoint answered without the expected token fields" };
		}
		const next: OAuthCredentialLike = {
			type: "oauth",
			access: body.access_token,
			refresh: body.refresh_token,
			expires: ctx.now() + body.expires_in * 1000,
			accountId: accountIdFromToken(body.access_token) ?? credential.accountId,
		};
		writeCredential(ctx.authPath, next);
		return { ok: true, credential: next };
	} catch (error) {
		return { ok: false, message: `token refresh failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** The account id pi's bundled OAuth reads out of the access token JWT. */
export function accountIdFromToken(accessToken: string): string | undefined {
	try {
		const payload = JSON.parse(atob(accessToken.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "")) as Record<
			string,
			unknown
		>;
		const claims = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
		const accountId = claims?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Usage fetch and parse
// ---------------------------------------------------------------------------

interface UsageResponse {
	/** 0 means the fetch threw (network-level failure). */
	status: number;
	message?: string;
	body?: unknown;
}

async function fetchUsage(credential: OAuthCredentialLike, ctx: ReadContext): Promise<UsageResponse> {
	try {
		const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}` };
		if (credential.accountId) headers["chatgpt-account-id"] = credential.accountId;
		const response = await ctx.fetchImpl(ctx.usageUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!response.ok && response.status !== 401) {
			await response.body?.cancel?.().catch(() => undefined);
			return { status: response.status };
		}
		return { status: response.status, body: await response.json().catch(() => undefined) };
	} catch (error) {
		return { status: 0, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Parse the usage endpoint's answer into a snapshot. Returns undefined on
 * shape drift; the caller reports a supported "parse" failure. The 5-hour
 * window is identified by its length (5 hours, with tolerance), never by
 * position in the array.
 */
export function parseUsageResponse(raw: unknown, fetchedAtMs: number): UsageSnapshot | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
	const windows: QuotaWindow[] = [];
	for (const entry of rawWindows) {
		const window = parseQuotaWindow(entry);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;
	const account = typeof obj.account === "object" && obj.account !== null ? (obj.account as Record<string, unknown>) : undefined;
	return {
		planType: pickString(obj.primary_plan ?? obj.plan_type ?? obj.plan),
		accountEmail: pickString(obj.email ?? account?.email),
		windows,
		fetchedAtMs,
	};
}

function parseQuotaWindow(raw: unknown): QuotaWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const resetsAtMs = pickEpochMs(obj.resets_at_ms ?? obj.resets_at ?? obj.reset_time);
	// window_ms / window_seconds are durations, not epochs: use them directly,
	// no seconds heuristic. window_start is an epoch, so it is converted.
	const windowLengthMs =
		(typeof obj.window_ms === "number" && Number.isFinite(obj.window_ms)
			? obj.window_ms
			: undefined) ??
		(typeof obj.window_seconds === "number" && Number.isFinite(obj.window_seconds)
			? obj.window_seconds * 1000
			: undefined) ??
		(typeof obj.window_start === "number" && resetsAtMs !== undefined ? resetsAtMs - toEpochMs(obj.window_start) : undefined);
	const usedPercent = pickUsedPercent(obj);
	if (resetsAtMs === undefined || usedPercent === undefined) return undefined;
	const label =
		windowLengthMs !== undefined && Math.abs(windowLengthMs - FIVE_HOUR_MS) <= FIVE_HOUR_TOLERANCE_MS ? "5h" : "7d";
	return { label, usedPercent, resetsAtMs, windowLengthMs: windowLengthMs ?? 0 };
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Accept both seconds and milliseconds for epoch values. */
function pickEpochMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? toEpochMs(value) : undefined;
}

function toEpochMs(value: number): number {
	return value < SECONDS_CUTOFF ? value * 1000 : value;
}

/**
 * Accept the endpoint's used-ratio under its known field names. `used_percent`
 * and `percent` are already percentages; `used` is a 0-1 fraction when at or
 * below 1 and a percentage above that.
 */
function pickUsedPercent(obj: Record<string, unknown>): number | undefined {
	const percent = obj.used_percent ?? obj.percent;
	if (typeof percent === "number" && Number.isFinite(percent)) return percent;
	const fraction = obj.used_fraction ?? obj.used;
	if (typeof fraction === "number" && Number.isFinite(fraction)) return fraction <= 1 ? fraction * 100 : fraction;
	return undefined;
}
