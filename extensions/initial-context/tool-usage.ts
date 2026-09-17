/**
 * Tool usage: how often each tool was called across all pi sessions.
 *
 * A tool call is a `toolCall` item inside an assistant message entry in a
 * session file. Forked sessions copy their ancestor's lines byte-identical,
 * so a line counts once: the scan keeps the hashes of the lines that carried
 * a tool call and skips a line whose hash the pass already saw (ADR 0009).
 *
 * The scan is derived, never a source of truth (ADR 0014). A per-file cache
 * keyed on mtime + size makes every open after the first near instant: an
 * unchanged file is served from the cache, a changed file is re-parsed, and
 * window switches filter cached events without any re-scan.
 */
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultSessionsRoot, listSessionFiles, readSessionText } from "../shared/sessions.ts";

/** The count windows. The default is the last 30 days. */
export type ToolUsageWindow = "30d" | "90d" | "all";

export const TOOL_USAGE_WINDOWS: readonly ToolUsageWindow[] = ["30d", "90d", "all"];

export function parseToolUsageWindow(arg: string | undefined): ToolUsageWindow | undefined {
	if (arg === "30d" || arg === "90d" || arg === "all") return arg;
	return undefined;
}

const DAY_MS = 86_400_000;

/** The window's start in epoch ms. "all" has no start. */
export function windowStart(window: ToolUsageWindow, now: number): number | undefined {
	if (window === "all") return undefined;
	return now - DAY_MS * (window === "30d" ? 30 : 90);
}

/**
 * The count key for one tool call. MCP calls split by subtool: a call with
 * `arguments.tool` counts as `mcp:<tool>`; the other mcp ops (`connect`,
 * `describe`, `search`) count as plain `mcp`.
 */
export function toolCallKey(name: string, args: unknown): string {
	if (name === "mcp") {
		const tool = (args as { tool?: unknown } | null)?.tool;
		if (typeof tool === "string" && tool.length > 0) return `mcp:${tool}`;
	}
	return name;
}

/**
 * The skill keys a tool call loads. The agent uses a skill by reading its
 * SKILL.md, so any call whose arguments reference `/<name>/SKILL.md` counts
 * for that skill row. A rough proxy: it counts the load, not the outcome.
 */
export function skillKeysFor(args: unknown): string[] {
	let text: string;
	try {
		text = typeof args === "string" ? args : JSON.stringify(args ?? "");
	} catch {
		return [];
	}
	const out = new Set<string>();
	for (const match of text.matchAll(/\/([A-Za-z0-9._-]+)\/SKILL\.md/g)) {
		out.add(`skill:${match[1]}`);
	}
	return [...out];
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** One cached session file. */
interface FileCache {
	/** The stat the counts were computed from. */
	mtimeMs: number;
	size: number;
	/** All-time tool call counts for this file. */
	counts: Record<string, number>;
	/** Events inside the newest 90 days at scan time: [epoch ms, key]. */
	recent: [number, string][];
	/** Hashes of the lines that carried a tool call (fork dedupe). */
	lineHashes: string[];
}

/** The whole cache. A pure function of the session files. */
interface ToolUsageCache {
	/** Cache format version; a mismatch reads as an empty cache. */
	v: 2;
	files: Record<string, FileCache>;
}

/** Environment override for the cache file (tests point it at a temp file). */
export const TOOL_USAGE_CACHE_ENV = "PI_TOOL_USAGE_CACHE";

export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env): string {
	return env[TOOL_USAGE_CACHE_ENV] || join(homedir(), ".pi", "agent", "tool-usage-cache.json");
}

/**
 * A 64-bit two-round FNV-1a mix of the line's chars. A fork copy is
 * byte-identical and hashes to the same pair; a collision would undercount
 * one line out of millions, which is the accepted tail (ADR 0009).
 */
function hashLine(line: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < line.length; i++) {
		const c = line.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ ((c << 1) | 1), 0x811c9dc5);
	}
	return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * The shape of one cached file entry. A corrupt entry reads as an empty
 * cache (a full re-scan), so a missing field can never throw in the
 * aggregate or in the seen-set build at source creation.
 */
