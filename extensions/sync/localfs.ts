/**
 * Local tree access for sync: collecting the local Snapshot from the home
 * directory, reading and writing the local (tool-managed) manifest copy, and
 * applying a merge plan.
 *
 * Collecting walks only the roots the include patterns imply, never the whole
 * home. Symlinks are never followed. Directories named node_modules or .git
 * are never descended into. Files ending in ".bak" are the tool's own backup
 * files and are never collected.
 *
 * Applying a plan is all-or-nothing per run: every read and hash happens
 * before the first write, backups are written before the files they protect,
 * and each file is replaced by write-then-rename so a file is never seen
 * half-written.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { isUtf8, sha256Hex } from "./hash.ts";
import { canonicalManifestText, isPathIncluded, parseManifest, serializeManifest, walkRoots } from "./manifest.ts";
import type { MergePlan } from "./merge.ts";
import { MANIFEST_KEY, type BaseState, type SyncFile, type SyncManifest, type SyncPath } from "./types.ts";

/** Backup files are named "<path>.<millis>.bak" next to the file they protect. */
export function backupNameFor(path: string, stampMs: number): string {
	return `${path}.${stampMs}.bak`;
}

export { sha256Hex };

/** Convert a path under home to a home-relative POSIX path. */
export function toHomeRelative(fullPath: string, home: string): string {
	const relative = fullPath.startsWith(home + sep) ? fullPath.slice(home.length + 1) : fullPath;
	return relative.split(sep).join("/");
}

export interface LocalCollection {
	files: SyncFile[];
	warnings: string[];
}

const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git"]);

/** Collect the local Snapshot: the in-scope files under the manifest roots. */
export async function collectLocalFiles(manifest: SyncManifest, home: string): Promise<LocalCollection> {
	const files: SyncFile[] = [];
	const warnings: string[] = [];
	for (const root of walkRoots(manifest)) {
		const fullRoot = root === "" ? home : join(home, ...root.split("/"));
		let rootStat;
		try {
			rootStat = await stat(fullRoot);
		} catch {
			continue; // root does not exist on this device: nothing to collect
		}
		if (rootStat.isFile()) {
			await collectFile(fullRoot, home, manifest, files, warnings);
			continue;
		}
		if (rootStat.isDirectory()) {
			await walk(fullRoot, home, manifest, files, warnings);
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return { files, warnings };
}

async function walk(dir: string, home: string, manifest: SyncManifest, files: SyncFile[], warnings: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
			await walk(full, home, manifest, files, warnings);
		} else if (entry.isFile()) {
			await collectFile(full, home, manifest, files, warnings);
		}
	}
}

async function collectFile(full: string, home: string, manifest: SyncManifest, files: SyncFile[], warnings: string[]): Promise<void> {
	const relative = toHomeRelative(full, home);
	if (relative.endsWith(".bak")) return; // the tool's own backups never sync
	if (!isPathIncluded(relative, manifest)) return;
	let buffer: Buffer;
	let mtimeMs: number;
	try {
		buffer = await readFile(full);
		mtimeMs = (await stat(full)).mtimeMs;
	} catch {
		return; // unreadable file: skip rather than fail the run
	}
	if (!isUtf8(buffer)) {
		warnings.push(`skipped non-text file (gists are text only): ${relative}`);
		return;
	}
	const content = buffer.toString("utf8");
	files.push({ path: relative, content, mtimeMs, hash: sha256Hex(content) });
}

/** The local copy of the tool-managed Sync manifest. */
export function manifestPathIn(stateDir: string): string {
	return join(stateDir, "manifest.json");
}

export async function readLocalManifest(stateDir: string): Promise<{ manifest?: SyncManifest; error?: string }> {
	try {
		const text = await readFile(manifestPathIn(stateDir), "utf8");
		const parsed = parseManifest(text);
		if (parsed.ok) return { manifest: parsed.manifest };
		return { error: parsed.error };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: `cannot read ${manifestPathIn(stateDir)}: ${String(err)}` };
	}
}

/** Write the local manifest copy owner-only. */
export async function writeLocalManifest(stateDir: string, manifest: SyncManifest): Promise<void> {
	const path = manifestPathIn(stateDir);
	await mkdir(stateDir, { recursive: true });
	await writeFile(path, serializeManifest(manifest), { mode: 0o600 });
}

