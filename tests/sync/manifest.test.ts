import { describe, expect, it } from "vitest";

import {
	DEFAULT_MANIFEST,
	canonicalManifestText,
	globToRegExp,
	isPathIncluded,
	normalizePattern,
	parseManifest,
	serializeManifest,
	walkRoots,
} from "../../extensions/sync/manifest.ts";

const manifest = (include: string[], exclude: string[] = []) => ({
	v: 1 as const,
	backend: "github-gist",
	backendOptions: {},
	include,
	exclude,
});

describe("manifest hash identity", () => {
	it("ignores the device-local gist id", () => {
		const shared = manifest(["AGENTS.md"]);
		const withId = { ...shared, backendOptions: { gistId: "gid-1" } };
		expect(canonicalManifestText(shared)).toBe(canonicalManifestText(withId));
		expect(canonicalManifestText(shared)).not.toBe(serializeManifest(withId));
	});
});

describe("globToRegExp", () => {
	it("matches an exact path", () => {
		expect(globToRegExp(".pi/agent/settings.json").test(".pi/agent/settings.json")).toBe(true);
		expect(globToRegExp(".pi/agent/settings.json").test(".pi/agent/settings.old.json")).toBe(false);
	});

	it("treats dots as literals, not regex wildcards", () => {
		expect(globToRegExp(".pi/agent/*.json").test(".pi/agent/models.json")).toBe(true);
		expect(globToRegExp(".pi/agent/*.json").test("Xpi/agent/models.json")).toBe(false);
	});

	it("matches * within one directory only", () => {
		expect(globToRegExp(".pi/agent/skills/*.md").test(".pi/agent/skills/SKILL.md")).toBe(true);
		expect(globToRegExp(".pi/agent/skills/*.md").test(".pi/agent/skills/nested/SKILL.md")).toBe(false);
	});

	it("matches ** across directories and the empty prefix", () => {
		expect(globToRegExp(".pi/agent/skills/**").test(".pi/agent/skills/a/SKILL.md")).toBe(true);
		expect(globToRegExp(".pi/agent/skills/**").test(".pi/agent/skills/a/b/c.md")).toBe(true);
		expect(globToRegExp("**/AGENTS.md").test("AGENTS.md")).toBe(true);
		expect(globToRegExp("**/AGENTS.md").test("sub/AGENTS.md")).toBe(true);
		expect(globToRegExp("**/AGENTS.md").test("NOTES.md")).toBe(false);
	});

	it("matches ? as one character", () => {
		expect(globToRegExp(".pi/agent/models.?son").test(".pi/agent/models.json")).toBe(true);
		expect(globToRegExp(".pi/agent/models.?son").test(".pi/agent/models.old.json")).toBe(false);
	});
});

describe("isPathIncluded (default deny)", () => {
	it("denies everything with no include patterns", () => {
		expect(isPathIncluded("AGENTS.md", manifest([]))).toBe(false);
	});

	it("includes a file when a pattern matches its path", () => {
		expect(isPathIncluded("AGENTS.md", manifest(["AGENTS.md"]))).toBe(true);
		expect(isPathIncluded("OPINIONS.md", manifest(["AGENTS.md"]))).toBe(false);
	});

	it("includes a whole directory when a pattern matches the directory (skills as whole directories)", () => {
		const m = manifest([".pi/agent/skills"]);
		expect(isPathIncluded(".pi/agent/skills/tdd/SKILL.md", m)).toBe(true);
		expect(isPathIncluded(".pi/agent/skills/tdd/reporting.md", m)).toBe(true);
		expect(isPathIncluded(".pi/agent/skillsx/tdd/SKILL.md", m)).toBe(false);
	});

	it("lets exclude patterns win over include patterns", () => {
		const m = manifest([".pi/agent/**"], [".pi/agent/skills/secret/SKILL.md"]);
		expect(isPathIncluded(".pi/agent/skills/secret/SKILL.md", m)).toBe(false);
		expect(isPathIncluded(".pi/agent/skills/open/SKILL.md", m)).toBe(true);
	});

	it("lets an exclude directory win over an include file", () => {
		const m = manifest([".pi/agent/auth.json"], [".pi/agent/auth.json"]);
		expect(isPathIncluded(".pi/agent/auth.json", m)).toBe(false);
	});

	it("rejects patterns that escape the home directory", () => {
		expect(normalizePattern("../etc/passwd")).toBeNull();
		expect(normalizePattern(".pi/../../etc/passwd")).toBeNull();
		expect(normalizePattern("/etc/passwd")).toBeNull();
		expect(normalizePattern("./AGENTS.md")).toBe("AGENTS.md");
	});
});

