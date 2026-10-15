/**
 * The watcher policy (ADR 0042).
 *
 * The watcher discovers: one recursive `fs.watch` per served root records
 * changed paths for the Changed set and re-syncs the documents that are
 * already open. It never verifies: the stat check does.
 *
 * The degradation policy copies codegraph's watcher module: a thrown start
 * or a runtime `error` callback drops the root to the stat-pass fallback,
 * `LSP_NO_WATCH=1` opts out, the home directory is never watched, and a
 * WSL2 `/mnt` root is never watched (recursive inotify on a 9p drive is
 * pathologically slow).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WatcherState = "active" | "degraded" | "disabled" | "off";

/** One event flush per burst of file changes. */
export const WATCH_DEBOUNCE_MS = 1000;

/** The directory names the watcher filters out of every event path. */
export const EXCLUDED_DIRS = [".git", "node_modules", "target", "build", "dist", ".venv", "__pycache__", ".codegraph"];

let wslCache: boolean | undefined;
function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
	if (wslCache === undefined) {
		wslCache = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTERACTIVE);
		if (!wslCache) {
			try {
				wslCache = /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf-8"));
			} catch {
				// not WSL
			}
		}
	}
	return wslCache;
}

/** Clear the WSL detection cache (for tests, so env changes take effect). */
export function resetWslCache(): void {
	wslCache = undefined;
}

/**
 * Why this root must not be watched, or null when it may be. The home
 * directory is never a served root (servers bind to project roots), but a
 * settings override could name one, so the policy refuses it here rather
 * than in the caller.
 */
export function watchDisabledReason(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.LSP_NO_WATCH === "1") return "LSP_NO_WATCH=1";
	const home = env.HOME || os.homedir();
	if (root === path.resolve(home)) return "home directory";
	if (isWsl(env) && root.startsWith("/mnt/")) return "WSL2 /mnt drive";
	return null;
}

/**
 * True when any segment of the path below `root` is an excluded directory.
 * The filter is on the segment names, so a file inside `build/` of a nested
 * package is excluded exactly like one inside the top-level `build/`. A
 * path outside the root is not filtered: the servers that bind that root
 * still own it.
 */
export function isExcludedPath(root: string, file: string): boolean {
	const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
	if (rel === "") return false;
	if (rel.startsWith("..")) return false;
	const segments = rel.split(path.sep);
	for (const segment of segments) {
		if (EXCLUDED_DIRS.includes(segment)) return true;
	}
	return false;
}

export interface RootWatcherHooks {
	/** A debounced batch of changed paths, exclusion-filtered. */
	onEvents: (paths: string[]) => void;
	/** The watcher degraded at runtime with this reason. */
	onDegraded: (reason: string) => void;
}

export interface RootWatcher {
	readonly state: WatcherState;
	stop: () => void;
}

/**
 * Start the recursive watch of one root. Never throws: a thrown start or
 * an unsupported filesystem degrades instead, and the caller runs the
 * stat-pass fallback. The `error` event degrades the same way at runtime.
 */
export function startRootWatcher(root: string, hooks: RootWatcherHooks, env: NodeJS.ProcessEnv = process.env): RootWatcher {
	const disabled = watchDisabledReason(root, env);
	if (disabled) return { state: "disabled", stop: () => undefined };

	let watcher: fs.FSWatcher | null = null;
	let pending = new Set<string>();
	let timer: NodeJS.Timeout | null = null;
	let stopped = false;

	const degraded: RootWatcher = {
		state: "degraded",
		stop: () => stopNow(),
	};

	function stopNow(): void {
		if (stopped) return;
		stopped = true;
		if (timer) clearTimeout(timer);
		try {
			watcher?.close();
		} catch {
			// already closed
		}
		watcher = null;
	}

	function degrade(reason: string): RootWatcher {
		stopNow();
		hooks.onDegraded(reason);
		return degraded;
	}

	try {
		watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
			if (filename === null || stopped) return;
			const file = path.isAbsolute(String(filename)) ? String(filename) : path.join(root, String(filename));
			if (isExcludedPath(root, file)) return;
			pending.add(file);
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				const paths = [...pending];
				pending = new Set();
				if (paths.length > 0) hooks.onEvents(paths);
			}, WATCH_DEBOUNCE_MS);
			// A burst must not hold the process open on its own.
			timer.unref?.();
		});
	} catch (err) {
		return degrade(err instanceof Error ? err.message : String(err));
	}
	if (watcher === null) return degrade("watcher failed to start");
	watcher.on("error", (err) => {
		// The error handler cannot return through the start path; report
		// the degradation and stop the broken watcher.
		stopNow();
		hooks.onDegraded(err.message);
	});

	return {
		state: "active",
		stop: () => stopNow(),
	};
}
