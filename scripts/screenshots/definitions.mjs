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
import { join } from "node:path";

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
 * The fixed bin dir with stub `fd` and `rg` binaries and a `node` shim.
 *
 * pi probes its PATH at startup with `<cmd> --version` and prints a
 * "not found. Offline mode enabled" warning when a binary is missing.
 * The probe result depends on what the rendering machine happens to have
 * installed, so the captures ship their own stubs: the probe always
 * succeeds, the warning never appears, and the screen is identical
 * everywhere. The stubs only ever answer --version; no capture runs a
 * search tool.
 *
 * The `node` shim execs the node running the capture. Language-server
 * probes resolve their binaries as `node`-shebang shims off the capture
 * PATH, so the shim keeps those probes working while keeping the
 * rendering machine's node directory (and whatever else lives next to
 * its node, like a locally installed clangd) off the capture PATH.
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
	const nodeShim = `#!/bin/sh\nexec "${process.execPath}" "$@"\n`;
	const nodeFile = join(dir, "node");
	if (!existsSync(nodeFile) || readFileSync(nodeFile, "utf8") !== nodeShim) {
		writeFileSync(nodeFile, nodeShim, { mode: 0o755 });
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

/** The note-search fixture extension at a fixed work-root path. */
function noteSearchExtension() {
	const dir = join(WORK_ROOT, "note-search");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "index.mjs");
	cpSync(fixtures.NOTE_SEARCH_EXTENSION, file);
	return file;
}

/**
 * The tool-headers before/after pair (issue #137, widened by issue #154):
 * real pi at the pinned grid drives the mock model's one `tool_calls`
 * completion (a real `read`, a real `bash`, and the capture-only
 * `note_search`), so pi runs real tools and draws real Tool rows. The
 * `after` capture loads the tool-headers extension; the `before` capture is
 * the same session without it, so the only visible difference is the
 * header lines. `note_search` stands in for an extension row with stable
 * bytes: a real `bash_bg` row is not used because its job id, pid, and log
 * path are never byte-stable.
 */
function toolHeadersCapture(ctx, { dir, headers }) {
	const root = join(WORK_ROOT, dir);
	const { cwd } = piHome(root);
	// The small note the mock model's `read` call opens.
	writeFileSync(join(cwd, "note.txt"), "Remember the tool row headers.\n", "utf8");
	const extension = mockProviderExtension();
	const headerArgs = headers ? ["--extension", join(ctx.repoRoot, "extensions", "tool-headers", "index.ts")] : [];
	return {
		file: process.execPath,
		args: [
			PI_CLI(ctx.repoRoot),
			"--tui-mode",
			"fullscreen",
			"--model",
			"mock/mock-tools",
			"--extension",
			extension,
			"--extension",
			noteSearchExtension(),
			...headerArgs,
		],
		cwd,
		env: piEnv(root, { MOCK_MODEL_PORT: String(ctx.modelPort) }),
		input: [{ data: "Read note.txt and greet me.\r", delayMs: 300 }],
		marker: "Done.",
		startupMs: 6000,
		timeoutMs: 120_000,
	};
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
	// lsp
	// -----------------------------------------------------------------
	{
		id: "lsp-status",
		out: "docs/extensions/lsp-status.png",
		kind: "pty",
		setup: async (ctx) => {
			const root = join(WORK_ROOT, "lsp");
			piHome(root);
			// A small TypeScript project without a local typescript install:
			// the registry falls back to the repo's node_modules/.bin, where
			// only the TypeScript 7 native tsc resolves, and the other four
			// languages are absent on the capture's PATH. Nothing has run yet.
			const repo = join(root, "repo");
			mkdirSync(repo, { recursive: true });
			writeFileSync(
				join(repo, "tsconfig.json"),
				"{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"target\": \"es2022\" },\n  \"files\": [\"app.ts\"]\n}\n",
				"utf8",
			);
			writeFileSync(join(repo, "app.ts"), "export const greeting = \"hello\";\nconsole.log(greeting);\n", "utf8");
			const extension = mockProviderExtension();
			// The capture's PATH is pinned to the stub bin plus the repo's
			// node_modules/.bin, so which languages are found is identical
			// on every machine: only typescript (its native tsc) resolves.
			// The stub bin carries a node shim, because the tsc binary is a
			// node-shebang script and the registry's version probe execs it
			// to tell TypeScript 7 from the 5.x/6.x compiler CLI.
			const repoBin = join(ctx.repoRoot, "node_modules", ".bin");
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
					join(ctx.repoRoot, "extensions", "lsp", "index.ts"),
				],
				cwd: repo,
				env: piEnv(root, { MOCK_MODEL_PORT: String(ctx.modelPort), PATH: `${stubBinDir()}:${repoBin}` }),
				input: [{ data: "/lsp\r", delayMs: 400 }],
				marker: "watcher: off",
				startupMs: 8000,
				timeoutMs: 120_000,
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

	// -----------------------------------------------------------------
	// tool-headers
	// -----------------------------------------------------------------
	{
		id: "tool-headers",
		out: "docs/extensions/tool-headers.png",
		kind: "pty",
		setup: (ctx) => toolHeadersCapture(ctx, { dir: "tool-headers", headers: true }),
	},
	{
		id: "tool-headers-before",
		out: "docs/extensions/tool-headers-before.png",
		kind: "pty",
		setup: (ctx) => toolHeadersCapture(ctx, { dir: "tool-headers-before", headers: false }),
	},
];
