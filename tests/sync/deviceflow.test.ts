/**
 * The token lifecycle (issues #37, #38): the device flow protocol, the
 * refresh of a managed token, and the auth session that bounds them.
 * A stub OAuth transport keeps every test off the network.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthSession, type DeviceFlowHooks } from "../../extensions/sync/auth.ts";
import { runDeviceFlow, type OAuthTransport } from "../../extensions/sync/deviceflow.ts";
import { needsProactiveRefresh, refreshAccessToken } from "../../extensions/sync/refresh.ts";
import { parseManagedToken, stateDirFor, tokenPathFor, writeManagedToken } from "../../extensions/sync/token.ts";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface StubCall {
	path: string;
	body: Record<string, string>;
}

/**
 * A stub of the two GitHub OAuth endpoints. `deviceResponses` and
 * `tokenResponses` are consumed in order; the last one repeats.
 */
function stubOAuth(options: {
	deviceResponses?: { status: number; json: unknown }[];
	tokenResponses: { status: number; json: unknown }[];
}): { transport: OAuthTransport; calls: StubCall[] } {
	const calls: StubCall[] = [];
	let tokenIndex = 0;
	let deviceIndex = 0;
	const transport: OAuthTransport = {
		async request(method, url, opts) {
			const body = JSON.parse(opts.body ?? "{}") as Record<string, string>;
			const path = new URL(url).pathname;
			calls.push({ path, body });
			if (path === "/login/device/code") {
				const canned = (options.deviceResponses ?? [{ status: 200, json: { device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0.01 } }])[
					Math.min(deviceIndex++, (options.deviceResponses?.length ?? 1) - 1)
				];
				return { status: canned.status, text: JSON.stringify(canned.json) };
			}
			const canned = options.tokenResponses[Math.min(tokenIndex++, options.tokenResponses.length - 1)];
			return { status: canned.status, text: JSON.stringify(canned.json) };
		},
	};
	return { transport, calls };
}

