import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	noTokenMessage,
	parseManagedToken,
	resolveToken,
	stateDirFor,
	tokenPathFor,
	writeManagedToken,
} from "../../extensions/sync/token.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-sync-token-test-"));
});

const tokenPath = (h: string): string => tokenPathFor(stateDirFor(h, {}));

describe("resolveToken", () => {
	it("returns no token and the exact fix when nothing is set", () => {
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBeUndefined();
		expect(resolution.error).toContain("PI_SYNC_TOKEN");
		expect(resolution.error).toContain("device flow");
	});

	it("prefers the environment token over the file (never managed)", async () => {
		await mkdir(stateDirFor(home, {}), { recursive: true });
		await writeFile(tokenPath(home), "file-token");
		const resolution = resolveToken(home, { PI_SYNC_TOKEN: "env-token" });
		expect(resolution.token).toBe("env-token");
		expect(resolution.source).toBe("env");
		expect(resolution.managed).toBeUndefined();
	});

	it("reads and trims a hand-written plain-text file", async () => {
		await mkdir(stateDirFor(home, {}), { recursive: true });
		await writeFile(tokenPath(home), "file-token\n", { mode: 0o600 });
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBe("file-token");
		expect(resolution.source).toBe("plain-file");
		expect(resolution.managed).toBeUndefined();
	});

	it("warns, but still uses, a file whose mode is looser than 0600", async () => {
		await mkdir(stateDirFor(home, {}), { recursive: true });
		await writeFile(tokenPath(home), "loose-token", { mode: 0o644 });
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBe("loose-token");
		expect(resolution.source).toBe("plain-file");
		expect(resolution.warning).toContain("chmod 600");
	});

	it("reads a tool-written managed token file (JSON) with its renewable part", async () => {
		await writeManagedToken(stateDirFor(home, {}), { accessToken: "at", refreshToken: "rt", obtainedMs: 1000, expiresMs: 2000000 });
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBe("at");
		expect(resolution.source).toBe("managed-file");
		expect(resolution.managed).toEqual({ refreshToken: "rt", obtainedMs: 1000, expiresMs: 2000000 });
		expect(resolution.warning).toBeUndefined(); // the tool writes it 0600
	});

	it("warns when a managed token file is looser than 0600 and still parses it", async () => {
		await writeManagedToken(stateDirFor(home, {}), { accessToken: "at", refreshToken: "rt", obtainedMs: 1000, expiresMs: 2000000 });
		await chmod(tokenPath(home), 0o644);
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBe("at");
		expect(resolution.source).toBe("managed-file");
		expect(resolution.warning).toContain("chmod 600");
	});

	it("reports an empty token file as no token", async () => {
		await mkdir(stateDirFor(home, {}), { recursive: true });
		await writeFile(tokenPath(home), "  \n", { mode: 0o600 });
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBeUndefined();
		expect(resolution.error).toContain("PI_SYNC_TOKEN");
	});

	it("reports a token path that is not a regular file", async () => {
		// A directory at the token path: the path exists but is not a file.
		await mkdir(tokenPath(home), { recursive: true });
		const resolution = resolveToken(home, {});
		expect(resolution.token).toBeUndefined();
		expect(resolution.error).toContain("not a regular file");
	});
});

describe("managed token file format (issue #38)", () => {
	it("stores the token pair as JSON with the managed markers", async () => {
		const stateDir = stateDirFor(home, {});
		await writeManagedToken(stateDir, { accessToken: "at", refreshToken: "rt", obtainedMs: 111, expiresMs: 222 });
		const text = (await readFile(tokenPath(home), "utf8")).trim();
		expect(JSON.parse(text)).toEqual({
			v: 1,
			origin: "device-flow",
			accessToken: "at",
			refreshToken: "rt",
			obtainedMs: 111,
			expiresMs: 222,
		});
	});

	it("refuses to parse a hand-written plain-text file as managed", () => {
		expect(parseManagedToken("ghp_plain")).toBeNull();
	});

	it("refuses a JSON file without the managed fields", () => {
		expect(parseManagedToken(JSON.stringify({ accessToken: "x" }))).toBeNull();
		expect(parseManagedToken(JSON.stringify({ v: 2, origin: "device-flow", accessToken: "x" }))).toBeNull();
		expect(parseManagedToken(JSON.stringify({ v: 1, accessToken: "x", refreshToken: "y" }))).toBeNull();
	});

	it("parses a valid managed token", () => {
		expect(parseManagedToken(JSON.stringify({ v: 1, origin: "device-flow", accessToken: "at", refreshToken: "rt", obtainedMs: 1, expiresMs: 2 }))).toEqual({
			accessToken: "at",
			refreshToken: "rt",
			obtainedMs: 1,
			expiresMs: 2,
		});
	});
});

describe("noTokenMessage", () => {
	it("names the device flow first and the hand-written token as the alternative", () => {
		const message = noTokenMessage("/x/.pi/sync/token");
		expect(message).toContain("device flow");
		expect(message).toContain("/x/.pi/sync/token");
		expect(message).toContain("PI_SYNC_TOKEN");
	});
});
