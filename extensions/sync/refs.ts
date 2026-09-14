/**
 * Reference scanner: catches a dropped cross-reference the moment it
 * happens. Scans the synced markdown files for home-directory references
 * ("~/path") and relative markdown link targets. A target that resolves
 * outside the Snapshot produces a warning. The scanner never adds paths to
 * the manifest - the manifest stays the single source of truth.
 */
import type { SyncFile } from "./types.ts";

export interface RefWarning {
	/** The synced markdown file that holds the reference. */
	file: string;
	/** The reference as written in the file. */
	target: string;
	/** The home-relative path the reference resolves to. */
	resolved: string;
}

const HOME_REF = /~\/[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*/g;
const MD_LINK = /\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

function isExternal(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#");
}

/** Extract the path a reference in `file` resolves to, or null when it is not a checkable path. */
function resolveRef(file: string, rawTarget: string): string | null {
	let target = rawTarget.split(/[?#]/, 1)[0];
	if (target === "" || target === ".") return null;
	if (isExternal(target)) return null;
	if (target.startsWith("~")) return target.slice(1).replace(/^\//, "");
	if (target.startsWith("/")) return null; // absolute path outside home: not checkable here
	// Relative to the file's directory.
	const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
	const joined = dir === "" ? target : `${dir}/${target}`;
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null; // escapes the home directory
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

/** Covered means an in-snapshot file at the path, or under it (a directory). */
function isCovered(resolved: string, snapshotPaths: Set<string>): boolean {
	if (snapshotPaths.has(resolved)) return true;
	const prefix = `${resolved}/`;
	for (const path of snapshotPaths) {
		if (path.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Scan the synced markdown files. Returns one warning per reference that
 * resolves to a path the Snapshot does not cover.
 */
export function scanReferences(files: SyncFile[]): RefWarning[] {
	const snapshotPaths = new Set(files.map((f) => f.path));
	const warnings: RefWarning[] = [];
	const seen = new Set<string>();

	for (const file of files) {
		if (!file.path.endsWith(".md")) continue;
		const targets: string[] = [];
		for (const match of file.content.matchAll(HOME_REF)) targets.push(match[0]);
		for (const match of file.content.matchAll(MD_LINK)) targets.push(match[1]);

		for (const raw of targets) {
			const resolved = resolveRef(file.path, raw);
			if (resolved === null) continue;
			const key = `${file.path}\u0000${resolved}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (!isCovered(resolved, snapshotPaths)) {
				warnings.push({ file: file.path, target: raw, resolved });
			}
		}
	}
	return warnings.sort((a, b) => (a.file + a.resolved).localeCompare(b.file + b.resolved));
}
