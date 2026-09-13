import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountIdFromToken,
	createQuotaSource,
	parseUsageResponse,
	type QuotaSourceOptions,
} from "../../extensions/quota/source";

const NOW = 1_700_000_000_000;
const FIVE_H = 5 * 3600 * 1000;
const SEVEN_D = 7 * 24 * 3600 * 1000;
const THIRTY_D = 30 * 24 * 3600 * 1000;

function windowObj(labelMs: number, usedPercent: number) {
	return {
		used_percent: usedPercent,
		limit_window_seconds: Math.round(labelMs / 1000),
		reset_after_seconds: Math.round((NOW + labelMs - NOW) / 1000),
		reset_at: Math.floor((NOW + labelMs) / 1000),
	};
}

function usageBody(primary: unknown, secondary: unknown = null): unknown {
	return {
		email: "a@b.c",
		plan_type: "plus",
		rate_limit: { primary_window: primary, secondary_window: secondary },
	};
}

let root: string;
let authPath: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "quota-source-"));
	authPath = join(root, "auth.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// parseUsageResponse
// ---------------------------------------------------------------------------

describe("parseUsageResponse", () => {
	it("labels the 5-hour and weekly windows by length", () => {
		const snapshot = parseUsageResponse(
			usageBody({ ...windowObj(FIVE_H, 100), reset_at: Math.floor((NOW + FIVE_H) / 1000) }, windowObj(SEVEN_D, 40)),
			NOW,
		);
		expect(snapshot?.windows.map((w) => w.label)).toEqual(["5h", "7d"]);
		expect(snapshot?.windows[0]).toMatchObject({ usedPercent: 100, resetsAtMs: NOW + FIVE_H });
	});

	it("labels a 30-day window by its length (free plan shape)", () => {
		const snapshot = parseUsageResponse(
			usageBody(windowObj(THIRTY_D, 100), null),
			NOW,
		);
		expect(snapshot?.windows.map((w) => w.label)).toEqual(["30d"]);
	});

	it("keeps used_percent as a percentage, values above 100 included", () => {
		const snapshot = parseUsageResponse(usageBody({ ...windowObj(FIVE_H, 120) }), NOW);
		expect(snapshot?.windows[0].usedPercent).toBe(120);
	});

	it("accepts a null secondary window", () => {
		const snapshot = parseUsageResponse(usageBody(windowObj(FIVE_H, 10), null), NOW);
		expect(snapshot?.windows).toHaveLength(1);
	});

	it("accepts milliseconds for reset_at", () => {
		const snapshot = parseUsageResponse(usageBody({ ...windowObj(FIVE_H, 10), reset_at: NOW + FIVE_H }), NOW);
		expect(snapshot?.windows[0].resetsAtMs).toBe(NOW + FIVE_H);
	});

	it("carries plan type and account email", () => {
		const snapshot = parseUsageResponse(usageBody(windowObj(FIVE_H, 1)), NOW);
		expect(snapshot?.planType).toBe("plus");
		expect(snapshot?.accountEmail).toBe("a@b.c");
	});

	it("returns undefined on shape drift", () => {
		expect(parseUsageResponse(null, NOW)).toBeUndefined();
		expect(parseUsageResponse({ rate_limit: {} }, NOW)).toBeUndefined();
		expect(parseUsageResponse(usageBody(null), NOW)).toBeUndefined();
		expect(parseUsageResponse(usageBody({ limit_window_seconds: 18000 }), NOW)).toBeUndefined(); // no reset
		expect(parseUsageResponse(usageBody({ reset_at: NOW }), NOW)).toBeUndefined(); // no usage
	});
});

// ---------------------------------------------------------------------------
// accountIdFromToken
// ---------------------------------------------------------------------------

describe("accountIdFromToken", () => {
	it("reads the chatgpt account id claim from a JWT", () => {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
		).toString("base64url");
		const token = `header.${payload}.sig`;
		expect(accountIdFromToken(token)).toBe("acct_123");
	});

	it("returns undefined for a malformed token", () => {
		expect(accountIdFromToken("not-a-jwt")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// createQuotaSource().read() with an injected fetch
// ---------------------------------------------------------------------------

interface FakeFetch {
	impl: typeof fetch;
	calls: { url: string; init?: RequestInit }[];
}

function makeFetch(behavior: (url: string, callIndexForUrl: number) => Response): FakeFetch {
	const counts: Record<string, number> = {};
	const calls: FakeFetch["calls"] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const n = counts[url] ?? 0;
		counts[url] = n + 1;
		calls.push({ url, init });
		return behavior(url, n);
	}) as typeof fetch;
	return { impl, calls };
}

function tokenResponse(access = "new-access", refresh = "new-refresh", expiresIn = 3600): Response {
	return new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: expiresIn }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function usageResponse(primary: unknown, secondary: unknown = null): Response {
	return new Response(JSON.stringify(usageBody(primary, secondary)), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const WINDOWS = {
	primary: windowObj(FIVE_H, 100),
	secondary: windowObj(SEVEN_D, 40),
};

function writeAuth(entry: unknown): void {
	writeFileSync(authPath, JSON.stringify({ "openai-codex": entry }));
}

function makeSource(fetch: FakeFetch["impl"]): { read: () => ReturnType<ReturnType<typeof createQuotaSource>["read"]> } {
	const options: QuotaSourceOptions = { fetchImpl: fetch, now: () => NOW, authPath, tokenUrl: "TOKEN", usageUrl: "USAGE" };
	const source = createQuotaSource(options);
	return { read: source.read };
}

describe("createQuotaSource().read()", () => {
	it("reports no-login when the auth store has no codex entry", async () => {
		const fake = makeFetch(() => new Response("{}", { status: 200 }));
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "no-login" });
		expect(fake.calls).toHaveLength(0);
	});

	it("reads usage with a fresh token and no refresh", async () => {
		writeAuth({ type: "oauth", access: "fresh", refresh: "r", expires: NOW + 100_000 });
		const fake = makeFetch((url) =>
			url === "USAGE" ? usageResponse(WINDOWS.primary, WINDOWS.secondary) : new Response("{}", { status: 200 }),
		);
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.snapshot.windows.map((w) => w.label)).toEqual(["5h", "7d"]);
		// Only the usage call; no token refresh.
		expect(fake.calls.map((c) => c.url)).toEqual(["USAGE"]);
		expect(fake.calls[0].init?.headers).toMatchObject({ Authorization: "Bearer fresh" });
	});

	it("refreshes an expired token before reading", async () => {
		writeAuth({ type: "oauth", access: "old", refresh: "r1", expires: NOW - 1_000 });
		const fake = makeFetch((url) =>
			url === "TOKEN" ? tokenResponse() : usageResponse(WINDOWS.primary, WINDOWS.secondary),
		);
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result.ok).toBe(true);
		expect(fake.calls.map((c) => c.url)).toEqual(["TOKEN", "USAGE"]);
		// The refreshed access token is persisted.
		const stored = JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"];
		expect(stored.access).toBe("new-access");
		expect(stored.refresh).toBe("new-refresh");
		// And the usage call used it.
		expect(fake.calls[1].init?.headers).toMatchObject({ Authorization: "Bearer new-access" });
	});

	it("retries once after a 401, re-reading the rotated credential", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch((url, n) => {
			if (url === "TOKEN") return tokenResponse();
			return n === 0 ? new Response("unauthorized", { status: 401 }) : usageResponse(WINDOWS.primary, WINDOWS.secondary);
		});
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result.ok).toBe(true);
		expect(fake.calls.map((c) => c.url)).toEqual(["USAGE", "TOKEN", "USAGE"]);
	});

	it("reports login-dead when the endpoint still rejects after a refresh", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch((url) =>
			url === "TOKEN" ? tokenResponse() : new Response("unauthorized", { status: 401 }),
		);
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "login-dead" });
	});

	it("reports network on a transport failure", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch(() => {
			throw new Error("boom");
		});
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "network" });
		expect(result.ok === false && /boom/.test(result.message)).toBe(true);
	});

	it("reports parse when the usage shape is wrong", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch(() => usageResponse(null));
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "parse" });
	});

	it("reports network on a non-200, non-401 status", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch(() => new Response("teapot", { status: 418 }));
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "network" });
	});
});

describe("auth file presence", () => {
	it("treats a missing auth file as no-login", async () => {
		expect(existsSync(authPath)).toBe(false);
		const fake = makeFetch(() => new Response("{}", { status: 200 }));
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result).toMatchObject({ ok: false, reason: "no-login" });
	});
});
