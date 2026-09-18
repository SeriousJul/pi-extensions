/**
 * Every docs screenshot, declaratively.
 *
 * Two kinds:
 *   offscreen - the exact component the extension's /command would mount,
 *     rendered in an alt-screen TUI over committed fixture data.
 *   pty       - a real process in a pseudo-terminal at the pinned grid:
 *     real pi with the real extension (codegraph, context-cap,
 *     model-router) or the real CLIs (pi-usage, pi-sync).
 *
 * `out` is the committed PNG path relative to the repo root. The image
 * lives in the extension's page directory, next to the page that embeds
 * it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WORK_ROOT } from "./look.mjs";
import * as views from "./views.mjs";
import * as fixtures from "./fixtures.mjs";

const PI_CLI = (repoRoot) => join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/** The disposable pi home: settings.json plus an empty project dir. */
function piHome(root, settings) {
	mkdirSync(join(root, "home"), { recursive: true });
	mkdirSync(join(root, "cwd"), { recursive: true });
	if (settings) writeFileSync(join(root, "home", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
	return { home: join(root, "home"), cwd: join(root, "cwd") };
}

/**
 * The fixed bin dir with stub `fd` and `rg` binaries.
 *
 * pi probes its PATH at startup with `<cmd> --version` and prints a
 * "not found. Offline mode enabled" warning when a binary is missing.
 * The probe result depends on what the rendering machine happens to have
 * installed, so the captures ship their own stubs: the probe always
 * succeeds, the warning never appears, and the screen is identical
 * everywhere. The stubs only ever answer --version; no capture runs a
 * search tool.
 */
function stubBinDir() {
	const dir = join(WORK_ROOT, "bin");
	mkdirSync(dir, { recursive: true });
	const stubs = { fd: "fd 10.0.0", rg: "ripgrep 14.1.0" };
	for (const [name, version] of Object.entries(stubs)) {
		const file = join(dir, name);
		const source = `#!/bin/sh\necho "${version}"\nexit 0\n`;
		if (!existsSync(file) || readFileSync(file, "utf8") !== source) {
			writeFileSync(file, source, { mode: 0o755 });
		}
	}
	return dir;
}

/** The environment every real-pi capture runs with. */
function piEnv(root, extra = {}) {
	return {
		PI_CODING_AGENT_DIR: join(root, "home"),
		HOME: join(root, "home"),
		PI_OFFLINE: "1",
		TZ: "UTC",
		FORCE_COLOR: "3",
		// Same codegraph build as the indexing step in buildIndexedRepo.
		CODEGRAPH_NO_FAST_INIT: "1",
		PATH: `${stubBinDir()}:${process.env.PATH ?? ""}`,
		...extra,
	};
}

/** The mock provider extension at a fixed work-root path. */
function mockProviderExtension() {
	const dir = join(WORK_ROOT, "mock-provider");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "mock-provider.mjs");
	cpSync(fixtures.MOCK_PROVIDER_EXTENSION, file);
	return file;
}

/**
 * Run one status merge over the committed sync fixture and return the
 * report lines. The real ops code runs; only the transport is the
 * fixture gist.
 */
async function syncStatusLines() {
	const { syncGistFixture, fixtureGistTransport } = fixtures;
	const { home, stateDir, gist } = await syncGistFixture();
	const transport = fixtureGistTransport();
	transport.register(gist);
	const { createBackend } = await import("../../extensions/sync/backends.ts");
	const { runStatus } = await import("../../extensions/sync/ops.ts");
	const rt = {
		home,
		stateDir,
		buildBackend: (manifest, extra) => {
			const built = createBackend(manifest, { token: "fixture-token", transport }, extra);
			if (!built.backend) throw new Error(built.error ?? "could not build the sync backend");
			return built.backend;
		},
	};
	const outcome = await runStatus(rt);
	if (!outcome.ok) throw new Error(`sync fixture is not in sync: ${outcome.error}`);
	return outcome.report.lines;
}

/** git init + one commit with fixed identity and date. */
function gitInit(root) {
	const run = (args) =>
		execFileSync("git", args, {
			cwd: root,
			stdio: "pipe",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.com",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.com",
				GIT_COMMITTER_DATE: "2026-01-15T14:00:00Z",
			},
		});
	run(["init", "-b", "main"]);
	run(["add", "-A"]);
	run(["commit", "-m", "fixture"]);
}

