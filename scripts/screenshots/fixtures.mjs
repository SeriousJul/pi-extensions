/**
 * Committed fixture data for every screenshot (ADR 0017).
 *
 * Every value here is fixed: one canonical clock, fixed percentages, fixed
 * trees. The capture pipeline never reads the live machine - no home dir,
 * no session history, no network - so a re-render is byte-identical.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { WORK_ROOT } from "./look.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = join(here, "fixtures");

/** The one clock every capture shares. A Thursday, mid-afternoon UTC. */
export const NOW_MS = Date.parse("2026-01-15T14:00:00.000Z");
export const now = () => NOW_MS;

// ---------------------------------------------------------------------------
// quota: the /quota detail view and the footer line
// ---------------------------------------------------------------------------

/**
 * The plan snapshot behind the quota screenshots. The numbers are the
 * example the quota docs page shows, so the text and the pixels agree:
 * plan plus, the 5h window at 42% resetting at 19:00 the same day, the 7d
 * window at 18% resetting the following Thursday at 14:00, fetched at
 * 13:56:00 (4m before the canonical clock).
 */
export const QUOTA_SNAPSHOT = {
	planType: "plus",
	accountEmail: "julian@example.com",
	fetchedAtMs: Date.parse("2026-01-15T13:56:00.000Z"),
	windows: [
		{
			label: "5h",
			usedPercent: 42,
			resetsAtMs: Date.parse("2026-01-15T19:00:00.000Z"),
			windowLengthMs: 5 * 60 * 60 * 1000,
		},
		{
			label: "7d",
			usedPercent: 18,
			resetsAtMs: Date.parse("2026-01-22T14:00:00.000Z"),
			windowLengthMs: 7 * 24 * 60 * 60 * 1000,
		},
	],
};

// ---------------------------------------------------------------------------
// sync: the /sync status view and the pi-sync status CLI
// ---------------------------------------------------------------------------

/** The shared gist id every fixture mentions. */
export const SYNC_GIST_ID = "9f2c41ab";
/** The fixed mtime the fixture Base state records for every file. */
export const SYNC_BASE_MTIME_MS = Date.parse("2026-01-15T16:00:00.000Z");
/** The home-relative paths the fixture home tree carries. */
const SYNC_FILES = [".pi/agent/settings.json", "AGENTS.md", "OPINIONS.md", "VOICE.md"];