describe("the default manifest", () => {
	it("includes the settings, extensions, skills, themes, models, web-search config, and the three home md files", () => {
		const cases: [string, boolean][] = [
			[".pi/agent/settings.json", true],
			[".pi/agent/extensions/quota/index.ts", true],
			[".pi/agent/skills/tdd/SKILL.md", true],
			[".pi/agent/themes/dark.json", true],
			[".pi/agent/models.json", true],
			[".pi/agent/models-store.json", true],
			[".pi/web-search.json", true],
			["AGENTS.md", true],
			["OPINIONS.md", true],
			["VOICE.md", true],
		];
		for (const [path, expected] of cases) {
			expect(isPathIncluded(path, DEFAULT_MANIFEST), path).toBe(expected);
		}
	});

	it("keeps secrets, sessions, and package-managed installs out", () => {
		const cases: string[] = [
			".pi/agent/auth.json",
			".pi/agent/sessions/abc/session.jsonl",
			".pi/agent/npm/some-pkg/index.ts",
			".pi/agent/git/some-repo/index.ts",
			".pi/agent/bin/rg",
			".pi/agent/trust.json",
			".pi/agent/pi-debug.log",
			".pi/agent/models.old.json",
			"NOTES.md",
		];
		for (const path of cases) {
			expect(isPathIncluded(path, DEFAULT_MANIFEST), path).toBe(false);
		}
	});

	it("excludes would win even if a wide include is added", () => {
		const wide = { ...DEFAULT_MANIFEST, include: [...DEFAULT_MANIFEST.include, ".pi/agent/**"] };
		expect(isPathIncluded(".pi/agent/auth.json", wide)).toBe(false);
		expect(isPathIncluded(".pi/agent/sessions/a/session.jsonl", wide)).toBe(false);
		expect(isPathIncluded(".pi/agent/tools/my-tool.json", wide)).toBe(true);
	});
});

describe("walkRoots", () => {
	it("derives the directories and files to walk from the include patterns", () => {
		expect(walkRoots(DEFAULT_MANIFEST)).toEqual([
			".pi/agent/extensions",
			".pi/agent/models-store.json",
			".pi/agent/models.json",
			".pi/agent/settings.json",
			".pi/agent/skills",
			".pi/agent/themes",
			".pi/web-search.json",
			"AGENTS.md",
			"OPINIONS.md",
			"VOICE.md",
		]);
	});

	it("walks the home when a pattern starts with **", () => {
		expect(walkRoots(manifest(["**/*.md"]))).toEqual([""]);
	});
});

describe("parseManifest", () => {
	it("round-trips a manifest", () => {
		const parsed = parseManifest(serializeManifest(DEFAULT_MANIFEST));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest).toEqual(DEFAULT_MANIFEST);
	});

	it("fills backendOptions with an empty object when absent", () => {
		const parsed = parseManifest(JSON.stringify({ v: 1, backend: "github-gist", include: [], exclude: [] }));
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.manifest.backendOptions).toEqual({});
	});

	it("rejects a wrong version", () => {
		const parsed = parseManifest(JSON.stringify({ v: 2, backend: "x", include: [] }));
		expect(parsed.ok).toBe(false);
	});

	it("rejects a missing backend", () => {
		const parsed = parseManifest(JSON.stringify({ v: 1, include: [] }));
		expect(parsed.ok).toBe(false);
	});

	it("rejects non-string patterns", () => {
		const parsed = parseManifest(JSON.stringify({ v: 1, backend: "x", include: [123] }));
		expect(parsed.ok).toBe(false);
	});

	it("rejects patterns that escape the home directory", () => {
		const parsed = parseManifest(JSON.stringify({ v: 1, backend: "x", include: ["../etc/passwd"] }));
		expect(parsed.ok).toBe(false);
	});

	it("rejects invalid JSON", () => {
		const parsed = parseManifest("{ no json");
		expect(parsed.ok).toBe(false);
	});
});
