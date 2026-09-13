/**
 * Quota source module: the one module that owns all data logic for reading
 * the OpenAI ChatGPT plan's quota windows (issue #28 design, ADR 0005).
 *
 * It is a library module loaded by two extensions, each with its own
 * entry point: the Quota extension's UI (index.ts: footer, /quota, polling)
 * and the Model router, which reuses it for every usage read and token
 * refresh. Neither duplicates endpoint parsing or OAuth plumbing.
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

/** Window lengths, for the label. The 5-hour window is identified by
 * length, not by position. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** reset_at answers in seconds on the live endpoint; accept ms too. */
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
 * shape drift; the caller reports a supported "parse" failure, not a crash.
 * Live shape: plan_type and email at the top level, and the windows as
 * rate_limit.primary_window and rate_limit.secondary_window, each
 * { used_percent, limit_window_seconds, reset_after_seconds, reset_at } or
 * null. A window's label comes from its length (5h and 7d are recognized;
 * anything else is stated by its length, for example 30d on the free plan),
 * never from its position.
 */
export function parseUsageResponse(raw: unknown, fetchedAtMs: number): UsageSnapshot | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const rateLimit =
		typeof obj.rate_limit === "object" && obj.rate_limit !== null ? (obj.rate_limit as Record<string, unknown>) : {};
	const windows: QuotaWindow[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const window = parseQuotaWindow(rateLimit[key]);
		if (window) windows.push(window);
	}
	if (windows.length === 0) return undefined;
	return {
		planType: pickString(obj.plan_type),
		accountEmail: pickString(obj.email),
		windows,
		fetchedAtMs,
	};
}

function parseQuotaWindow(raw: unknown): QuotaWindow | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const resetsAtMs = pickEpochMs(obj.reset_at);
	const windowLengthMs =
		typeof obj.limit_window_seconds === "number" && Number.isFinite(obj.limit_window_seconds)
			? obj.limit_window_seconds * 1000
			: undefined;
	const usedPercent = typeof obj.used_percent === "number" && Number.isFinite(obj.used_percent) ? obj.used_percent : undefined;
	if (resetsAtMs === undefined || usedPercent === undefined) return undefined;
	return { label: labelForLength(windowLengthMs), usedPercent, resetsAtMs, windowLengthMs: windowLengthMs ?? 0 };
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

/** "5h" and "7d" for the standard windows, the length stated otherwise. */
function labelForLength(ms: number | undefined): string {
	if (ms === undefined) return "?";
	if (Math.abs(ms - FIVE_HOUR_MS) / FIVE_HOUR_MS <= 0.1) return "5h";
	if (Math.abs(ms - WEEK_MS) / WEEK_MS <= 0.1) return "7d";
	const days = ms / 86_400_000;
	const hours = ms / 3_600_000;
	if (days >= 1 && Math.abs(days - Math.round(days)) <= 0.02) return `${Math.round(days)}d`;
	if (hours >= 1) return `${Math.round(hours)}h`;
	return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
