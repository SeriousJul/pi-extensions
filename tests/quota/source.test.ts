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
	it("labels the 5-hour window by length, not position", () => {
		const snapshot = parseUsageResponse(
			{
				windows: [
					{ resets_at_ms: NOW + SEVEN_D, window_ms: SEVEN_D, used_percent: 40 },
					{ resets_at_ms: NOW + FIVE_H, window_ms: FIVE_H, used_percent: 100 },
				],
			},
			NOW,
		);
		expect(snapshot?.windows.map((w) => w.label)).toEqual(["7d", "5h"]);
	});

	it("accepts seconds for epoch and window fields", () => {
		const snapshot = parseUsageResponse(
			{
				windows: [
					{ resets_at: Math.floor((NOW + FIVE_H) / 1000), window_seconds: 5 * 3600, used: 1 },
				],
			},
			NOW,
		);
		expect(snapshot?.windows[0]).toMatchObject({ label: "5h", usedPercent: 100, resetsAtMs: NOW + FIVE_H });
	});

	it("treats a 0-1 `used` fraction as a percentage", () => {
		const snapshot = parseUsageResponse({ windows: [{ resets_at_ms: NOW + FIVE_H, window_ms: FIVE_H, used: 0.25 }] }, NOW);
		expect(snapshot?.windows[0].usedPercent).toBe(25);
	});

	it("keeps a >1 `used` value as a percentage", () => {
		const snapshot = parseUsageResponse({ windows: [{ resets_at_ms: NOW + FIVE_H, window_ms: FIVE_H, used: 120 }] }, NOW);
		expect(snapshot?.windows[0].usedPercent).toBe(120);
	});

	it("derives the window length from start and reset when absent", () => {
		const snapshot = parseUsageResponse(
			{ windows: [{ resets_at_ms: NOW + FIVE_H, window_start: Math.floor(NOW / 1000), used_percent: 10 }] },
			NOW,
		);
		expect(snapshot?.windows[0].label).toBe("5h");
	});

	it("carries plan type and account email", () => {
		const snapshot = parseUsageResponse(
			{ primary_plan: "plus", email: "a@b.c", windows: [{ resets_at_ms: NOW, window_ms: FIVE_H, used_percent: 1 }] },
			NOW,
		);
		expect(snapshot?.planType).toBe("plus");
		expect(snapshot?.accountEmail).toBe("a@b.c");
	});

	it("returns undefined on shape drift", () => {
		expect(parseUsageResponse(null, NOW)).toBeUndefined();
		expect(parseUsageResponse({ windows: [] }, NOW)).toBeUndefined();
		expect(parseUsageResponse({ windows: [{ used_percent: 5 }] }, NOW)).toBeUndefined(); // no reset
		expect(parseUsageResponse({ windows: [{ resets_at_ms: NOW }] }, NOW)).toBeUndefined(); // no usage
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

function usageResponse(windows: unknown, plan = "plus"): Response {
	return new Response(JSON.stringify({ primary_plan: plan, windows }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const WINDOWS = [
	{ resets_at_ms: NOW + FIVE_H, window_ms: FIVE_H, used_percent: 100 },
	{ resets_at_ms: NOW + SEVEN_D, window_ms: SEVEN_D, used_percent: 40 },
];

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
		const fake = makeFetch((url) => (url === "USAGE" ? usageResponse(WINDOWS) : new Response("{}", { status: 200 })));
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
		const fake = makeFetch((url) => (url === "TOKEN" ? tokenResponse() : usageResponse(WINDOWS)));
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
			return n === 0 ? new Response("unauthorized", { status: 401 }) : usageResponse(WINDOWS);
		});
		const { read } = makeSource(fake.impl);
		const result = await read();
		expect(result.ok).toBe(true);
		expect(fake.calls.map((c) => c.url)).toEqual(["USAGE", "TOKEN", "USAGE"]);
	});

	it("reports login-dead when the endpoint still rejects after a refresh", async () => {
		writeAuth({ type: "oauth", access: "a1", refresh: "r1", expires: NOW + 100_000 });
		const fake = makeFetch((url) => (url === "TOKEN" ? tokenResponse() : new Response("unauthorized", { status: 401 })));
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
		const fake = makeFetch(() => usageResponse([]));
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
