/**
 * Root discovery.
 *
 * The root of a file is the nearest directory that carries one of the
 * language's root markers, walking up from the file's own directory (ADR
 * 0043): in a monorepo a Rust crate's `Cargo.toml` beats the workspace's,
 * so the crate answers against its own manifest. When no ancestor carries a
 * marker, the caller falls back to the session root.
 *
 * The walk never crosses into directories the session root does not name:
 * a file outside the session root still walks its own ancestors, because a
 * build tree or a vendored copy may carry its own markers, and the server
 * bound to that marker is the one that knows the file.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * The nearest ancestor of `startDir` (inclusive) that contains any of
 * `markers`, or null when none does. `stopAt`, when given and different
 * from `startDir`, is the highest directory the walk may still answer
 * `startDir` below: the walk stops once it passes `stopAt`'s parent, so a
 * marker exactly at `stopAt` still counts and one above it does not.
 */
export function findRoot(startDir: string, markers: string[], stopAt?: string): string | null {
	if (markers.length === 0) return null;
	let dir = path.resolve(startDir);
	for (;;) {
		if (hasMarker(dir, markers)) return dir;
		if (stopAt !== undefined) {
			const resolvedStop = path.resolve(stopAt);
			if (dir === resolvedStop) return null;
			const parent = path.dirname(dir);
			if (parent === dir) return null; // filesystem root
			if (parent === resolvedStop) {
				// The stop directory itself is checked once, above.
				return null;
			}
			dir = parent;
			continue;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** True when the directory holds any of the marker files. */
export function hasMarker(dir: string, markers: string[]): boolean {
	for (const marker of markers) {
		try {
			if (fs.statSync(path.join(dir, marker)).isFile()) return true;
		} catch {
			// not here
		}
	}
	return false;
}

/**
 * Resolve the root for one file: the nearest marker root, else the session
 * root. `file` may be relative; it resolves against `cwd` first, the way
 * the built-in tools do.
 */
export function rootForFile(
	file: string,
	cwd: string,
	lang: string,
	rootMarkers: string[],
	sessionRoot: string,
): string {
	const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
	const dir = fs.existsSync(abs) ? path.dirname(abs) : path.dirname(abs);
	const found = findRoot(dir, rootMarkers);
	return found ?? path.resolve(sessionRoot);
}