function isFileCache(entry: unknown): entry is FileCache {
	if (!entry || typeof entry !== "object") return false;
	const file = entry as Record<string, unknown>;
	if (typeof file.mtimeMs !== "number" || typeof file.size !== "number") return false;
	if (typeof file.counts !== "object" || file.counts === null) return false;
	for (const n of Object.values(file.counts)) if (typeof n !== "number") return false;
	if (!Array.isArray(file.recent)) return false;
	for (const event of file.recent) {
		if (!Array.isArray(event) || event.length !== 2 || typeof event[0] !== "number" || typeof event[1] !== "string") return false;
	}
	if (!Array.isArray(file.lineHashes)) return false;
	for (const hash of file.lineHashes) if (typeof hash !== "string") return false;
	return true;
}

function loadCache(file: string): ToolUsageCache {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as ToolUsageCache;
		if (raw && raw.v === 2 && typeof raw.files === "object" && raw.files) {
			for (const entry of Object.values(raw.files)) {
				if (!isFileCache(entry)) return { v: 2, files: {} };
			}
			return raw;
		}
	} catch {
		// Missing or torn cache file: start empty.
	}
	return { v: 2, files: {} };
}

function saveCache(file: string, cache: ToolUsageCache): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(cache));
		renameSync(tmp, file);
	} catch {
		// The cache is disposable; a failed save just costs a re-scan next time.
	}
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** One settled scan result. */
export interface ToolUsageCounts {
	window: ToolUsageWindow;
	counts: Record<string, number>;
	/** Session files this pass covered (scanned or served from cache). */
	files: number;
	/** Files whose bytes this pass actually parsed. */
	scanned: number;
}

export interface ToolUsageSnapshot {
	phase: "scanning" | "ready" | "error";
	window: ToolUsageWindow;
	counts?: Record<string, number>;
	/** Files processed so far while scanning; the pass's totals once ready. */
	files?: number;
	scanned?: number;
	error?: string;
}

/**
 * What the /ctx UIs consume: the live window, a snapshot, and the settled
 * counts for the text modes. The scan starts on the first use, never at
 * extension load.
 */
export interface ToolUsageSource {
	window: ToolUsageWindow;
	setWindow(window: ToolUsageWindow): void;
	counts(): Promise<ToolUsageCounts>;
	snapshot(): ToolUsageSnapshot;
	subscribe(listener: () => void): () => void;
}

export interface ToolUsageSourceOptions {
	sessionsRoot?: string;
	cacheFile?: string;
	now?: () => number;
}

interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export function createToolUsageSource(options: ToolUsageSourceOptions = {}): ToolUsageSource {
	const root = options.sessionsRoot ?? defaultSessionsRoot();
	const cacheFile = options.cacheFile ?? defaultCacheFile();
	const now = options.now ?? (() => Date.now());

	const cache = loadCache(cacheFile);
	const seen = new Set<string>();
	for (const entry of Object.values(cache.files)) {
		for (const hash of entry.lineHashes) seen.add(hash);
	}

	let window: ToolUsageWindow = "30d";
	let scanPromise: Promise<ToolUsageCounts> | undefined;
	let scanFailed = false;
	let settled: ToolUsageCounts | undefined;
	let snapshot: ToolUsageSnapshot = { phase: "scanning", window };
	const listeners = new Set<() => void>();

	const notify = (): void => {
		for (const listener of [...listeners]) listener();
	};

	const aggregate = (forWindow: ToolUsageWindow): Record<string, number> => {
		const out: Record<string, number> = {};
		const start = windowStart(forWindow, now());
		for (const entry of Object.values(cache.files)) {
			if (start === undefined) {
				for (const [key, n] of Object.entries(entry.counts)) out[key] = (out[key] ?? 0) + n;
			} else {
				for (const [ts, key] of entry.recent) {
					if (ts >= start) out[key] = (out[key] ?? 0) + 1;
				}
			}
		}
		return out;
	};

	const publish = (counts: ToolUsageCounts): void => {
		settled = counts;
		snapshot = { phase: "ready", window, counts: counts.counts, files: counts.files, scanned: counts.scanned };
		notify();
	};

	// The scan yields to the event loop between file chunks, so the /ctx
	// dialog can open and render the "counting" state while it runs.
	const FILE_CHUNK = 64;
	const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

	const scan = async (): Promise<ToolUsageCounts> => {
		const t = now();
		const recentCutoff = windowStart("90d", t) ?? 0;
		const files = listSessionFiles(root);
		const live = new Set(files.map((f) => f.file));
		let scanned = 0;
		// The dialog shows "counting usage N/M" while the scan runs.
		const progress = (done: number): void => {
			snapshot = { phase: "scanning", window, files: files.length, scanned: done };
			notify();
		};
		for (let i = 0; i < files.length; i++) {
			const sf = files[i];
			const cached = cache.files[sf.file];
			if (cached && cached.mtimeMs === sf.mtimeMs && cached.size === sf.size) continue;
			const text = readSessionText(sf.file);
			const entry: FileCache = {
				mtimeMs: sf.mtimeMs,
				size: sf.size,
				counts: {},
				recent: [],
				lineHashes: [],
			};
			if (text !== undefined) {
				for (const line of text.split("\n")) {
					if (!line.includes('"toolCall"')) continue;
					const hash = hashLine(line);
					const dup = seen.has(hash);
					let carried = false;
					if (!dup) {
						let parsed: SessionEntry;
						try {
							parsed = JSON.parse(line);
						} catch {
							continue; // a line mid-write
						}
						const content = parsed.message?.content;
						if (parsed.message?.role !== "assistant" || !Array.isArray(content)) continue;
						const ts = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
						for (const item of content) {
							const call = item as { type?: unknown; name?: unknown; arguments?: unknown };
							if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
							carried = true;
							const keys = [toolCallKey(call.name, call.arguments), ...skillKeysFor(call.arguments)];
							for (const key of keys) {
								entry.counts[key] = (entry.counts[key] ?? 0) + 1;
								if (Number.isFinite(ts) && ts > 0 && ts >= recentCutoff) entry.recent.push([ts, key]);
							}
						}
					}
					// The hash is recorded even for a duplicate line: a fork copy
					// owns no count, but the union of line hashes must cover every
					// tool-carrying line of every file, or a restart re-counts it.
					if (dup || carried) {
						entry.lineHashes.push(hash);
						if (!dup) seen.add(hash);
					}
				}
			}
			scanned++;
			cache.files[sf.file] = entry;
			if (i % FILE_CHUNK === FILE_CHUNK - 1) {
				progress(i + 1);
				await yieldLoop();
			}
		}
		// A file that left the tree drops its cache entry with it.
		for (const name of Object.keys(cache.files)) {
			if (!live.has(name)) delete cache.files[name];
		}
		await yieldLoop(); // the first render sees the "counting" state
		saveCache(cacheFile, cache);
		publish({ window, counts: aggregate(window), files: files.length, scanned });
		return settled as ToolUsageCounts;
	};

	const kick = (): Promise<ToolUsageCounts> => {
		// A failed scan re-runs on the next /ctx: every /ctx kicks, and the
		// in-memory cache holds the files the failed pass already covered, so
		// the retry only parses what is left.
		if (!scanPromise || scanFailed) {
			scanFailed = false;
			snapshot = { phase: "scanning", window };
			notify();
			scanPromise = scan().catch((err: unknown) => {
				scanFailed = true;
				snapshot = { phase: "error", window, error: err instanceof Error ? err.message : String(err) };
				notify();
				throw err;
			});
		}
		return scanPromise;
	};
	// The source is created on the first /ctx, so the scan starts on first
	// use, never at extension load, and always runs in the background.
	kick().catch(() => {
		// The snapshot already carries the error. The TUI never awaits
		// counts(), so without this handler a failed scan would be an
		// unhandled rejection in the agent process.
	});

	/** The settled counts for the window that is current when it resolves. */
	const counts = (): Promise<ToolUsageCounts> =>
		kick().then(() => ({ window, counts: aggregate(window), files: settled?.files ?? 0, scanned: settled?.scanned ?? 0 }));

	const setWindow = (next: ToolUsageWindow): void => {
		if (next === window) return;
		window = next;
		if (settled) {
			publish({ window, counts: aggregate(window), files: settled.files, scanned: settled.scanned });
		} else {
			snapshot = { ...snapshot, window };
			notify();
		}
	};

	return {
		get window() {
			return window;
		},
		setWindow,
		counts,
		snapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/**
 * The count for one /ctx row, or undefined for rows that carry no count.
 * Tool rows show their call count (the `mcp` row folds its `mcp:<tool>`
 * subtools in); skill rows show how often the agent loaded the skill's
 * SKILL.md; the other section rows carry no count.
 */
export function usesForLabel(label: string, kind: string, counts: Record<string, number> | undefined): number | undefined {
	if (!counts) return undefined;
	if (kind === "skill") return counts[`skill:${label}`] ?? 0;
	if (kind !== "tool") return undefined;
	if (label === "mcp") {
		let total = counts.mcp ?? 0;
		for (const [key, n] of Object.entries(counts)) {
			if (key.startsWith("mcp:")) total += n;
		}
		return total;
	}
	return counts[label] ?? 0;
}
