/**
 * Sync manifest: shape, defaults, validation, and pattern selection.
 *
 * Default deny: a file is in scope only when an include pattern matches its
 * path or one of its ancestor directories, and no exclude pattern matches.
 * Excludes win over includes. A pattern that matches a directory therefore
 * takes the whole directory, which is how skills and extensions sync as
 * whole directories.
 */
import type { SyncManifest } from "./types.ts";

/**
 * The default Snapshot: the pi settings, local extensions, skills, themes,
 * the models file and models store, the web-search extension config, and the
 * three home agent md files. Excludes name the things a wide include must
 * never drag in: secrets, sessions, caches, and package-managed installs
 * (those self-sync through their own packages).
 */
export const DEFAULT_MANIFEST: SyncManifest = {
	v: 1,
	backend: "github-gist",
	backendOptions: { gistId: "" },
	include: [
		".pi/agent/settings.json",
		".pi/agent/extensions/**",
		".pi/agent/skills/**",
		".pi/agent/themes/**",
		".pi/agent/models.json",
		".pi/agent/models-store.json",
		".pi/web-search.json",
		"AGENTS.md",
		"OPINIONS.md",
		"VOICE.md",
	],
	exclude: [
		".pi/agent/auth.json",
		".pi/agent/sessions/**",
		".pi/agent/npm/**",
		".pi/agent/git/**",
		".pi/agent/bin/**",
		".pi/agent/trust.json",
		".pi/agent/*-debug.log",
	],
};

export type ManifestParse =
	| { ok: true; manifest: SyncManifest }
	| { ok: false; error: string };

/** Parse and validate a Sync manifest from its JSON text. */
export function parseManifest(text: string): ManifestParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: `sync manifest is not valid JSON: ${String(err)}` };
	}
	if (typeof raw !== "object" || raw === null) {
		return { ok: false, error: "sync manifest must be a JSON object" };
	}
	const data = raw as Record<string, unknown>;
	if (data.v !== 1) {
		return { ok: false, error: `unsupported sync manifest version: ${String(data.v)}` };
	}
	if (typeof data.backend !== "string" || data.backend.length === 0) {
		return { ok: false, error: "sync manifest field \"backend\" must be a non-empty string" };
	}
	const backendOptions: Record<string, string> = {};
	if (data.backendOptions !== undefined) {
		if (typeof data.backendOptions !== "object" || data.backendOptions === null || Array.isArray(data.backendOptions)) {
			return { ok: false, error: "sync manifest field \"backendOptions\" must be an object of strings" };
		}
		for (const [key, value] of Object.entries(data.backendOptions as Record<string, unknown>)) {
			if (typeof value !== "string") {
				return { ok: false, error: `sync manifest backendOptions.${key} must be a string` };
			}
			backendOptions[key] = value;
		}
	}
	const include = readPatterns(data.include, "include");
	if (!include.ok) return { ok: false, error: include.error };
	const exclude = readPatterns(data.exclude ?? [], "exclude");
	if (!exclude.ok) return { ok: false, error: exclude.error };
	for (const pattern of [...include.patterns, ...exclude.patterns]) {
		const bad = validatePattern(pattern);
		if (bad) return { ok: false, error: bad };
	}
	return { ok: true, manifest: { v: 1, backend: data.backend, backendOptions, include: include.patterns, exclude: exclude.patterns } };
}

/** Serialize a Sync manifest to its canonical JSON text. */
export function serializeManifest(manifest: SyncManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The manifest without the device-local gist id. The id is only known after the
 * gist is created, so a manifest differing only in backendOptions.gistId is the
 * same shared manifest. Hash identity and the shared gist file use this form.
 */
export function canonicalManifest(manifest: SyncManifest): SyncManifest {
	const options = { ...(manifest.backendOptions ?? {}) };
	delete options.gistId;
	return { ...manifest, backendOptions: options };
}

/** Canonical (gist-id-free) JSON text used for manifest hash identity. */
export function canonicalManifestText(manifest: SyncManifest): string {
	return serializeManifest(canonicalManifest(manifest));
}

function readPatterns(raw: unknown, field: string): { ok: true; patterns: string[] } | { ok: false; error: string } {
	if (!Array.isArray(raw)) {
		return { ok: false, error: `sync manifest field "${field}" must be an array of strings` };
	}
	const patterns: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0) {
			return { ok: false, error: `sync manifest field "${field}" must hold only non-empty strings` };
		}
		patterns.push(entry);
	}
	return { ok: true, patterns };
}

/** Reject patterns that could address paths outside the home directory. */
function validatePattern(pattern: string): string | null {
	const normalized = normalizePattern(pattern);
	if (normalized === null) return `sync manifest pattern escapes the home directory: ${pattern}`;
	if (/[\\]/.test(pattern)) return `sync manifest pattern must use forward slashes: ${pattern}`;
	if (/[{}]/.test(pattern)) return `sync manifest pattern uses braces, which are not supported: ${pattern}`;
	return null;
}

/** Strip a leading "./". Returns null when the result would escape home. */
export function normalizePattern(pattern: string): string | null {
	let normalized = pattern.trim();
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (normalized.startsWith("/") || normalized === "") return null;
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
	return normalized;
}

/**
 * Compile a home-relative glob pattern. Supports the double-star (any path
 * or any directory prefix), the single star (within one directory), and
 * the question mark (one character). Dots are literals.
 */
export function globToRegExp(pattern: string): RegExp {
	const source = normalizePattern(pattern) ?? pattern;
	let out = "^";
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === "*") {
			if (source[i + 1] === "*") {
				if (source[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
				continue;
			}
			out += "[^/]*";
			continue;
		}
		if (char === "?") {
			out += "[^/]";
			continue;
		}
		out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${out}$`);
}

function matchPattern(pattern: string, path: string): boolean {
	return globToRegExp(pattern).test(path);
}

/** True when the pattern matches the path or any proper ancestor directory. */
function patternCovers(path: string, pattern: string): boolean {
	if (matchPattern(pattern, path)) return true;
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++) {
		if (matchPattern(pattern, parts.slice(0, i).join("/"))) return true;
	}
	return false;
}

/** Default deny: an include must cover the path and no exclude may. */
export function isPathIncluded(path: string, manifest: SyncManifest): boolean {
	if (manifest.exclude.some((pattern) => patternCovers(path, pattern))) return false;
	return manifest.include.some((pattern) => patternCovers(path, pattern));
}

/**
 * The home-relative roots a collector must walk for this manifest: the
 * longest non-glob prefix of every include pattern. "" is the home itself.
 */
export function walkRoots(manifest: SyncManifest): string[] {
	const roots = new Set<string>();
	for (const raw of manifest.include) {
		const pattern = normalizePattern(raw);
		if (pattern === null) continue;
		const plain: string[] = [];
		for (const segment of pattern.split("/")) {
			if (segment.includes("*") || segment.includes("?")) break;
			plain.push(segment);
		}
		roots.add(plain.join("/"));
	}
	return [...roots].sort();
}