function sha256Hex(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The fixture manifest: the default scope plus the fixed gist id. The
 * default include patterns cover exactly the files the fixture home tree
 * holds.
 */
export async function syncManifest() {
	const { DEFAULT_MANIFEST } = await import("../../extensions/sync/manifest.ts");
	return { ...DEFAULT_MANIFEST, backendOptions: { ...DEFAULT_MANIFEST.backendOptions, gistId: SYNC_GIST_ID } };
}

/**
 * Build the sync fixture working state in the fixed work root: the home
 * tree (copied from the committed files) and the state dir with the local
 * manifest and Base state that make the device exactly in sync with the
 * fixture gist.
 */
export function buildSyncFixture() {
	const root = join(WORK_ROOT, "sync");
	rmSync(root, { recursive: true, force: true });
	const home = join(root, "home");
	const stateDir = join(root, "state");
	mkdirSync(stateDir, { recursive: true });
	cpSync(join(FIXTURES_ROOT, "sync", "home"), home, { recursive: true });
	return { root, home, stateDir };
}

/**
 * Write the fixture state dir (local manifest copy plus Base state) and
 * return the fixture gist in the GitHub shape the Gist backend reads:
 * the four user files plus the two tool-managed files, all matching the
 * fixture home tree so a status run reports the device as in sync.
 */
export async function syncGistFixture() {
	const { canonicalManifestText, serializeManifest } = await import("../../extensions/sync/manifest.ts");
	const { encodeGistName } = await import("../../extensions/sync/backends/github-gist.ts");
	const { home, stateDir } = buildSyncFixture();

	const manifest = await syncManifest();
	const manifestText = canonicalManifestText(manifest);

	const base = {};
	for (const path of SYNC_FILES) {
		const text = readFileSync(join(home, path), "utf8");
		base[path] = { hash: sha256Hex(text), mtimeMs: SYNC_BASE_MTIME_MS };
	}
	base["__manifest__"] = { hash: sha256Hex(manifestText), mtimeMs: SYNC_BASE_MTIME_MS };
	const baseText = `${JSON.stringify(base, null, 2)}\n`;

	writeFileSync(join(stateDir, "manifest.json"), serializeManifest(manifest));
	writeFileSync(join(stateDir, "base-state.json"), baseText);

	const files = {};
	for (const path of SYNC_FILES) {
		const name = encodeGistName(path);
		files[name] = { filename: path, content: readFileSync(join(home, path), "utf8") };
	}
	files[".pi-sync-manifest.json"] = { filename: ".pi-sync-manifest.json", content: manifestText };
	files[".pi-sync-base-state.json"] = { filename: ".pi-sync-base-state.json", content: baseText };

	return {
		home,
		stateDir,
		gist: {
			id: SYNC_GIST_ID,
			updated_at: new Date(SYNC_BASE_MTIME_MS).toISOString(),
			files,
		},
	};
}

/**
 * A GistTransport that answers only from the fixture gist registered on
 * it. Every other route is a 404. No network.
 */
export function fixtureGistTransport() {
	const gists = {};
	return {
		register(gist) {
			gists[gist.id] = gist;
		},
		async request(method, url, _options) {
			const path = url.replace(/^https?:\/\/[^/]+/, "");
			const match = /^\/gists\/([^/?]+)/.exec(path);
			if (method === "GET" && match && Object.hasOwn(gists, match[1])) {
				return { status: 200, text: JSON.stringify(gists[match[1]]) };
			}
			return { status: 404, text: JSON.stringify({ message: "Not Found" }) };
		},
	};
}

// ---------------------------------------------------------------------------
// initial-context: the /ctx view
// ---------------------------------------------------------------------------

/** The fixture sessions the /ctx tool-usage column scans (fixed 2026 dates). */
export const CONTEXT_SESSIONS_ROOT = join(FIXTURES_ROOT, "initial-context", "sessions");

/**
 * The BuildSystemPromptOptions the /ctx fixture reconstructs. A custom
 * prompt (so no pi-bundled prompt text is involved), an append, one
 * project file, two skills, and the four built-in tools.
 */
export function initialContextOptions() {
	return {
		customPrompt:
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nGuidelines:\n- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed\n- When making technical decisions, prefer quality, simplicity, robustness, and long term maintainability\n- Be concise in your responses",
		appendSystemPrompt: "Always run the tests before committing.",
		cwd: "/home/julian/acme",
		contextFiles: [
			{
				path: "/home/julian/acme/AGENTS.md",
				content:
					"# acme\n\n- Prefer small, boring commits.\n- Lint and test must pass before merge.\n",
			},
		],
		skills: [
			{
				name: "diagnose-crash",
				description: "Diagnose why a program crashed on this machine, from a systemd-coredump core dump.",
				filePath: "/home/julian/.pi/agent/skills/diagnose-crash/SKILL.md",
				baseDir: "/home/julian/.pi/agent/skills/diagnose-crash",
				disableModelInvocation: false,
			},
			{
				name: "omarchy",
				description: "REQUIRED for end-user customization of the Linux desktop, window manager, or system config.",
				filePath: "/home/julian/.pi/agent/skills/omarchy/SKILL.md",
				baseDir: "/home/julian/.pi/agent/skills/omarchy",
				disableModelInvocation: false,
			},
		],
		selectedTools: ["read", "bash", "edit", "write"],
	};
}

// ---------------------------------------------------------------------------
// resource-toggle: the /resources view
// ---------------------------------------------------------------------------

/** The machine the fixture resources resolve against. Fixed fake paths. */
export const RESOURCE_MACHINE = {
	cwd: "/home/julian/acme",
	agentDir: "/home/julian/.pi/agent",
	configDir: ".pi",
};

/** The resource list the /resources view shows. Mixed scopes and states. */
export function resourceInfos() {
	return [
		{
			type: "extensions",
			path: "/home/julian/.pi/agent/extensions/usage/index.ts",
			displayName: "usage",
			scope: "user",
			origin: "local",
			source: "local",
			enabled: false,
			ownEnabled: false,
		},
		{
			type: "extensions",
			path: "/home/julian/.pi/agent/extensions/codegraph/index.ts",
			displayName: "codegraph",
			scope: "user",
			origin: "local",
			source: "local",
			enabled: true,
			ownEnabled: true,
		},
		{
			type: "extensions",
			path: "/home/julian/acme/.pi/extensions/lint-gate/index.ts",
			displayName: "lint-gate",
			scope: "project",
			origin: "local",
			source: "local",
			enabled: true,
			ownEnabled: true,
		},
		{
			type: "skills",
			path: "/home/julian/.pi/agent/skills/omarchy/SKILL.md",
			displayName: "omarchy",
			scope: "user",
			origin: "local",
			source: "local",
			enabled: true,
			ownEnabled: true,
		},
		{
			type: "skills",
			path: "/home/julian/acme/.pi/skills/acme-release/SKILL.md",
			displayName: "acme-release",
			scope: "project",
			origin: "local",
			source: "local",
			enabled: true,
			ownEnabled: true,
		},
		{
			type: "themes",
			path: "/home/julian/.pi/agent/themes/solarized-dark.json",
			displayName: "solarized-dark",
			scope: "user",
			origin: "local",
			source: "local",
			enabled: true,
			ownEnabled: true,
		},
	];
}

/** The settings state behind the fixture list: one disabled extension. */
export function resourceSettings() {
	return {
		global: {
			// Agent-dir-relative pattern, the same spelling pi's settings use.
			extensions: ["!extensions/usage/index.ts"],
			skills: [],
			prompts: [],
			themes: [],
		},
		project: {
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		},
	};
}

// ---------------------------------------------------------------------------
// tools: the /tools list
// ---------------------------------------------------------------------------

/** The tool catalogue the /tools list shows: four built-ins, two extensions. */
export function toolInfos() {
	return [
		{
			name: "read",
			description: "Read the contents of a file. Supports text files and images.",
			parameters: {},
			sourceInfo: { source: "builtin", path: "/home/julian/.pi/agent", scope: "user", origin: "builtin" },
		},
		{
			name: "bash",
			description: "Execute a bash command in the current working directory.",
			parameters: {},
			sourceInfo: { source: "builtin", path: "/home/julian/.pi/agent", scope: "user", origin: "builtin" },
		},
		{
			name: "edit",
			description: "Make precise file edits with exact text replacement.",
			parameters: {},
			sourceInfo: { source: "builtin", path: "/home/julian/.pi/agent", scope: "user", origin: "builtin" },
		},
		{
			name: "write",
			description: "Write content to a file. Creates the file if it does not exist.",
			parameters: {},
			sourceInfo: { source: "builtin", path: "/home/julian/.pi/agent", scope: "user", origin: "builtin" },
		},
		{
			name: "resource_toggle",
			description: "Enable or disable pi resources (extensions, skills, prompt templates, themes).",
			parameters: {},
			sourceInfo: { source: "local", path: "/home/julian/.pi/agent/extensions/resource-toggle/index.ts", scope: "user", origin: "local" },
		},
		{
			name: "web_search",
			description: "Search the web and get synthesized answers with source citations.",
			parameters: {},
			sourceInfo: { source: "local", path: "/home/julian/acme/.pi/extensions/lint-gate/web-search.ts", scope: "project", origin: "local" },
		},
	];
}

// ---------------------------------------------------------------------------
// usage: the /usage TUI and the pi-usage CLI
// ---------------------------------------------------------------------------

/** The committed session tree the usage scans read (three files, 2,900 tokens). */
export const USAGE_SESSIONS_ROOT = join(FIXTURES_ROOT, "usage-sessions");

// ---------------------------------------------------------------------------
// codegraph: the /codegraph status in a real session
// ---------------------------------------------------------------------------

/** The committed fixture repository the codegraph capture indexes. */
export const CODEGRAPH_REPO_ROOT = join(FIXTURES_ROOT, "codegraph-repo");

/** Copy the fixture repo to the fixed work root (where git init runs). */
export function buildCodegraphFixture() {
	const root = join(WORK_ROOT, "codegraph", "repo");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(dirname(root), { recursive: true });
	cpSync(CODEGRAPH_REPO_ROOT, root, { recursive: true });
	return root;
}

// ---------------------------------------------------------------------------
// mock model: the provider the model-router and context-cap captures use
// ---------------------------------------------------------------------------

/** The extension file that registers the "mock" provider. */
export const MOCK_PROVIDER_EXTENSION = join(FIXTURES_ROOT, "mock-provider", "mock-provider.mjs");
