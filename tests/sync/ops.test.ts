import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeBackend, file } from "./fake-backend.ts";
import { sha256Hex } from "../../extensions/sync/hash.ts";
import { DEFAULT_MANIFEST, canonicalManifest, canonicalManifestText, parseManifest, serializeManifest } from "../../extensions/sync/manifest.ts";
import { applyPlan, collectLocalFiles } from "../../extensions/sync/localfs.ts";
import { probeStartup, runInit, runPull, runPush, runStatus, type SyncRuntime } from "../../extensions/sync/ops.ts";
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

	it("init without an id creates the gist (the create path) with only the manifest-selected files and records the base state", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		await put(a.home, ".pi/agent/settings.json", '{"model":"gpt"}');
		await put(a.home, ".pi/agent/skills/demo/SKILL.md", "# demo");
		await put(a.home, ".pi/agent/auth.json", '{"token":"SECRET"}');

		const outcome = await runInit(a.rt, undefined, { yes: true });
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
	it("a bare push never creates the gist and points at init", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		const outcome = await runPush(a.rt);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("pi-sync init");
	});

	// Acceptance criteria, issue #39.

	it("init without an id reports the new gist id and the join command for the other devices", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		const outcome = await runInit(a.rt, undefined, { yes: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const lines = outcome.report.lines.join("\n");
		expect(lines).toContain("created secret gist gist-abc");
		expect(lines).toContain("pi-sync init gist-abc");
	});

	it("init without an id uses the local manifest from the state dir when present", async () => {
		// A hand-tuned manifest: only AGENTS.md syncs, OPINIONS.md is excluded.
		const custom = { ...DEFAULT_MANIFEST, include: ["AGENTS.md"], exclude: ["OPINIONS.md"] };
		await put(a.home, "AGENTS.md", "# agents a");
		await put(a.home, "OPINIONS.md", "op");
		await put(a.home, ".pi/agent/settings.json", '{"model":"gpt"}');
		await mkdir(a.stateDir, { recursive: true });
		await writeFile(join(a.stateDir, "manifest.json"), serializeManifest(custom), { mode: 0o600 });

		const outcome = await runInit(a.rt, undefined, { yes: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		// The create path collected under the local manifest, not the default.
		const stored = fake.stored!;
		expect(stored.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
		expect(stored.manifest).toEqual(canonicalManifest(custom));

		// The local manifest kept its include list and gained the gist id.
		const parsed = parseManifest(await localManifestOf(a));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.manifest.include).toEqual(["AGENTS.md"]);
			expect(parsed.manifest.backendOptions.gistId).toBe("gist-abc");
		}
	});

	it("init without an id uses the default manifest when the state dir has none", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		await put(a.home, ".pi/agent/settings.json", '{"model":"gpt"}');
		const outcome = await runInit(a.rt, undefined, { yes: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(fake.stored!.files.map((f) => f.path).sort()).toEqual([".pi/agent/settings.json", "AGENTS.md"]);
		expect(fake.stored!.manifest).toEqual(canonicalManifest(DEFAULT_MANIFEST));
	});

	it("init without an id on an already-joined device refuses and creates no gist", async () => {
		const joined = {
			...DEFAULT_MANIFEST,
			backendOptions: { ...DEFAULT_MANIFEST.backendOptions, gistId: "old-gist" },
		};
		await mkdir(a.stateDir, { recursive: true });
		await writeFile(join(a.stateDir, "manifest.json"), serializeManifest(joined), { mode: 0o600 });
		await put(a.home, "AGENTS.md", "# agents a");

		const outcome = await runInit(a.rt, undefined, { yes: true });
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("old-gist");
		expect(fake.stored).toBeNull();
		expect(fake.calls.some((c) => c.method === "create")).toBe(false);
	});

	it("init create without consent writes nothing and returns the preview", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		const outcome = await runInit(a.rt, undefined, {});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("nothing was written");
		expect(outcome.preview).toBeDefined();
		expect(outcome.preview!.join("\n")).toContain("AGENTS.md");
		expect(fake.stored).toBeNull();
	});

	it("init on a fresh device joins by id and applies the snapshot", async () => {
		await put(a.home, "AGENTS.md", "shared");
		await put(a.home, ".pi/agent/settings.json", "{}");
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		const b = await makeDevice(fake);
		const outcome = await runInit(b.rt, "gist-abc", { yes: true });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(await get(b.home, "AGENTS.md")).toBe("shared");
		expect(await get(b.home, ".pi/agent/settings.json")).toBe("{}");
		const parsed = parseManifest(await localManifestOf(b));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.backendOptions.gistId).toBe("gist-abc");
	});

	it("joining with a pre-written manifest and no base adopts the shared tree; the first push keeps the shared files", async () => {
		// Device A creates the gist with three files.
		await put(a.home, "AGENTS.md", "agents", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "opinions", 1_000_000_000_000);
		await put(a.home, "VOICE.md", "voice", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		// Device B is a real onboarding state: a hand-written manifest and a
		// local AGENTS.md, but no base record (it never synced) and no
		// OPINIONS.md or VOICE.md.
		const b = await makeDevice(fake);
		await mkdir(b.stateDir, { recursive: true });
		await writeFile(join(b.stateDir, "manifest.json"), canonicalManifestText(DEFAULT_MANIFEST));
		await put(b.home, "AGENTS.md", "agents", 1_000_000_000_000);

		const init = await runInit(b.rt, "gist-abc", { yes: true });
		expect(init.ok).toBe(true);
		if (!init.ok) return;
		// The join preview lists the files that arrive (F2), not just a count.
		const preview = init.preview!.join("\n");
		expect(preview).toContain("arriving: 2 new file(s) from the shared tree");
		expect(preview).toContain("  OPINIONS.md");
		expect(preview).toContain("  VOICE.md");
		// The never-held shared files are adopted locally, not read as deletions.
		expect(await has(b.home, "OPINIONS.md")).toBe(true);
		expect(await has(b.home, "VOICE.md")).toBe(true);

		// The first push must not delete the shared files this device never
		// held: they survive in the gist and the base carries no deletion.
		const pushed = await runPush(b.rt);
		expect(pushed.ok).toBe(true);
		expect(fake.stored!.files.map((f) => f.path).sort()).toEqual(["AGENTS.md", "OPINIONS.md", "VOICE.md"]);
		expect(fake.stored!.base?.["OPINIONS.md"]?.deleted).not.toBe(true);
		expect(fake.stored!.base?.["VOICE.md"]?.deleted).not.toBe(true);
	});

	it("init join without consent writes nothing and returns the preview", async () => {
		await put(a.home, "AGENTS.md", "shared");
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		const b = await makeDevice(fake);
		const outcome = await runInit(b.rt, "gist-abc", {});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toContain("nothing was written");
		expect(outcome.preview!.join("\n")).toContain("AGENTS.md");
		expect(await has(b.home, "AGENTS.md")).toBe(false);
	});

	it("init with yes succeeds and still carries the preview for the caller to show", async () => {
		await put(a.home, "AGENTS.md", "shared");
		const created = await runInit(a.rt, undefined, { yes: true });
		expect(created.ok).toBe(true);
		if (created.ok) {
			expect(created.preview!.join("\n")).toContain("preview, nothing written yet");
			expect(created.preview!.join("\n")).toContain("AGENTS.md");
		}
		const b = await makeDevice(fake);
		const joined = await runInit(b.rt, "gist-abc", { yes: true });
		expect(joined.ok).toBe(true);
		if (joined.ok) expect(joined.preview!.join("\n")).toContain("preview, nothing written yet");
	});

	// Acceptance criteria, issue #35: preview content, confirm-before-write,
	// decline leaves the tree untouched, re-init confirms, force bypasses.

	/** Device A creates a gist with two files; device B joins and confirms. */
	async function joinedPair(): Promise<Device> {
		await put(a.home, "AGENTS.md", "agents base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "opinions base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
		const b = await makeDevice(fake);
		expect((await runInit(b.rt, "gist-abc", { yes: true })).ok).toBe(true);
		return b;
	}

	/** Remote work on top of the joined pair: OPINIONS.md changed, VOICE.md new. */
	function remoteWork(): number {
		const t = 1_000_000_001_000;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {
				"AGENTS.md": { hash: sha256Hex("agents base"), mtimeMs: 1_000_000_000_000 },
				"OPINIONS.md": { hash: sha256Hex("opinions remote"), mtimeMs: t },
				"VOICE.md": { hash: sha256Hex("voice remote"), mtimeMs: t },
			},
			files: [
				file("AGENTS.md", "agents base", 1_000_000_000_000),
				file("OPINIONS.md", "opinions remote", t),
				file("VOICE.md", "voice remote", t),
			],
			updatedAtMs: t,
		};
		return t;
	}

	it("the join preview lists the in-scope paths, the arriving file count, and the local files that will be replaced", async () => {
		const b = await joinedPair();
		remoteWork();

		let asked: string[] | null = null;
		const outcome = await runInit(b.rt, "gist-abc", { ask: async (lines) => ((asked = lines), false) });
		expect(asked).not.toBeNull();
		const preview = asked!.join("\n");
		// The in-scope paths: the manifest summary.
		expect(preview).toContain(`in scope: ${DEFAULT_MANIFEST.include.length} include pattern(s): ${DEFAULT_MANIFEST.include.join(", ")}`);
		// The arriving files, by count and by name.
		expect(preview).toContain("arriving: 1 new file(s) from the shared tree");
		expect(preview).toContain("  VOICE.md");
		// The local files that will be replaced, named exactly.
		expect(preview).toContain("will replace local:");
		expect(preview).toContain("  OPINIONS.md");
		expect(preview).not.toContain("  AGENTS.md"); // unchanged locally: not touched
		expect(outcome.ok).toBe(false);
	});

	it("a declined confirm leaves the local tree and the gist untouched", async () => {
		const b = await joinedPair();
		remoteWork();

		const outcome = await runInit(b.rt, "gist-abc", { ask: async () => false });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error).toContain("declined");
			// The prompt already showed the preview; the report must not owe it again.
			expect(outcome.previewShown).toBe(true);
		}
		// The tree is exactly as it was before the prompt.
		expect(await get(b.home, "OPINIONS.md")).toBe("opinions base");
		expect(await get(b.home, "AGENTS.md")).toBe("agents base");
		expect(await has(b.home, "VOICE.md")).toBe(false);
		expect((await readdir(b.home)).filter((name) => name.endsWith(".bak"))).toHaveLength(0);
		// Nothing left in the state dir beyond the original join, nothing uploaded.
		expect(fake.calls.every((c) => c.method === "fetch" || c.method === "create")).toBe(true);
	});

	it("no local write happens before the confirm prompt (create path)", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		let atPrompt: { stateDirExists: boolean } | null = null;
		const outcome = await runInit(a.rt, undefined, {
			ask: async (lines) => {
				expect(lines.join("\n")).toContain("AGENTS.md");
				atPrompt = { stateDirExists: existsSync(a.stateDir) };
				return true;
			},
		});
		expect(outcome.ok).toBe(true);
		expect(atPrompt).not.toBeNull();
		expect(atPrompt!.stateDirExists).toBe(false); // the first write comes after the confirm
		expect(existsSync(join(a.stateDir, "manifest.json"))).toBe(true);
	});

	it("re-init on an already-joined device confirms again", async () => {
		const b = await joinedPair();
		remoteWork();
		let asks = 0;
		const outcome = await runInit(b.rt, "gist-abc", { ask: async () => ((asks += 1), true) });
		expect(outcome.ok).toBe(true);
		expect(asks).toBe(1); // the confirm is not skipped because the device is joined
		expect(await get(b.home, "OPINIONS.md")).toBe("opinions remote"); // the confirmed re-init applied
	});

	it("the force flag bypasses the confirm on a re-init, and nothing runs without it", async () => {
		const b = await joinedPair();
		remoteWork();

		let asks = 0;
		const forced = await runInit(b.rt, "gist-abc", { force: true, ask: async () => ((asks += 1), true) });
		expect(forced.ok).toBe(true);
		expect(asks).toBe(0); // never prompted
		expect(await get(b.home, "OPINIONS.md")).toBe("opinions remote");

		// The same re-init without force or yes does not run at all.
		const refused = await runInit(b.rt, "gist-abc", {});
		expect(refused.ok).toBe(false);
	});

	it("joining a different gist with an existing base record starts fresh: it adopts the new tree", async () => {
		const b = await joinedPair(); // b holds a base record of gist-abc

		// A different shared tree (as fetched for another gist id). VOICE.md is
		// in scope but a file b has never held.
		const t = 1_000_000_002_000;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {
				"AGENTS.md": { hash: sha256Hex("other agents"), mtimeMs: t },
				"VOICE.md": { hash: sha256Hex("other voice"), mtimeMs: t },
			},
			files: [file("AGENTS.md", "other agents", t), file("VOICE.md", "other voice", t)],
			updatedAtMs: t,
		};

		const outcome = await runInit(b.rt, "gist-xyz", { yes: true });
		expect(outcome.ok).toBe(true);
		// The file the device never held is adopted (a stale base of another
		// gist must not be read as a local deletion).
		expect(await has(b.home, "VOICE.md")).toBe(true);
		// The local edit-free file is kept as a local change, not clobbered.
		expect(await get(b.home, "AGENTS.md")).toBe("agents base");
		// The manifest now points at the new gist.
		const parsed = parseManifest(await localManifestOf(b));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.backendOptions.gistId).toBe("gist-xyz");
	});

	it("force does not bypass the confirm on the create path", async () => {
		await put(a.home, "AGENTS.md", "# agents a");
		const outcome = await runInit(a.rt, undefined, { force: true });
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error).toContain("no confirmation given");
		expect(fake.stored).toBeNull();
	});

	it("init fails for a gist without a tool-managed manifest", async () => {
		fake.stored = {
			manifest: null,
			files: [file("README.md", "handmade", 1_000)],
			base: null,
		};
		const b = await makeDevice(fake);
		const outcome = await runInit(b.rt, "gist-abc", { yes: true });
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
		const paths = fake.stored!.files.map((f) => f.path);
		expect(paths).toContain("AGENTS.md");
		expect(paths).not.toContain("AGENTS.md.stale.bak");
	});

	it("a local deletion is removed from the snapshot on push", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		await put(a.home, "OPINIONS.md", "bye", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		await rm(join(a.home, "OPINIONS.md"));
		expect((await runPush(a.rt)).ok).toBe(true);
		expect(fake.stored!.files.find((f) => f.path === "OPINIONS.md")).toBeUndefined();
		expect(fake.stored!.base?.["OPINIONS.md"]).toEqual({ hash: sha256Hex("bye"), mtimeMs: 1_000_000_000_000, deleted: true });
	});

	it("pull adopts a changed sync manifest from the remote (tool-managed)", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		// A second device joins late but already has a local edit.
		const b = await makeDevice(fake);
		await put(b.home, "AGENTS.md", "b local edit", 1_000_000_000_500);
		const init = await runInit(b.rt, "gist-abc", { yes: true });
		expect(init.ok).toBe(true);
		expect(await get(b.home, "AGENTS.md")).toBe("b local edit");
	});

	it("a hand-added gist file survives push: it stays in the target and is reported", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		// Someone hand-adds a file to the gist that no include pattern covers.
		const hand = file("notes/hand.md", "hand", 1_000_000_000_500);
		fake.stored = { ...fake.stored!, files: [...fake.stored!.files, hand] };

		// A second device joins: the unmanaged hand file is not adopted
		// locally (the manifest does not cover it), and its later push must
		// not delete it from the gist.
		const b = await makeDevice(fake);
		expect((await runInit(b.rt, "gist-abc", { yes: true })).ok).toBe(true);
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path
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
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true); // the create path

		const fresh = await collectLocalFiles(DEFAULT_MANIFEST, a.home);
		const asSnapshot: SyncFile[] = fresh.files;
		expect(asSnapshot.map((f) => f.path).sort()).toEqual([
			".pi/agent/skills/demo/reporting.md",
			".pi/web-search.json",
			"AGENTS.md",
		]);
	});
});