describe("runDeviceFlow (issue #37)", () => {
	it("shows the code, polls, and stores the managed token pair on success", async () => {
		const home = await tempDir("pi-sync-df-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({
			tokenResponses: [
				{ status: 200, json: { error: "authorization_pending" } },
				{ status: 200, json: { error: "slow_down" } },
				{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } },
			],
		});
		const status: string[] = [];
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: (line) => status.push(line),
			askRetry: async () => false,
		});
		expect(result.ok).toBe(true);
		expect(result.token?.accessToken).toBe("at");
		expect(calls[0].body).toEqual({ client_id: "client-1", scope: "gist" });
		expect(calls[1].body).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dc", client_id: "client-1" });
		expect(status[0]).toContain("ABCD-1234");
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("at");
		expect(stored?.refreshToken).toBe("rt");
	});

	it("offers a fresh code on expired_token and re-runs from the top", async () => {
		const home = await tempDir("pi-sync-df-exp-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({
			deviceResponses: [
				{ status: 200, json: { device_code: "dc1", user_code: "AAAA-1111", expires_in: 900, interval: 0.01 } },
				{ status: 200, json: { device_code: "dc2", user_code: "BBBB-2222", expires_in: 900, interval: 0.01 } },
			],
			tokenResponses: [
				{ status: 400, json: { error: "expired_token" } },
				{ status: 200, json: { access_token: "at2", refresh_token: "rt2", expires_in: 28800 } },
			],
		});
		const retries: number[] = [];
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: () => undefined,
			askRetry: async () => {
				retries.push(1);
				return true;
			},
		});
		expect(result.ok).toBe(true);
		expect(result.token?.accessToken).toBe("at2");
		expect(retries).toHaveLength(1);
		const codes = calls.filter((c) => c.path === "/login/device/code");
		expect(codes).toHaveLength(2); // a fresh code, never a silent retry
	});

	it("cancels when the user declines the retry after a denial", async () => {
		const home = await tempDir("pi-sync-df-denied-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "denied" } }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});

	it("reports an unknown flow error cleanly", async () => {
		const home = await tempDir("pi-sync-df-err-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "client_id_not_found" } }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "bad",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("client_id_not_found");
	});

	it("fails cleanly when the code request is rejected", async () => {
		const home = await tempDir("pi-sync-df-nocode-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ deviceResponses: [{ status: 401, json: { message: "Bad credentials" } }], tokenResponses: [{ status: 200, json: {} }] });
		const result = await runDeviceFlow({
			stateDir,
			clientId: "bad",
			transport,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBeUndefined();
		expect(result.error).toContain("could not start the device flow");
	});

	it("aborts cleanly", async () => {
		const home = await tempDir("pi-sync-df-abort-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { error: "authorization_pending" } }] });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		const result = await runDeviceFlow({
			stateDir,
			clientId: "client-1",
			transport,
			signal: controller.signal,
			onStatus: () => undefined,
			askRetry: async () => false,
		});
		expect(result.ok).toBe(false);
		expect(result.cancelled).toBe(true);
	});
});

describe("refresh of a managed token (issue #38)", () => {
	it("refreshes with the rolling refresh token and persists the new pair", async () => {
		const home = await tempDir("pi-sync-refresh-");
		const stateDir = stateDirFor(home, {});
		const { transport, calls } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at2", refresh_token: "rt2", expires_in: 28800 } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt", transport });
		expect(result.ok).toBe(true);
		expect(calls[0].body).toEqual({ grant_type: "refresh_token", client_id: "client-1", refresh_token: "rt" });
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("at2");
		expect(stored?.refreshToken).toBe("rt2");
	});

	it("keeps the old refresh token when the response omits it", async () => {
		const home = await tempDir("pi-sync-refresh-noroll-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at2", expires_in: 28800 } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt-kept", transport });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.token.refreshToken).toBe("rt-kept");
	});

	it("a rejected refresh means the refresh token is dead", async () => {
		const home = await tempDir("pi-sync-refresh-dead-");
		const stateDir = stateDirFor(home, {});
		const { transport } = stubOAuth({ tokenResponses: [{ status: 400, json: { error: "bad_verification_code" } }] });
		const result = await refreshAccessToken({ stateDir, clientId: "client-1", refreshToken: "rt", transport });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.refreshDead).toBe(true);
	});

	it("needsProactiveRefresh triggers inside the skew window", () => {
		const now = Date.now();
		expect(needsProactiveRefresh({ expiresMs: now + 30_000 }, now)).toBe(true); // 5-minute skew
		expect(needsProactiveRefresh({ expiresMs: now + 10 * 60_000 }, now)).toBe(false);
		expect(needsProactiveRefresh({ expiresMs: now - 1_000 }, now)).toBe(true);
	});
});

describe("the auth session (issue #38)", () => {
	const hooks: DeviceFlowHooks = { onStatus: () => undefined, askRetry: async () => false };

	it("uses a hand-written token as-is and never manages it on 401", async () => {
		const home = await tempDir("pi-sync-auth-plain-");
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_TOKEN: "hand-written" } });
		expect(built.session?.token).toBe("hand-written");
		expect(built.session?.source).toBe("env");
		expect(await built.session?.renew()).toBeUndefined(); // hand-written: never refreshed
	});

	it("reports the fix instead of starting a flow when no token exists in a non-interactive context", async () => {
		const home = await tempDir("pi-sync-auth-none-");
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home } });
		expect(built.session).toBeUndefined();
		expect(built.error).toContain("PI_SYNC_TOKEN");
	});

	it("names the setup step when a tty run has no OAuth client id", async () => {
		const home = await tempDir("pi-sync-auth-noclient-");
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home },
			deviceFlow: { hooks, run: async () => ({ ok: false, error: "should not run" }) },
		});
		expect(built.session).toBeUndefined();
		expect(built.error).toContain("setup-sync-wizard.sh");
	});

	it("starts the device flow on a fresh interactive device and stores the token", async () => {
		const home = await tempDir("pi-sync-auth-flow-");
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "at", refresh_token: "rt", expires_in: 28800 } }] });
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			deviceFlow: { hooks, run: (h) => runDeviceFlow({ stateDir: stateDirFor(home, { PI_SYNC_HOME: home }), clientId: "client-1", transport, onStatus: h.onStatus, askRetry: h.askRetry }) },
		});
		expect(built.session?.token).toBe("at");
		expect(built.session?.source).toBe("managed-file");
	});

	it("proactively refreshes a managed token inside the skew window", async () => {
		const home = await tempDir("pi-sync-auth-proactive-");
		const stateDir = stateDirFor(home, {});
		const soon = Date.now() + 60_000; // inside the 5-minute skew
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt", obtainedMs: soon - 28_740_000, expiresMs: soon });
		const { transport } = stubOAuth({ tokenResponses: [{ status: 200, json: { access_token: "new", refresh_token: "rt2", expires_in: 28800 } }] });
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" }, oauthTransport: transport });
		expect(built.session?.token).toBe("new");
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("new");
	});

	it("renew() after a 401 refreshes once and persists; a second renew() is a no-op", async () => {
		const home = await tempDir("pi-sync-auth-renew-");
		const stateDir = stateDirFor(home, {});
		const far = Date.now() + 6 * 3_600_000; // outside the skew: no proactive refresh
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt", obtainedMs: far - 28_800_000, expiresMs: far });
		let refreshCalls = 0;
		const transport: OAuthTransport = {
			async request(_method, _url, opts) {
				refreshCalls++;
				expect(JSON.parse(opts.body ?? "{}").refresh_token).toBe("rt");
				return { status: 200, text: JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 28800 }) };
			},
		};
		const built = await createAuthSession({ env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" }, oauthTransport: transport });
		expect(built.session?.token).toBe("old");
		const first = await built.session?.renew();
		expect(first).toBe("new");
		const second = await built.session?.renew();
		expect(second).toBeUndefined(); // the session bound: at most one renewal
		expect(refreshCalls).toBe(1);
		const stored = parseManagedToken((await readFile(tokenPathFor(stateDir), "utf8")).trim());
		expect(stored?.accessToken).toBe("new");
	});

	it("renew() falls through to the device flow when the refresh token is dead", async () => {
		const home = await tempDir("pi-sync-auth-renew-flow-");
		const stateDir = stateDirFor(home, {});
		const far = Date.now() + 6 * 3_600_000;
		await writeManagedToken(stateDir, { accessToken: "old", refreshToken: "rt-dead", obtainedMs: far - 28_800_000, expiresMs: far });
		// First token-endpoint call is the refresh (rejected: dead); the
		// second is the device-flow poll (granted a fresh pair).
		const { transport } = stubOAuth({
			tokenResponses: [
				{ status: 400, json: { error: "bad_verification_code" } },
				{ status: 200, json: { access_token: "flow-at", refresh_token: "flow-rt", expires_in: 28800 } },
			],
		});
		const built = await createAuthSession({
			env: { PI_SYNC_HOME: home, PI_SYNC_OAUTH_CLIENT_ID: "client-1" },
			oauthTransport: transport,
			deviceFlow: { hooks, run: (h) => runDeviceFlow({ stateDir, clientId: "client-1", transport, onStatus: h.onStatus, askRetry: h.askRetry }) },
		});
		expect(built.session?.token).toBe("old");
		const renewed = await built.session?.renew();
		expect(renewed).toBe("flow-at");
	});
});