/** Build the fixture repo and index it with the real codegraph library. */
async function buildIndexedRepo() {
	const root = fixtures.buildCodegraphFixture();
	gitInit(root);
	// Fast init switches the fresh database's journal mode from the store
	// worker's second connection; on slow filesystems that lands inside a
	// locked window and the worker aborts with "database is locked". The
	// kill switch keeps the WAL build, which is deterministic here. Set
	// before the library loads, as the runtime's env defaults require.
	process.env.CODEGRAPH_NO_FAST_INIT = "1";
	const { CodeGraph } = await import("../../extensions/codegraph/runtime.ts");
	await CodeGraph.init(root);
	const graph = await CodeGraph.open(root, { sync: false });
	await graph.indexAll();
	graph.close();
	return root;
}

export const CAPTURES = [
	// -----------------------------------------------------------------
	// quota
	// -----------------------------------------------------------------
	{
		id: "quota-detail",
		out: "docs/extensions/quota-detail.png",
		kind: "offscreen",
		build: (tui) => views.quotaDetailView(),
	},
	{
		id: "quota-footer",
		out: "docs/extensions/quota-footer.png",
		kind: "offscreen",
		build: (tui) => views.quotaFooterLine(),
	},

	// -----------------------------------------------------------------
	// usage
	// -----------------------------------------------------------------
	{
		id: "usage-tui",
		out: "docs/extensions/usage-tui.png",
		kind: "offscreen",
		build: (tui) => views.usageTui(tui),
	},
	{
		id: "usage-cli",
		out: "docs/extensions/usage-cli.png",
		kind: "pty",
		// fast enough to re-render inside the unit test suite (npm test);
		// the live-pi pty captures are covered by the CI screenshots job.
		fast: true,
		setup: async (ctx) => ({
			file: process.execPath,
			args: [join(ctx.repoRoot, "extensions", "usage", "cli.mjs"), "report", "--month", "2026-09"],
			cwd: WORK_ROOT,
			env: { PI_SESSIONS_DIR: fixtures.USAGE_SESSIONS_ROOT, TZ: "UTC", FORCE_COLOR: "3" },
			input: [],
			startupMs: 500,
			timeoutMs: 60_000,
		}),
	},

	// -----------------------------------------------------------------
	// initial-context, tools, resource-toggle
	// -----------------------------------------------------------------
	{
		id: "initial-context",
		out: "docs/extensions/initial-context.png",
		kind: "offscreen",
		build: (tui) => views.contextTui(tui),
	},
	{
		id: "tools",
		out: "docs/extensions/tools.png",
		kind: "offscreen",
		build: (tui) => views.toolsView(),
	},
	{
		id: "resources",
		out: "docs/extensions/resources.png",
		kind: "offscreen",
		build: (tui) => views.resourcesTui(tui),
	},

	// -----------------------------------------------------------------
	// sync
	// -----------------------------------------------------------------
	{
		id: "sync-view",
		out: "docs/extensions/sync/sync-view.png",
		kind: "offscreen",
		build: async (tui) => views.syncStatusView(await syncStatusLines()),
	},
	{
		id: "sync-status",
		out: "docs/extensions/sync/sync-status.png",
		kind: "pty",
		fast: true,
		setup: async (ctx) => {
			const { home, stateDir, gist } = await fixtures.syncGistFixture();
			const server = await ctx.serveGist(gist);
			return {
				file: process.execPath,
				args: [join(ctx.repoRoot, "extensions", "sync", "cli.mjs"), "status"],
				cwd: WORK_ROOT,
				env: {
					PI_SYNC_HOME: home,
					PI_SYNC_STATE_DIR: stateDir,
					PI_SYNC_TOKEN: "fixture-token",
					PI_SYNC_GITHUB_BASE_URL: `http://127.0.0.1:${server.port}`,
					TZ: "UTC",
					FORCE_COLOR: "3",
				},
				input: [],
				startupMs: 500,
				timeoutMs: 60_000,
			};
		},
	},

	// -----------------------------------------------------------------
	// pruning, compress
	// -----------------------------------------------------------------
	{
		id: "pruning-settings",
		out: "docs/extensions/pruning-settings.png",
		kind: "offscreen",
		build: (tui) => views.pruningSettingsLines(),
	},
	{
		id: "compress-status",
		out: "docs/extensions/compress-status.png",
		kind: "offscreen",
		build: (tui) => views.compressStatusLine(),
	},

	// -----------------------------------------------------------------
	// codegraph
	// -----------------------------------------------------------------
	{
		id: "codegraph-status",
		out: "docs/extensions/codegraph/codegraph-status.png",
		kind: "pty",
		setup: async (ctx) => {
			const repo = await buildIndexedRepo();
			const root = join(WORK_ROOT, "codegraph");
			piHome(root);
			// Register the mock provider like the other real-pi captures do,
			// so a model exists and pi's "No models available" warning
			// (which embeds this machine's path) never reaches the screen.
			const extension = mockProviderExtension();
			return {
				file: process.execPath,
				args: [
					PI_CLI(ctx.repoRoot),
					"--tui-mode",
					"fullscreen",
					"--model",
					"mock/mock-orig",
					"--extension",
					extension,
					"--extension",
					join(ctx.repoRoot, "extensions", "codegraph", "index.ts"),
				],
				cwd: repo,
				env: piEnv(root, { MOCK_MODEL_PORT: String(ctx.modelPort) }),
				input: [{ data: "/codegraph\r", delayMs: 200 }],
				marker: "auto-index",
				startupMs: 8000,
				timeoutMs: 180_000,
			};
		},
	},

	// -----------------------------------------------------------------
	// context-cap
	// -----------------------------------------------------------------
	{
		id: "context-cap",
		out: "docs/extensions/context-cap.png",
		kind: "pty",
		setup: async (ctx) => {
			const root = join(WORK_ROOT, "context-cap");
			piHome(root);
			const extension = mockProviderExtension();
			return {
				file: process.execPath,
				args: [
					PI_CLI(ctx.repoRoot),
					"--tui-mode",
					"fullscreen",
					"--model",
					"mock/mock-orig",
					"--context-window",
					"100000",
					"--extension",
					extension,
					"--extension",
					join(ctx.repoRoot, "extensions", "context-cap", "index.ts"),
					"--extension",
					join(ctx.repoRoot, "extensions", "tools.ts"),
				],
				cwd: join(root, "cwd"),
				env: piEnv(root, { MOCK_MODEL_PORT: String(ctx.modelPort) }),
				input: [],
				marker: "Context window capped at 100000 tokens",
				startupMs: 6000,
				timeoutMs: 120_000,
			};
		},
	},

	// -----------------------------------------------------------------
	// model-router
	// -----------------------------------------------------------------
	{
		id: "model-router-halt",
		out: "docs/extensions/model-router-halt.png",
		kind: "pty",
		setup: async (ctx) => {
			const root = join(WORK_ROOT, "model-router");
			piHome(root, {
				retry: { enabled: false },
				modelRouter: { precedence: ["switch"], fallbacks: ["mock/mock-fallback"] },
			});
			const extension = mockProviderExtension();
			return {
				file: process.execPath,
				args: [
					PI_CLI(ctx.repoRoot),
					"--tui-mode",
					"fullscreen",
					"--model",
					"mock/mock-orig",
					"--extension",
					extension,
					"--extension",
					join(ctx.repoRoot, "extensions", "model-router", "index.ts"),
					"--extension",
					join(ctx.repoRoot, "extensions", "tools.ts"),
				],
				cwd: join(root, "cwd"),
				env: piEnv(root, { MOCK_MODEL_PORT: String(ctx.modelPort) }),
				input: [{ data: "Say hello.\r", delayMs: 100 }],
				marker: "Hello! I am the fallback model.",
				startupMs: 6000,
				timeoutMs: 120_000,
			};
		},
	},
];
