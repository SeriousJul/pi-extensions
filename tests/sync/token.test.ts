import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { stateDirFor, resolveToken } from "../../extensions/sync/token.ts";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sync-token-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tokenPath(home: string): string {
	return join(home, ".pi", "sync", "token");
}

describe("resolveToken", () => {
	it("prefers the environment token over the file", async () => {
		const home = await tempHome();
		await mkdir(join(home, ".pi", "sync"), { recursive: true });
		await writeFile(tokenPath(home), "file-token");
		const token = resolveToken(home, { PI_SYNC_TOKEN: "env-token" });
		expect(token).toEqual({ token: "env-token" });
	});

	it("reads and trims the owner-only file", async () => {
		const home = await tempHome();
		await mkdir(join(home, ".pi", "sync"), { recursive: true });
		await writeFile(tokenPath(home), "file-token\n", { mode: 0o600 });
		const token = resolveToken(home, {});
		expect(token).toEqual({ token: "file-token" });
	});

	it("warns but still uses a file that others can read", async () => {
		const home = await tempHome();
		await mkdir(join(home, ".pi", "sync"), { recursive: true });
		await writeFile(tokenPath(home), "loose-token", { mode: 0o644 });
		await chmod(tokenPath(home), 0o644);
		const token = resolveToken(home, {});
		expect(token.token).toBe("loose-token");
		expect(token.warning).toContain("chmod 600");
	});

	it("treats an empty file as no token and explains the fix", async () => {
		const home = await tempHome();
		await mkdir(join(home, ".pi", "sync"), { recursive: true });
		await writeFile(tokenPath(home), "  \n", { mode: 0o600 });
		const token = resolveToken(home, {});
		expect(token.token).toBeUndefined();
		expect(token.error).toContain("PI_SYNC_TOKEN");
		expect(token.error).toContain("gist scope");
	});

	it("explains what to do when there is no token at all", async () => {
		const home = await tempHome();
		const token = resolveToken(home, {});
		expect(token.token).toBeUndefined();
		expect(token.error).toContain(tokenPath(home));
		expect(token.error).toContain("PI_SYNC_TOKEN");
	});

	it("reports a token path that is not a regular file", async () => {
		const home = await tempHome();
		await mkdir(tokenPath(home), { recursive: true }); // a directory where the file should be
		const token = resolveToken(home, {});
		expect(token.token).toBeUndefined();
		expect(token.error).toContain("not a regular file");
	});
});

describe("state locations", () => {
	it("defaults the state dir to <home>/.pi/sync and honors PI_SYNC_STATE_DIR", async () => {
		const home = await tempHome();
		expect(stateDirFor(home, {})).toBe(join(home, ".pi", "sync"));
		expect(stateDirFor(home, { PI_SYNC_STATE_DIR: "/custom/state" })).toBe("/custom/state");
	});
});
