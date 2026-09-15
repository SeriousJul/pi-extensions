import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectLocalFiles } from "../../extensions/sync/localfs.ts";
import { DEFAULT_MANIFEST } from "../../extensions/sync/manifest.ts";
import type { SyncManifest } from "../../extensions/sync/types.ts";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sync-localfs-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("collectLocalFiles (issue #50): GitHub gists are flat and text", () => {
	it("collects nested paths by their home-relative path", async () => {
		const home = await tempHome();
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(join(home, "AGENTS.md"), "# agents");
		await writeFile(join(home, ".pi", "agent", "settings.json"), "{}");
		const collected = await collectLocalFiles(DEFAULT_MANIFEST, home);
		expect(collected.files.map((f) => f.path).sort()).toEqual([".pi/agent/settings.json", "AGENTS.md"]);
		expect(collected.warnings).toEqual([]);
	});

	it("skips an empty file with a warning: gists cannot store empty content", async () => {
		const home = await tempHome();
		await writeFile(join(home, "AGENTS.md"), "# agents");
		await writeFile(join(home, "OPINIONS.md"), "");
		const collected = await collectLocalFiles(DEFAULT_MANIFEST, home);
		expect(collected.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
		expect(collected.warnings).toHaveLength(1);
		expect(collected.warnings[0]).toContain("OPINIONS.md");
	});

	it("skips a file whose name is a tool-managed gist file, with a warning", async () => {
		const home = await tempHome();
		await writeFile(join(home, ".pi-sync-manifest.json"), "{}");
		await writeFile(join(home, "AGENTS.md"), "# agents");
		const manifest: SyncManifest = { ...DEFAULT_MANIFEST, include: [...DEFAULT_MANIFEST.include, ".pi-sync-manifest.json"] };
		const collected = await collectLocalFiles(manifest, home);
		expect(collected.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
		expect(collected.warnings).toHaveLength(1);
		expect(collected.warnings[0]).toContain(".pi-sync-manifest.json");
	});
});
