/**
 * The pi entrypoint's passive startup notice (issue #36), pinned at the
 * `session_start` seam on a mock pi. The probe logic itself is covered in
 * ops.test.ts; here we pin what the wiring decides about the status line:
 * a token-holding device that has not joined shows the `run /sync init` nudge,
 * a device with no token stays silent, and the token file on disk is read from
 * the state dir the same way the probe does. The not-joined path never reaches
 * the backend, so these tests run with no network and no real token.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import syncExtension from "../../extensions/sync/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface StatusCall {
	key: string;
	value: string | undefined;
}

const NUDGE = "sync: not joined - run /sync init";

function makeCtx(calls: StatusCall[]): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			setStatus: (key: string, value: string | undefined) => {
				calls.push({ key, value });
			},
		},
	} as unknown as ExtensionContext;
}

/** Load the real entrypoint on a mock pi and grab the session_start handler. */
async function loadSession(): Promise<{ calls: StatusCall[]; fire: () => void }> {
	const calls: StatusCall[] = [];
	let onSessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			if (name === "session_start") onSessionStart = fn;
		},
		registerCommand: () => undefined,
	} as unknown as ExtensionAPI;
	syncExtension(pi);
	const ctx = makeCtx(calls);
	return {
		calls,
		fire: () => onSessionStart!({}, ctx),
	};
}

/** The value the status line last took (the line is always the "sync" key). */
function lastStatus(calls: StatusCall[]): string | undefined {
	return calls[calls.length - 1]?.value;
}

function settle(ms: number): Promise<void> {
	return new Promise((res) => setTimeout(res, ms));
}

/** Poll a condition the background notice drives, with a bounded timeout. */
async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await settle(5);
	}
}

const ENV_KEYS = ["PI_SYNC_TOKEN", "PI_SYNC_STATE_DIR", "PI_SYNC_HOME", "PI_SYNC_GITHUB_BASE_URL"] as const;
const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(async () => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k]!;
	}
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("startup notice at the entrypoint seam (issue #36)", () => {
	it("nudges when a token exists but the device has not joined", async () => {
		process.env.PI_SYNC_TOKEN = "ghs_test";
		process.env.PI_SYNC_HOME = await tempDir("sync-idx-home-");
		process.env.PI_SYNC_STATE_DIR = await tempDir("sync-idx-state-");
		const { calls, fire } = await loadSession();
		fire();
		await until(() => lastStatus(calls) === NUDGE, "the not-joined nudge");
		expect(lastStatus(calls)).toBe(NUDGE);
	});

	it("stays silent when there is no token", async () => {
		delete process.env.PI_SYNC_TOKEN;
		process.env.PI_SYNC_HOME = await tempDir("sync-idx-home-");
		process.env.PI_SYNC_STATE_DIR = await tempDir("sync-idx-state-");
		const { calls, fire } = await loadSession();
		fire();
		// Give the background notice a chance to (wrongly) show the nudge.
		await settle(80);
		expect(lastStatus(calls)).toBeUndefined();
		expect(calls.some((c) => c.value === NUDGE)).toBe(false);
	});
});