describe("startup probe (issue #36)", () => {
	let fake: FakeBackend;
	let a: Device;

	beforeEach(async () => {
		fake = new FakeBackend({ id: "gist-abc" });
		a = await makeDevice(fake);
	});

	it("nudges a device that has not joined, without touching the backend", async () => {
		// A shared tree exists, but this device never ran init.
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: {},
			files: [file("AGENTS.md", "x", 1_000)],
		};
		const probe = await probeStartup(a.rt);
		expect(probe).toEqual({ state: "not-joined" });
		// Read-only: a not-joined probe never builds the backend at all.
		expect(fake.calls).toEqual([]);
	});

	it("stays silent for a joined device with zero drift", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		expect((await runPush(a.rt)).ok).toBe(true);
		const probe = await probeStartup(a.rt);
		expect(probe).toEqual({ state: "silent" });
	});

	it("reports drift for a joined device", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		expect((await runPush(a.rt)).ok).toBe(true);
		// Diverge: local adds a file; remote edits AGENTS.md.
		await put(a.home, "VOICE.md", "local voice", 1_000_000_000_100);
		const remoteMtime = 1_000_000_000_200;
		fake.stored = {
			manifest: DEFAULT_MANIFEST,
			base: { "AGENTS.md": { hash: sha256Hex("remote"), mtimeMs: remoteMtime } },
			files: [file("AGENTS.md", "remote", remoteMtime)],
		};
		const probe = await probeStartup(a.rt);
		expect(probe).toEqual({ state: "drift", ahead: 1, behind: 1 });
	});

	it("stays silent when the fetch fails for a joined device", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		expect((await runPush(a.rt)).ok).toBe(true);
		fake.failure = "401: Bad credentials";
		const probe = await probeStartup(a.rt);
		expect(probe).toEqual({ state: "silent" });
	});

	it("stays silent when the local manifest is unreadable", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		expect((await runPush(a.rt)).ok).toBe(true);
		// Corrupt the manifest after joining: a failed local read stays silent.
		await writeFile(join(a.stateDir, "manifest.json"), "{ not json ");
		const probe = await probeStartup(a.rt);
		expect(probe).toEqual({ state: "silent" });
	});

	it("never starts a device flow: a joined probe only fetches", async () => {
		await put(a.home, "AGENTS.md", "base", 1_000_000_000_000);
		expect((await runInit(a.rt, undefined, { yes: true })).ok).toBe(true);
		expect((await runPush(a.rt)).ok).toBe(true);
		fake.calls = []; // drop the push's own traffic
		await probeStartup(a.rt);
		const methods = fake.calls.map((c) => c.method);
		expect(methods).toEqual(["fetch"]);
	});
});