/**
 * The device-local Base state: the Base this device last synced, kept
 * owner-only in the state directory. The shared Base in the Backend advances
 * with every push, so a device that has not pulled yet must merge against the
 * Base it last saw, not the newest one. "Changed" always means "differs from
 * this record".
 */
export function localBasePath(stateDir: string): string {
	return join(stateDir, "base-state.json");
}

export async function readLocalBase(stateDir: string): Promise<{ base?: BaseState; error?: string }> {
	try {
		const text = await readFile(localBasePath(stateDir), "utf8");
		const data: unknown = JSON.parse(text);
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return { error: `${localBasePath(stateDir)} is not a Base state object` };
		}
		const base: BaseState = {};
		for (const [path, entry] of Object.entries(data as Record<string, unknown>)) {
			if (!entry || typeof entry !== "object" || typeof (entry as BaseEntryLike).hash !== "string" || typeof (entry as BaseEntryLike).mtimeMs !== "number") {
				return { error: `${localBasePath(stateDir)} has a malformed entry for ${path}` };
			}
			const e = entry as BaseEntryLike;
			base[path] = { hash: e.hash, mtimeMs: e.mtimeMs, ...(e.deleted ? { deleted: true } : {}) };
		}
		return { base };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		return { error: `cannot read ${localBasePath(stateDir)}: ${String(err)}` };
	}
}

interface BaseEntryLike {
	hash: string;
	mtimeMs: number;
	deleted?: boolean;
}

/** Write the device-local Base state owner-only. */
export async function writeLocalBase(stateDir: string, base: BaseState): Promise<void> {
	const path = localBasePath(stateDir);
	await mkdir(stateDir, { recursive: true });
	await writeFile(path, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
}

/** The local manifest as a merge side: canonical content plus file mtime. */
export async function localManifestFile(manifest: SyncManifest, stateDir: string): Promise<SyncFile | null> {
	const path = manifestPathIn(stateDir);
	try {
		const fileStat = await stat(path);
		if (!fileStat.isFile()) return null;
	} catch {
		return null; // no local copy yet: the manifest is not part of the local tree
	}
	const text = serializeManifest(manifest);
	// Hash identity ignores the device-local gist id (see canonicalManifestText).
	return { path: MANIFEST_KEY, content: text, mtimeMs: (await stat(path)).mtimeMs, hash: sha256Hex(canonicalManifestText(manifest)) };
}

export interface ApplyResult {
	/** The backup files written: which merge path they protect and where. */
	backups: { forPath: SyncPath; backupPath: string }[];
}

/**
 * Apply a merge plan to the local tree. `resolvePath` maps an abstract merge
 * path (home-relative, or MANIFEST_KEY for the local manifest copy) to an
 * absolute path.
 */
export async function applyPlan(
	plan: MergePlan,
	home: string,
	stateDir: string,
	stamp: () => number = () => Date.now(),
): Promise<ApplyResult> {
	const resolvePath = (path: SyncPath): string =>
		path === MANIFEST_KEY ? join(stateDir, "manifest.json") : join(home, ...path.split("/"));

	const backups: ApplyResult["backups"] = [];
	// Backups first: a loser is always on disk before its file changes.
	for (const action of plan.actions) {
		if (action.kind !== "backup") continue;
		const target = `${resolvePath(action.path)}.${stamp()}.bak`;
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, action.content, { mode: 0o600 });
		backups.push({ forPath: action.path, backupPath: target });
	}
	// Then the file replacements: write a sibling temp file, rename over.
	for (const action of plan.actions) {
		if (action.kind !== "write") continue;
		const target = resolvePath(action.path);
		await mkdir(dirname(target), { recursive: true });
		const temp = `${target}.sync-tmp-${process.pid}`;
		await writeFile(temp, action.content, { mode: 0o600 });
		await rename(temp, target);
		const seconds = action.mtimeMs / 1000;
		await utimes(target, seconds, seconds);
	}
	// Finally the deletions.
	for (const action of plan.actions) {
		if (action.kind !== "delete") continue;
		try {
			await unlink(resolvePath(action.path));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	return { backups };
}
