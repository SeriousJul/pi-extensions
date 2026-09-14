import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeBackend, file } from "./fake-backend.ts";
import { sha256Hex } from "../../extensions/sync/hash.ts";
import { DEFAULT_MANIFEST, canonicalManifest, canonicalManifestText, parseManifest } from "../../extensions/sync/manifest.ts";
import { applyPlan, collectLocalFiles } from "../../extensions/sync/localfs.ts";
import { runInit, runPull, runPush, runStatus, type SyncRuntime } from "../../extensions/sync/ops.ts";
import { MANIFEST_KEY, type Snapshot, type SyncFile } from "../../extensions/sync/types.ts";

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
// Permission-based failure injection does not work as root.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Device {
	rt: SyncRuntime;
	fake: FakeBackend;
	home: string;
	stateDir: string;
}

async function makeDevice(fake: FakeBackend): Promise<Device> {
	const home = await tempDir("pi-sync-e2e-");
	const stateDir = join(home, ".pi", "sync");
	const rt: SyncRuntime = { home, stateDir, buildBackend: () => fake };
	return { rt, fake, home, stateDir };
}

/** Write a file at an explicit mtime so merge decisions are deterministic. */
let clock = 1_700_000_000_000;
function nextMs(): number {
	clock += 1_000;
	return clock;
}
async function put(home: string, rel: string, content: string, mtimeMs?: number): Promise<number> {
	const path = join(home, rel);
	const ms = mtimeMs ?? nextMs();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
	await utimes(path, new Date(ms), new Date(ms));
	return ms;
}
async function get(home: string, rel: string): Promise<string> {
	return readFile(join(home, rel), "utf8");
}
async function has(home: string, rel: string): Promise<boolean> {
	return existsSync(join(home, rel));
}
function contentOf(snapshot: Snapshot | null, rel: string): string | undefined {
	return snapshot?.files.find((f) => f.path === rel)?.content;
}
function localManifestOf(device: Device): Promise<string> {
	return readFile(join(device.stateDir, "manifest.json"), "utf8");
}

describe("init / push / pull / status (fake backend)", () => {
	let fake: FakeBackend;
	let a: Device;

	beforeEach(async () => {
		fake = new FakeBackend({ id: "gist-abc" });
		a = await makeDevice(fake);
	});

	it("first push creates the gist with only the manifest-selected files and records the base state", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		await put(a.home, ".pi/agent/settings.json", '{"model":"gpt"}');
		await put(a.home, ".pi/agent/skills/demo/SKILL.md", "# demo");
		await put(a.home, ".pi/agent/auth.json", '{"token":"SECRET"}');

		const outcome = await runPush(a.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.report.gistId).toBe("gist-abc");

		const stored = fake.stored!;
		const paths = stored.files.map((f) => f.path).sort();
		expect(paths).toEqual([".pi/agent/settings.json", ".pi/agent/skills/demo/SKILL.md", "AGENTS.md"]);
		expect(contentOf(stored, ".pi/agent/auth.json")).toBeUndefined();
		// The shared gist manifest is the canonical form (no device-local gist id).
		expect(stored.manifest).toEqual(canonicalManifest(DEFAULT_MANIFEST));
		expect(stored.base?.[MANIFEST_KEY]).toBeDefined();
		expect(Object.keys(stored.base!).sort()).toEqual([...paths, MANIFEST_KEY].sort());

		// The local manifest now names the gist, so later runs join by id.
		const parsed = parseManifest(await localManifestOf(a));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.backendOptions.gistId).toBe("gist-abc");
	});

	it("init on a fresh device joins by id and applies the snapshot", async () => {
		await put(a.home, "AGENTS.md", "shared");
		await put(a.home, ".pi/agent/settings.json", "{}");
		expect((await runPush(a.rt)).ok).toBe(true);

		const b = await makeDevice(fake);
		const outcome = await runInit(b.rt, "gist-abc");
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(await get(b.home, "AGENTS.md")).toBe("shared");
		expect(await get(b.home, ".pi/agent/settings.json")).toBe("{}");
		const parsed = parseManifest(await localManifestOf(b));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.backendOptions.gistId).toBe("gist-abc");
	});

	it("init fails for a gist without a tool-managed manifest", async () => {
		fake.stored = {
			manifest: null,
			files: [file("README.md", "handmade", 1_000)],
			base: null,
		};
		const b = await makeDevice(fake);
		const outcome = await runInit(b.rt, "gist-abc");
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("no tool-managed sync manifest");
	});

	it("pull refuses to run on a device that has not joined", async () => {
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {},
			files: [file("AGENTS.md", "x", 1_000)],
		};
		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("pi sync init");
	});

	it("pull takes a remote-only change and a remote-only file", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);
		const baseMs = 1_000_000_000_000;

		// Device B edits AGENTS.md and adds a skill directory, then pushes.
		const remoteMtime = baseMs + 5_000;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {
				"AGENTS.md": { hash: sha256Hex("from b"), mtimeMs: remoteMtime },
				".pi/agent/skills/demo/SKILL.md": { hash: sha256Hex("# demo b"), mtimeMs: remoteMtime },
			},
			files: [file("AGENTS.md", "from b", remoteMtime), file(".pi/agent/skills/demo/SKILL.md", "# demo b", remoteMtime)],
		};

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(await get(a.home, "AGENTS.md")).toBe("from b");
		expect(await get(a.home, ".pi/agent/skills/demo/SKILL.md")).toBe("# demo b");
		expect(outcome.report.behind).toBeGreaterThanOrEqual(1);
	});

	it("push sends a local-only change without touching remote-only work", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "base op", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Device B edits AGENTS.md (newer than the base).
		const remoteMtime = 1_000_000_000_100;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {
				"AGENTS.md": { hash: sha256Hex("b edit"), mtimeMs: remoteMtime },
				"OPINIONS.md": { hash: sha256Hex("base op"), mtimeMs: 1_000_000_000_000 },
			},
			files: [file("AGENTS.md", "b edit", remoteMtime), file("OPINIONS.md", "base op", 1_000_000_000_000)],
		};

		// Device A edits OPINIONS.md (newer than the base).
		await put(a.home, "OPINIONS.md", "a edit", remoteMtime + 1_000);

		const outcome = await runPush(a.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// The upload contains both sides: b's AGENTS.md (merged in first) and a's OPINIONS.md.
		expect(contentOf(fake.stored, "AGENTS.md")).toBe("b edit");
		expect(contentOf(fake.stored, "OPINIONS.md")).toBe("a edit");
		// The local tree also picked up the remote change.
		expect(await get(a.home, "AGENTS.md")).toBe("b edit");
	});

	it("pull on a both-sides change takes the newer mtime and keeps the loser as a .bak in the same directory", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		const remoteMtime = 1_000_000_000_200;
		const localMtime = 1_000_000_000_100;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote edit"), mtimeMs: remoteMtime } },
			files: [file("AGENTS.md", "remote edit", remoteMtime)],
		};
		await put(a.home, "AGENTS.md", "local edit", localMtime);

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// Remote is newer: it wins, and the local copy is preserved.
		expect(await get(a.home, "AGENTS.md")).toBe("remote edit");
		const backups = (await readdir(a.home)).filter((name) => name.startsWith("AGENTS.md.") && name.endsWith(".bak"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(a.home, backups[0]), "utf8")).toBe("local edit");
	});

	it("pull on an mtime tie keeps local (the edit just made wins)", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		const sameMtime = 1_000_000_000_500;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote edit"), mtimeMs: sameMtime } },
			files: [file("AGENTS.md", "remote edit", sameMtime)],
		};
		await put(a.home, "AGENTS.md", "local edit", sameMtime);

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		expect(await get(a.home, "AGENTS.md")).toBe("local edit");
	});

	it("pull applies a remote deletion of an unchanged file", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "to delete", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Device B deletes OPINIONS.md and pushes: the base carries the marker.
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {
				"AGENTS.md": { hash: sha256Hex("base"), mtimeMs: 1_000_000_000_000 },
				"OPINIONS.md": { hash: sha256Hex("to delete"), mtimeMs: 1_000_000_000_000, deleted: true },
			},
			files: [file("AGENTS.md", "base", 1_000_000_000_000)],
		};

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		expect(await has(a.home, "OPINIONS.md")).toBe(false);
		expect(await has(a.home, "AGENTS.md")).toBe(true);
	});

	it("pull on a delete-vs-modify keeps the modified local copy as a .bak and deletes the file", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("base"), mtimeMs: 1_000_000_000_000, deleted: true } },
			files: [],
		};
		await put(a.home, "AGENTS.md", "local edit", 1_000_000_000_100);

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		expect(await has(a.home, "AGENTS.md")).toBe(false);
		const backups = (await readdir(a.home)).filter((name) => name.startsWith("AGENTS.md.") && name.endsWith(".bak"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(a.home, backups[0]), "utf8")).toBe("local edit");
	});

	it("a backup file never enters the snapshot on the next push", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "AGENTS.md.stale.bak", "old loser", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);
		const paths = fake.stored!.files.map((f) => f.path);
		expect(paths).toContain("AGENTS.md");
		expect(paths).not.toContain("AGENTS.md.stale.bak");
	});

	it("a local deletion is removed from the snapshot on push", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "bye", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		await rm(join(a.home, "OPINIONS.md"));
		expect((await runPush(a.rt)).ok).toBe(true);
		expect(fake.stored!.files.find((f) => f.path === "OPINIONS.md")).toBeUndefined();
		expect(fake.stored!.base?.["OPINIONS.md"]).toEqual({ hash: sha256Hex("bye"), mtimeMs: 1_000_000_000_000, deleted: true });
	});

	it("pull adopts a changed sync manifest from the remote (tool-managed)", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Device B widens the include list and pushes.
		const wide = { ...DEFAULT_MANIFEST, include: [...DEFAULT_MANIFEST.include, ".pi/agent/tools/**"] };
		// The remote manifest push is newer than this device's local manifest file.
		const manifestMtime = Date.now() + 60_000;
		fake.stored = {
			manifest: wide,
			base: {
				"AGENTS.md": { hash: sha256Hex("base"), mtimeMs: 1_000_000_000_000 },
				[MANIFEST_KEY]: { hash: sha256Hex(canonicalManifestText(wide)), mtimeMs: manifestMtime },
			},
			files: [file("AGENTS.md", "base", 1_000_000_000_000)],
			updatedAtMs: manifestMtime,
		};

		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(true);
		const parsed = parseManifest(await localManifestOf(a));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.include).toEqual(wide.include);

		// A new tools config is picked up by the widened manifest on the next push.
		await put(a.home, ".pi/agent/tools/my-tool.json", '{"on":true}', manifestMtime + 1_000);
		expect((await runPush(a.rt)).ok).toBe(true);
		expect(contentOf(fake.stored, ".pi/agent/tools/my-tool.json")).toBe('{"on":true}');
	});

	it("status reports ahead/behind without moving anything", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Diverge: local adds a file; remote edits AGENTS.md.
		await put(a.home, "VOICE.md", "local voice", 1_000_000_000_100);
		const remoteMtime = 1_000_000_000_200;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote"), mtimeMs: remoteMtime } },
			files: [file("AGENTS.md", "remote", remoteMtime)],
		};

		const outcome = await runStatus(a.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.report.ahead).toBe(1);
		expect(outcome.report.behind).toBe(1);
		// Read-only: nothing changed.
		expect(await get(a.home, "AGENTS.md")).toBe("base");
		expect(await has(a.home, "VOICE.md")).toBe(true);
	});

	it("a network failure aborts pull before local files are touched", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);
		const before = (await stat(join(a.home, "AGENTS.md"))).mtimeMs;

		fake.failure = "401: Bad credentials";
		const outcome = await runPull(a.rt);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("401");
		expect(await get(a.home, "AGENTS.md")).toBe("base");
		expect((await stat(join(a.home, "AGENTS.md"))).mtimeMs).toBe(before);
	});

	it("a push upload failure leaves the local tree untouched and the old snapshot in place", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Remote work that would be merged in locally.
		const remoteMtime = 1_000_000_000_200;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote edit"), mtimeMs: remoteMtime } },
			files: [file("AGENTS.md", "remote edit", remoteMtime)],
		};

		fake.failure = "500: internal";
		fake.failureFor = "push";
		const outcome = await runPush(a.rt);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("local files were not modified");
		expect(await get(a.home, "AGENTS.md")).toBe("base");
	});

	it("pull after init on a device with pre-existing local files keeps the local edit", async () => {
		await put(a.home, "AGENTS.md", "shared base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// A second device joins late but already has a local edit.
		const b = await makeDevice(fake);
		await put(b.home, "AGENTS.md", "b local edit", 1_000_000_000_500);
		const init = await runInit(b.rt, "gist-abc");
		expect(init.ok).toBe(true);
		expect(await get(b.home, "AGENTS.md")).toBe("b local edit");
	});

	it("a hand-added gist file survives push: it stays in the target and is reported", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		// Someone hand-adds a file to the gist that no include pattern covers.
		const hand = file("notes/hand.md", "hand", 1_000_000_000_500);
		fake.stored = { ...fake.stored!, files: [...fake.stored!.files, hand] };

		// A second device joins: the unmanaged hand file is not adopted
		// locally (the manifest does not cover it), and its later push must
		// not delete it from the gist.
		const b = await makeDevice(fake);
		expect((await runInit(b.rt, "gist-abc")).ok).toBe(true);
		expect(await has(b.home, "notes/hand.md")).toBe(false);

		const outcome = await runPush(b.rt);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// The unmanaged file is reported, not silently deleted.
		expect(outcome.report.warnings.some((w) => w.includes("notes/hand.md"))).toBe(true);
		expect(fake.stored!.files.some((f) => f.path === "notes/hand.md")).toBe(true);
	});

	it.skipIf(isRoot)("push records the device base only after the local apply succeeds", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);
		const baseBefore = await readFile(join(a.stateDir, "base-state.json"), "utf8");

		// Remote work that the merge would apply locally.
		const remoteMtime = 1_000_000_000_200;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote edit"), mtimeMs: remoteMtime } },
			files: [file("AGENTS.md", "remote edit", remoteMtime)],
		};

		// Make the home read-only so the local apply cannot write.
		await chmod(a.home, 0o555);
		const outcome = await runPush(a.rt);
		await chmod(a.home, 0o755);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("applying the merge locally failed");
		// The local tree is untouched...
		expect(await get(a.home, "AGENTS.md")).toBe("base");
		// ...and the base was not advanced, so the next status reports drift
		// instead of "in sync" over a half-merged tree.
		expect(await readFile(join(a.stateDir, "base-state.json"), "utf8")).toBe(baseBefore);
	});

	it.skipIf(isRoot)("an unreadable in-scope file is skipped with a warning line", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "locked", 1_000_000_000_000);
		await chmod(join(a.home, "OPINIONS.md"), 0o000);
		try {
			const outcome = await runPush(a.rt);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.report.warnings).toContain("skipped unreadable file: OPINIONS.md");
			// The unreadable file did not enter the snapshot.
			expect(fake.stored!.files.some((f) => f.path === "OPINIONS.md")).toBe(false);
		} finally {
			await chmod(join(a.home, "OPINIONS.md"), 0o644);
		}
	});

	it("the whole snapshot round-trips through collectLocalFiles after a push", async () => {
		await put(a.home, "AGENTS.md", "agents", 1_000_000_000_000);
		await put(a.home, ".pi/agent/skills/demo/reporting.md", "reporting", 1_000_000_000_000);
		await put(a.home, ".pi/web-search.json", '{"provider":"brave"}', 1_000_000_000_000);
		expect((await runPush(a.rt)).ok).toBe(true);

		const fresh = await collectLocalFiles(DEFAULT_MANIFEST, a.home);
		const asSnapshot: SyncFile[] = fresh.files;
		expect(asSnapshot.map((f) => f.path).sort()).toEqual([
			".pi/agent/skills/demo/reporting.md",
			".pi/web-search.json",
			"AGENTS.md",
		]);
	});
});
