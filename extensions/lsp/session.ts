/**
 * The LspSession: the session-scoped manager of the language servers.
 *
 * Everything the tools, the hooks, and the /lsp command do goes through
 * this class. It owns:
 *
 * - the server instances, one per (language, root) pair, started lazily by
 *   the first call that needs one, alive for the session, bounded by the
 *   Concurrent server bound (the idlest server is evicted with its Open
 *   documents), restarted once after a crash and then marked dead (ADR
 *   0043), and closed idempotently at session shutdown;
 * - the Open document set per server: an LRU capped by
 *   `maxOpenDocuments`, eviction sending didClose. Disk is the only truth:
 *   before any answer the file's mtime and size are checked against the
 *   record and re-synced when they moved (ADR 0042);
 * - the Diagnostic baseline per document: the pre-existing state when the
 *   document entered the working set. Only diagnostics new against the
 *   baseline are reported, so a repo's old errors do not ride every turn;
 * - the Changed set: paths the watcher recorded. Files the agent is working
 *   on open immediately; the rest wait for the Sweep at turn end;
 * - the watcher (one recursive watch per served root, shared by the
 *   servers bound to that root) and its stat-pass fallback;
 * - the per-call log the health script reads.
 *
 * The state machine is reached only through the LspClient (ADR 0041); the
 * tests drive it with a scripted fake server, so no test reaches past the
 * client seam.
 */
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	LspClient,
	LspServerDeadError,
	LspTimeoutError,
	type LspClientOptions,
	type LspCrashInfo,
} from "./client.ts";
import { renderDiagnosticGroups, renderSweepMessage, severitiesForFilter, type DiagnosticFileGroup } from "./format.ts";
import { languageForPath, resolveRegistry, type ResolvedServer } from "./registry.ts";
import { rootForFile } from "./root.ts";
import { readLspSettings } from "./settings.ts";
import type { DiagnosticAnswer, LspDiagnostic } from "./types.ts";
import { appendLspLog, appendServerStderr } from "./usage.ts";
import { startRootWatcher, watchDisabledReason, type RootWatcher, type WatcherState } from "./watcher.ts";

const execFileSyncSafe = (cmd: string, args: string[]): string =>
	execFileSync(cmd, args, {
		timeout: 2000,
		maxBuffer: 1024 * 1024,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"] as const,
	}) as string;

/** Wait this long for a still-starting server before an annotation gives up. */
const ANNOTATION_READY_WAIT_MS = 10_000;
/** Wait this long for the pre-edit state to publish before the edit lands. */
const PRE_SETTLE_MS = 3_000;
/** The sweep's diagnostics wait, capped below the tool's per-request timeout. */
const SWEEP_DIAG_TIMEOUT_MS = 8_000;
/**
 * A pull answer that is empty and arrives before this much time has passed
 * since the document's last sync is labeled partial: the server has not had
 * time to analyze. The heuristic only ever adds a label, never hides one.
 */
const SETTLE_MS = 1_000;
/** Files larger than this are not auto-opened by the hooks (explicit calls still open them). */
const MAX_AUTO_OPEN_BYTES = 1_000_000;
/** The Sweep opens at most this many not-yet-open changed files. */
const SWEEP_MAX_NEW_DOCS = 20;
/** The fallback git sweep names at most this many files. */
const GIT_SWEEP_MAX_FILES = 20;
/** The fallback git sweep runs at most this often per turn. */
const GIT_SWEEP_PER_TURN = 1;
/** A tool result shows at most this many diagnostics per file. */
const MAX_SHOWN_PER_FILE = 10;

export interface LspSessionOptions {
	env?: NodeJS.ProcessEnv;
	/** Test seam: the client factory. Production spawns the real server. */
	makeClient?: (opts: LspClientOptions) => LspClient;
	/** Test seam: the fallback git sweep. Production runs `git status`. */
	gitStatus?: (root: string) => string[];
	now?: () => number;
}

export interface FileResolution {
	lang: string;
	root: string;
	entry: Extract<ResolvedServer, { status: "ready" }>;
}

type OpenKind = "pre" | "read" | "post";

interface DocRecord {
	uri: string;
	path: string;
	mtimeMs: number;
	size: number;
	openedAt: number;
	lastSyncAt: number;
	lastAccess: number;
	openKind: OpenKind;
	/** The client that opened the document; a crash-restarted client re-opens it. */
	client: LspClient;
	/** True once the pre-existing state is established (baseline trustworthy). */
	baselineSettled: boolean;
	baseline: Set<string>;
	/** The server's latest publish for this document, if any. */
	published: LspDiagnostic[] | null;
	/** The last answer's partiality. */
	partial: boolean;
	/**
	 * The last answer could not rule out a stale or missing publish (the
	 * pre-edit state was never captured, or the wait timed out). The Sweep
	 * forces a recompute for such a document so no turn ends on a lie.
	 */
	suspect: boolean;
}

interface ServerInstance {
	lang: string;
	label: string;
	/** The server root, absolute. */
	root: string;
	command: string;
	args: string[];
	state: "starting" | "ready" | "dead";
	restarts: number;
	client: LspClient | null;
	docs: Map<string, DocRecord>;
	/** LRU order; the tail is the idlest document. */
	docsOrder: string[];
	watcherState: WatcherState;
	watcherReason?: string;
	lastAccess: number;
	deadReason?: string;
}

export class LspSession {
	private readonly env: NodeJS.ProcessEnv;
	private readonly makeClient: (opts: LspClientOptions) => LspClient;
	private readonly gitStatusImpl: (root: string) => string[];
	private readonly now: () => number;

	/** Key: `${lang}\0${root}`. */
	private readonly servers = new Map<string, ServerInstance>();
	/** One watcher per served root, shared by the servers bound to it. */
	private readonly rootWatchers = new Map<string, RootWatcher>();
	/** root -> paths the watcher recorded since the last sweep. */
	private readonly changedSets = new Map<string, Set<string>>();
	/** Files that did not exist at tool_call time (a write creates them). */
	private readonly pendingNew = new Set<string>();
	/** The fallback git sweep runs at most once per turn. */
	private gitSweepsThisTurn = 0;

	private ctx: ExtensionContext | null = null;
	private sessionCwd: string;
	private closed = false;

	constructor(opts: LspSessionOptions = {}) {
		this.env = opts.env ?? process.env;
		this.makeClient =
			opts.makeClient ??
			((o) =>
				new LspClient({
					...o,
					onStderr: (chunk) => appendServerStderr(o.root, o.label, chunk, this.env),
				}));
		this.now = opts.now ?? Date.now;
		this.sessionCwd = process.cwd();
		this.gitStatusImpl = opts.gitStatus ?? defaultGitStatus;
	}

	// -----------------------------------------------------------------
	// UI binding and the status line
	// -----------------------------------------------------------------

	/** Bind the latest context: the status line and notifications sink here. */
	setUi(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.sessionCwd = ctx.cwd;
		this.publishStatus();
	}

	private runningServers(): ServerInstance[] {
		const out: ServerInstance[] = [];
		for (const inst of this.servers.values()) {
			if (inst.state !== "dead") out.push(inst);
		}
		return out;
	}

	/** The footer piece while any server runs, else undefined (cleared). */
	statusLineText(): string | undefined {
		const running = this.runningServers();
		if (running.length === 0) return undefined;
		const parts = running.map((inst) => `${inst.lang}(${inst.docs.size})`);
		let watch = "off";
		for (const w of this.rootWatchers.values()) {
			if (w.state === "active") {
				watch = "active";
				break;
			}
		}
		if (watch === "off") {
			for (const w of this.rootWatchers.values()) {
				if (w.state === "degraded") {
					watch = "degraded";
					break;
				}
			}
		}
		return `lsp: ${parts.join(", ")} watcher:${watch}`;
	}

	private publishStatus(): void {
		if (!this.ctx) return;
		try {
			this.ctx.ui.setStatus("lsp", this.statusLineText());
		} catch {
			// The UI sink is gone (session ending): nothing to publish.
		}
	}

	// -----------------------------------------------------------------
	// Resolution: which server can serve a file
	// -----------------------------------------------------------------

	/**
	 * What serves this file, or why nothing does. The refusal reasons are
	 * the /lsp lines: absent, disabled, untrusted, extension disabled.
	 */
	resolveForFile(cwd: string, file: string, trusted: boolean, projectEnabled: boolean): FileResolution | { refusal: string } {
		const { settings } = readLspSettings(cwd, this.env);
		if (!settings.enabled) return { refusal: "the lsp extension is disabled by settings" };
		const lang = languageForPath(file);
		if (lang === null) return { refusal: `no language server for the ${path.extname(file) || "unknown"} extension` };
		const resolved = resolveRegistry(settings, this.env);
		const entry = resolved.find((r) => r.lang === lang);
		if (!entry || entry.status !== "ready") {
			return { refusal: entry ? `${entry.label} server unavailable: ${entry.reason}` : `${lang}: no registry entry` };
		}
		if (!trusted && !projectEnabled) {
			return { refusal: `project not trusted: ${entry.label} will not start until the project is trusted, or lsp is enabled for this project in the project settings` };
		}
		const root = rootForFile(file, cwd, lang, entry.rootMarkers, cwd);
		return { lang, root, entry };
	}

	// -----------------------------------------------------------------
	// Server lifecycle
	// -----------------------------------------------------------------

	private instanceKey(lang: string, root: string): string {
		return `${lang}\0${root}`;
	}

	/** The instance serving a language at any root (the status listing). */
	serverForLang(lang: string): ServerInstance | undefined {
		for (const inst of this.servers.values()) if (inst.lang === lang) return inst;
		return undefined;
	}

	/**
	 * Get or create the server instance for (lang, root). Creation respects
	 * the Concurrent server bound: at the bound, the idlest other instance
	 * is evicted (client shut down, Open documents closed, the root's
	 * watcher dropped when orphaned). A dead instance stays dead for the
	 * session (ADR 0043).
	 */
	async ensureServer(cwd: string, entry: Extract<ResolvedServer, { status: "ready" }>, root: string): Promise<ServerInstance> {
		if (this.closed) throw new LspServerDeadError(entry.label, "the session is shutting down");
		const key = this.instanceKey(entry.lang, root);
		let inst = this.servers.get(key);
		if (!inst) {
			const { settings } = readLspSettings(cwd, this.env);
			this.enforceServerBound(entry.lang, root, settings.maxServers);
			inst = {
				lang: entry.lang,
				label: entry.label,
				root,
				command: entry.command,
				args: entry.args,
				state: "starting",
				restarts: 0,
				client: null,
				docs: new Map(),
				docsOrder: [],
				watcherState: "off",
				lastAccess: this.now(),
			};
			this.servers.set(key, inst);
			this.startClient(inst);
		}
		inst.lastAccess = this.now();
		return inst;
	}

	/** Evict idle instances until the bound holds, keeping the requested slot. */
	private enforceServerBound(keepLang: string, keepRoot: string, maxServers: number): void {
		if (this.closed) return;
		const live = [...this.servers.values()].filter((i) => i.state !== "dead");
		const projected = live.length + 1; // the instance about to be created
		if (projected <= maxServers) return;
		const candidates = live
			.filter((i) => !(i.lang === keepLang && i.root === keepRoot))
			.sort((a, b) => a.lastAccess - b.lastAccess);
		const toEvict = projected - maxServers;
		for (let i = 0; i < toEvict && i < candidates.length; i += 1) {
			void this.evictServer(candidates[i]);
		}
	}

	/** Shut one server down and release everything it held. */
	private async evictServer(inst: ServerInstance): Promise<void> {
		const key = this.instanceKey(inst.lang, inst.root);
		this.servers.delete(key);
		const client = inst.client;
		inst.client = null;
		inst.state = "dead";
		inst.deadReason = "evicted: the concurrent server bound was reached";
		for (const doc of inst.docs.values()) {
			try {
				await client?.closeDocument(doc.uri);
			} catch {
				// the client may already be gone
			}
		}
		inst.docs.clear();
		inst.docsOrder.length = 0;
		if (client) {
			try {
				await client.shutdown();
			} catch {
				client.kill();
			}
		}
		this.dropRootWatcherIfOrphan(inst.root);
		this.publishStatus();
	}

	private startClient(inst: ServerInstance): LspClient {
		const { settings } = readLspSettings(this.sessionCwd, this.env);
		const client = this.makeClient({
			command: inst.command,
			args: inst.args,
			root: inst.root,
			label: inst.label,
			timeoutMs: settings.timeoutMs,
			env: this.env,
				onDiagnostics: (uri, diags) => this.onServerDiagnostics(inst, client, uri, diags),
			onCrash: (info) => this.onServerCrash(inst, info),
		});
		inst.client = client;
		inst.state = "starting";
		client.ready
			.then(() => {
				if (inst.client !== client || this.closed) return;
				inst.state = "ready";
				this.attachRootWatcher(inst);
				this.publishStatus();
			})
			.catch(() => {
				if (inst.client !== client || this.closed) return;
				inst.state = "dead";
				inst.deadReason = client.getStderrTail() || "the server failed to start";
				this.publishStatus();
			});
		return client;
	}

	private attachRootWatcher(inst: ServerInstance): void {
		let w = this.rootWatchers.get(inst.root);
		if (!w || w.state !== "active") {
			const fresh = startRootWatcher(
				inst.root,
				{
					onEvents: (paths) => this.onWatchEvents(inst.root, paths),
					onDegraded: (reason) => this.onWatcherDegraded(inst.root, reason),
				},
				this.env,
			);
			// A disabled watcher (LSP_NO_WATCH and kin) is a policy outcome,
			// not a failure: the stat fallback is already the design.
			w = fresh;
			this.rootWatchers.set(inst.root, w);
		}
		inst.watcherState = w.state;
		inst.watcherReason = w.state === "active" ? undefined : watchDisabledReason(inst.root, this.env) ?? "degraded";
	}

	private dropRootWatcherIfOrphan(root: string): void {
		const stillUsed = [...this.servers.values()].some((i) => i.root === root && i.state !== "dead" && i.client !== null);
		if (stillUsed) return;
		const w = this.rootWatchers.get(root);
		if (w) {
			w.stop();
			this.rootWatchers.delete(root);
		}
	}

	private onWatchEvents(root: string, paths: string[]): void {
		for (const p of paths) {
			const abs = path.isAbsolute(p) ? p : path.join(root, p);
			this.addChanged(root, abs);
			// A file already in a server's working set re-syncs at once, so
			// the server answers from the new disk truth.
			for (const inst of this.servers.values()) {
				if (inst.state !== "ready") continue;
				const doc = this.docByPath(inst, abs);
				if (doc) void this.resyncDoc(inst, doc).catch(() => undefined);
			}
		}
	}

	private addChanged(root: string, abs: string): void {
		const set = this.changedSets.get(root) ?? new Set<string>();
		set.add(abs);
		this.changedSets.set(root, set);
	}

	private onWatcherDegraded(root: string, reason: string): void {
		const w = this.rootWatchers.get(root);
		if (w) {
			w.stop();
			this.rootWatchers.delete(root);
		}
		for (const inst of this.servers.values()) {
			if (inst.root === root) {
				inst.watcherState = "degraded";
				inst.watcherReason = reason;
			}
		}
		this.publishStatus();
		if (this.ctx) {
			try {
				this.ctx.ui.notify(`lsp: the watcher for ${root} degraded (${reason}); the sweep falls back to the stat pass`, "warning");
			} catch {
				// no UI sink
			}
		}
	}

	/**
	 * The watcher's degradation fallback (the policy copies codegraph's
	 * watcher module): the stat pass over the Open documents happens in the
	 * Sweep itself, and this adds the bounded git sweep: git worktrees
	 * only, at most 20 files, at most once per turn.
	 */
	private async fallbackChangedFiles(root: string): Promise<string[]> {
		const out = new Set<string>(this.changedSets.get(root) ?? []);
		if (this.gitSweepsThisTurn < GIT_SWEEP_PER_TURN) {
			this.gitSweepsThisTurn += 1;
			for (const p of this.gitStatusImpl(root)) out.add(p);
		}
		return [...out];
	}

	// -----------------------------------------------------------------
	// Crash handling: one automatic restart, then dead (ADR 0043)
	// -----------------------------------------------------------------

	private onServerCrash(inst: ServerInstance, info: LspCrashInfo): void {
		if (this.closed) return;
		if (inst.client === null || inst.client.state !== "dead" || inst.state === "dead") return;
		if (inst.restarts === 0) {
			// The one automatic restart. The working set's records are
			// dropped with the process; they re-open from disk if needed.
			inst.restarts = 1;
			const old = inst.client;
			inst.client = null;
			inst.docs.clear();
			inst.docsOrder.length = 0;
			void old.shutdown().catch(() => old.kill());
			const client = this.startClient(inst);
			client.ready
				.then(() => {
					if (inst.client !== client || this.closed) return;
					inst.state = "ready";
					this.attachRootWatcher(inst);
					this.publishStatus();
				})
				.catch(() => {
					if (inst.client !== client || this.closed) return;
					inst.state = "dead";
					inst.deadReason = "the restart failed to start";
					this.publishStatus();
				});
			this.publishStatus();
			return;
		}
		// Second crash: dead for the session. A flapping server must not
		// eat the session.
		inst.state = "dead";
		inst.deadReason = `crashed twice (${crashSummary(info)}); it will not restart again`;
		inst.client = null;
		this.publishStatus();
	}

	// -----------------------------------------------------------------
	// Document management
	// -----------------------------------------------------------------

	private docByPath(inst: ServerInstance, absPath: string): DocRecord | undefined {
		return inst.docs.get(pathToUri(absPath));
	}

	private touchDoc(inst: ServerInstance, doc: DocRecord): void {
		doc.lastAccess = this.now();
		const order = inst.docsOrder;
		const i = order.indexOf(doc.uri);
		if (i !== -1) order.splice(i, 1);
		order.push(doc.uri);
	}

	/** Close the idlest documents past the cap (eviction sends didClose). */
	private makeRoomForDoc(inst: ServerInstance, maxDocs: number): void {
		while (inst.docsOrder.length >= maxDocs) {
			const uri = inst.docsOrder.shift();
			if (uri === undefined) return;
			const doc = inst.docs.get(uri);
			inst.docs.delete(uri);
			const client = inst.client;
			if (client && client.state !== "dead") {
				client.closeDocument(uri).catch(() => undefined);
			}
		}
	}

	/**
	 * Open the file in the server if it is not open there. `force` opens
	 * past the size guard (an explicit lsp_* call); the hooks respect the
	 * guard. Returns the record, or null when the file is missing or
	 * guarded.
	 */
	async ensureDoc(inst: ServerInstance, absPath: string, openKind: OpenKind, force: boolean): Promise<DocRecord | null> {
		const client = inst.client;
		if (inst.state !== "ready" || !client) return null;
		const uri = pathToUri(absPath);
		let existing = inst.docs.get(uri);
		if (existing && existing.client !== client) {
			// Orphaned by a crash restart: the restarted client never opened
			// it, so it is re-opened below with the current client.
			this.dropRecord(inst, existing);
			existing = undefined;
		}
		if (existing) {
			this.touchDoc(inst, existing);
			return existing;
		}
		let info;
		try {
			info = await stat(absPath);
		} catch {
			return null;
		}
		if (!info.isFile()) return null;
		if (!force && info.size > MAX_AUTO_OPEN_BYTES) return null;
		let text: string;
		try {
			text = await readFile(absPath, "utf8");
		} catch {
			return null;
		}
		const { settings } = readLspSettings(this.sessionCwd, this.env);
		this.makeRoomForDoc(inst, settings.maxOpenDocuments);
		const now = this.now();
		const doc: DocRecord = {
			uri,
			path: absPath,
			mtimeMs: info.mtimeMs,
			size: info.size,
			openedAt: now,
			lastSyncAt: now,
			lastAccess: now,
			openKind,
			client,
			// A "post" document (a new file, or the edit landed before the
			// open) had nothing pre-existing: everything is new. "pre" and
			// "read" documents settle their baseline on the first publish.
			baselineSettled: openKind === "post",
			baseline: new Set(),
			published: null,
			partial: false,
			suspect: false,
		};
		// The record exists before the open, so a publish that arrives while
		// the open is in flight still settles the baseline instead of
		// being lost.
		inst.docs.set(uri, doc);
		inst.docsOrder.push(uri);
		try {
			await client.openDocument(uri, text);
		} catch {
			this.dropRecord(inst, doc);
			return null;
		}
		return doc;
	}

	private dropRecord(inst: ServerInstance, doc: DocRecord): void {
		inst.docs.delete(doc.uri);
		const i = inst.docsOrder.indexOf(doc.uri);
		if (i !== -1) inst.docsOrder.splice(i, 1);
	}

	/**
	 * The Document sync truth check (ADR 0042): the file's mtime and size
	 * against the record; when they moved, the disk text re-syncs the
	 * server's copy (full didChange) and the document's published state is
	 * stale until the next answer.
	 */
	async resyncDoc(inst: ServerInstance, doc: DocRecord): Promise<boolean> {
		let info;
		try {
			info = await stat(doc.path);
		} catch {
			return false;
		}
		if (info.mtimeMs === doc.mtimeMs && info.size === doc.size) return false;
		const client = inst.client;
		// A crash restart replaced the client: the document is re-opened by
		// the caller's ensureDoc, not re-synced against the dead client.
		if (client === null || client.state === "dead" || inst.state !== "ready" || doc.client !== client) return false;
		let text: string;
		try {
			text = await readFile(doc.path, "utf8");
		} catch {
			return false;
		}
		await client.updateDocument(doc.uri, text);
		doc.mtimeMs = info.mtimeMs;
		doc.size = info.size;
		doc.lastSyncAt = this.now();
		doc.published = null;
		// The server's state moved ahead of the last answer: the Sweep must
		// ask again even if the stat check below finds nothing to re-sync.
		doc.suspect = true;
		return true;
	}

	private onServerDiagnostics(inst: ServerInstance, client: LspClient, uri: string, diags: LspDiagnostic[]): void {
		const doc = inst.docs.get(uri);
		if (!doc || doc.client !== client) return;
		if (!doc.baselineSettled) {
			// The first publish establishes the pre-existing baseline.
			doc.baselineSettled = true;
			for (const d of diags) doc.baseline.add(diagnosticKeyOf(d));
		}
		doc.published = diags;
	}

	// -----------------------------------------------------------------
	// Diagnostics answers
	// -----------------------------------------------------------------

	/**
	 * One diagnostics answer for an open document: the pull request when
	 * the server supports it, the publish wait otherwise. A timeout, or an
	 * answer for which the pre-existing state was never captured, comes
	 * back partial: the reader must not read a partial answer as a clean
	 * one, and the Sweep re-checks partial documents with a fresh request.
	 *
	 * The client's fence keeps a publish for stale content (one that
	 * postdates nothing) from being read as the answer for the new content:
	 * only a publish the server made after the last didOpen/didChange counts.
	 */
	async requestDiagnostics(inst: ServerInstance, doc: DocRecord, timeoutMs: number): Promise<DiagnosticAnswer> {
		const client = inst.client;
		if (!client) throw new LspServerDeadError(inst.label, "no server process");
		// A crash restart replaced the client; the document belongs to the old
		// one and must be re-opened (ensureDoc) before it can be answered.
		if (doc.client !== client) throw new LspServerDeadError(inst.label, "the server restarted since the document was opened");
		const supportsPull = Boolean(client.capabilities?.diagnosticProvider);
		// Captured before any await: a publish that settles the baseline
		// during the wait must not retroactively make the answer complete.
		const baselineKnown = doc.baselineSettled;
		const startedAt = this.now();
		if (supportsPull) {
			try {
				const report = (await client.request<{ kind?: string; items?: PullItem[] }>("textDocument/diagnostic", {
					textDocument: { uri: doc.uri },
				}, timeoutMs)) ?? {};
				const items: LspDiagnostic[] = [];
				for (const i of report.items ?? []) {
					if (typeof i.message !== "string" || !i.range?.start) continue;
					items.push({
						range: {
							start: { line: i.range.start.line ?? 0, character: i.range.start.character ?? 0 },
							end: { line: i.range.end?.line ?? i.range.start.line ?? 0, character: i.range.end?.character ?? i.range.start.character ?? 0 },
						},
						severity: i.severity ?? 1,
						code: typeof i.code === "number" || typeof i.code === "string" ? i.code : undefined,
						message: i.message,
					});
				}
				if (!doc.baselineSettled) this.settleBaseline(doc, items);
				doc.published = items;
				const elapsed = this.now() - startedAt;
				const young = this.now() - doc.lastSyncAt < SETTLE_MS;
				const partial = !baselineKnown || (items.length === 0 && elapsed < SETTLE_MS && young);
				doc.partial = partial;
				doc.suspect = partial;
				return { diagnostics: items, partial, origin: "pull" };
			} catch (err) {
				if (err instanceof LspTimeoutError) {
					const diags = client.publishedDiagnostics(doc.uri) ?? [];
					doc.published = diags;
					doc.partial = true;
					doc.suspect = true;
					return { diagnostics: diags, partial: true, origin: diags.length > 0 ? "push" : "none" };
				}
				throw err;
			}
		}
		// Push-only server: wait for a publish that postdates the last change.
		const diags = await client.awaitPublished(doc.uri, timeoutMs);
		if (diags === null) {
			const late = client.publishedDiagnostics(doc.uri) ?? [];
			doc.published = late;
			doc.partial = true;
			doc.suspect = true;
			return { diagnostics: late, partial: true, origin: late.length > 0 ? "push" : "none" };
		}
		doc.published = diags;
		// A first publish for a document whose pre-edit state was never
		// captured may be a late pre-state publish: partial, and the Sweep
		// re-checks it with a forced recompute.
		const partial = !baselineKnown;
		doc.partial = partial;
		doc.suspect = partial;
		return { diagnostics: diags, partial, origin: "push" };
	}

	/** Establish the baseline from the first observed state of a document. */
	private settleBaseline(doc: DocRecord, diags: LspDiagnostic[]): void {
		doc.baselineSettled = true;
		for (const d of diags) doc.baseline.add(diagnosticKeyOf(d));
	}

	/** Wait for the pre-edit state to publish, or give up after the cap. */
	private async waitForBaseline(doc: DocRecord, capMs: number): Promise<void> {
		const deadline = this.now() + capMs;
		while (!doc.baselineSettled && this.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	/**
	 * Capture a document's pre-existing state before a change lands: a
	 * pre-state pull for pull-capable servers, the publish wait for push
	 * servers. Without it, an answer cannot tell new diagnostics from old
	 * ones, so it comes back partial instead of wrong.
	 */
	private async settlePreState(inst: ServerInstance, doc: DocRecord, timeoutMs: number): Promise<void> {
		if (doc.baselineSettled) return;
		const client = inst.client;
		if (!client || client.state === "dead" || inst.state !== "ready") return;
		if (client.capabilities?.diagnosticProvider) {
			await this.requestDiagnostics(inst, doc, timeoutMs).catch(() => undefined);
		} else {
			await this.waitForBaseline(doc, timeoutMs);
		}
	}

	/** The answer's diagnostics that are new against the baseline and pass the filter. */
	newSinceBaseline(doc: DocRecord, filter: "warning" | "error"): LspDiagnostic[] {
		const allowed = severitiesForFilter(filter);
		const out: LspDiagnostic[] = [];
		for (const d of doc.published ?? []) {
			const severity = d.severity ?? 1;
			if (!allowed.has(severity)) continue;
			if (doc.baseline.has(diagnosticKeyOf(d))) continue;
			out.push(d);
		}
		return out;
	}

	/** After a report: everything now published is the new baseline. */
	adoptAsBaseline(doc: DocRecord): void {
		for (const d of doc.published ?? []) doc.baseline.add(diagnosticKeyOf(d));
		doc.partial = false;
	}

	// -----------------------------------------------------------------
	// The hooks' entry points (called from index.ts)
	// -----------------------------------------------------------------

	/**
	 * The tool_call side of the loop: open the pre-edit state of an edit
	 * target, so its pre-existing diagnostics become the baseline before
	 * the edit lands. A file that does not exist yet is remembered: its
	 * post-write open starts from an empty baseline.
	 */
	async onEditToolCall(cwd: string, file: string, trusted: boolean, projectEnabled: boolean, existed: boolean): Promise<void> {
		if (this.closed) return;
		const { settings } = readLspSettings(cwd, this.env);
		if (!settings.annotate) return;
		const res = this.resolveForFile(cwd, file, trusted, projectEnabled);
		if ("refusal" in res) return;
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		if (!existed) {
			this.pendingNew.add(abs);
			// Start the server now so the result-time wait is short.
			void this.ensureServer(cwd, res.entry, res.root)
				.then((inst) => waitReady(inst, ANNOTATION_READY_WAIT_MS))
				.catch(() => undefined);
			return;
		}
		const inst = await this.ensureServer(cwd, res.entry, res.root).catch(() => undefined);
		if (!inst) return;
		await waitReady(inst, ANNOTATION_READY_WAIT_MS);
		if (inst.state !== "ready") return;
		const doc = await this.ensureDoc(inst, abs, "pre", false).catch(() => undefined);
		// Settle the pre-edit state before the edit lands, so the answer can
		// tell the file's old errors from the ones the edit makes.
		if (doc) await this.settlePreState(inst, doc, PRE_SETTLE_MS);
	}

	/**
	 * The tool_result side: sync the edited file to the disk truth, answer
	 * its diagnostics, and check the other Open documents of its server.
	 * Returns the annotation text, or undefined for a silent result.
	 */
	async annotateEdit(cwd: string, file: string, trigger: "edit" | "write", trusted: boolean, projectEnabled: boolean): Promise<string | undefined> {
		if (this.closed) return undefined;
		const { settings } = readLspSettings(cwd, this.env);
		if (!settings.annotate) return undefined;
		const res = this.resolveForFile(cwd, file, trusted, projectEnabled);
		if ("refusal" in res) return undefined;
		const startedAt = this.now();
		const inst = await this.ensureServer(cwd, res.entry, res.root).catch(() => undefined);
		if (!inst) return undefined;
		await waitReady(inst, ANNOTATION_READY_WAIT_MS);
		if (inst.state !== "ready" || inst.client === null) {
			const note = `LSP: ${inst.label} was not ready in time to check the edit; the turn-end sweep checks it later`;
			this.logAnnotation(res.root, inst, trigger, startedAt, note, [], false);
			return note;
		}
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		const wasPendingNew = this.pendingNew.delete(abs);
		const preDoc = this.docByPath(inst, abs);
		const doc =
			(await this.ensureDoc(inst, abs, wasPendingNew || preDoc === undefined ? "post" : preDoc.openKind, true)) ?? preDoc;
		if (!doc) {
			return `LSP: could not open ${file} in ${inst.label} to check the edit`;
		}
		await this.resyncDoc(inst, doc).catch(() => false);
		let answer: DiagnosticAnswer;
		try {
			answer = await this.requestDiagnostics(inst, doc, settings.timeoutMs);
		} catch (err) {
			if (err instanceof LspServerDeadError) {
				const note = `LSP: ${err.message}`;
				this.logAnnotation(res.root, inst, trigger, startedAt, note, [], false);
				return note;
			}
			throw err;
		}
		const filter = settings.severity;
		const editedNew = this.newSinceBaseline(doc, filter);
		// The edited file is always shown on a complete answer (even clean:
		// that is the honest "no new diagnostics"). On a partial answer the
		// answer may be incomplete, so a file is shown only when the server
		// actually reported something new for it - never "no new diagnostics".
		const groups: DiagnosticFileGroup[] = [];
		if (!answer.partial || editedNew.length > 0) {
			groups.push({ displayPath: relativeDisplay(abs, inst.root), diagnostics: editedNew, edited: true });
		}
		const reported = new Map<string, DocRecord>();
		if (!answer.partial) {
			// A complete answer is the current state: everything now
			// published becomes the baseline. A partial answer may be stale:
			// the baseline must not move, so the Sweep and the next turn
			// still diff against the pre-existing state.
			reported.set(doc.uri, doc);
			for (const other of inst.docs.values()) {
				if (other === doc) continue;
				const otherNew = this.newSinceBaseline(other, filter);
				if (otherNew.length === 0) continue;
				groups.push({ displayPath: relativeDisplay(other.path, inst.root), diagnostics: otherNew, edited: false });
				reported.set(other.uri, other);
			}
		}
		for (const d of reported.values()) this.adoptAsBaseline(d);
		const totalNew = groups.reduce((n, g) => n + g.diagnostics.length, 0);
		let header: string;
		if (answer.partial) {
			header = `LSP: partial - ${inst.label} is still indexing \`${relativeDisplay(abs, inst.root)}\`; the answer may be incomplete`;
		} else if (totalNew === 0) {
			header = `LSP: no new diagnostics after the ${trigger} (${inst.label})`;
		} else {
			header = `LSP: ${totalNew} new diagnostic${totalNew === 1 ? "" : "s"} after the ${trigger} (${inst.label})`;
		}
		const body = renderDiagnosticGroups(header, groups, filter);
		const hasError = groups.some((g) => g.diagnostics.some((d) => (d.severity ?? 1) === 1));
		this.logAnnotation(res.root, inst, trigger, startedAt, body.text, groups, hasError);
		return body.text;
	}

	/**
	 * A read names a file: it enters the Open document set with kind
	 * "read", so the first publish settles the Diagnostic baseline and the
	 * file's pre-existing errors stop riding later annotations (story 2).
	 */
	async onReadToolCall(cwd: string, file: string, trusted: boolean, projectEnabled: boolean): Promise<void> {
		if (this.closed) return;
		const { settings } = readLspSettings(cwd, this.env);
		if (!settings.enabled) return;
		const res = this.resolveForFile(cwd, file, trusted, projectEnabled);
		if ("refusal" in res) return;
		const inst = await this.ensureServer(cwd, res.entry, res.root).catch(() => undefined);
		if (!inst) return;
		await waitReady(inst, ANNOTATION_READY_WAIT_MS);
		if (inst.state !== "ready") return;
		const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
		const doc = await this.ensureDoc(inst, abs, "read", false).catch(() => undefined);
		// A read is the cheapest moment to settle the file's pre-existing
		// state, so later edits diff against it.
		if (doc) await this.settlePreState(inst, doc, PRE_SETTLE_MS);
	}

	private logAnnotation(
		root: string,
		inst: ServerInstance,
		trigger: string,
		startedAt: number,
		text: string,
		groups: DiagnosticFileGroup[],
		hasError: boolean,
	): void {
		appendLspLog(root, {
			kind: "annotation",
			trigger,
			language: inst.lang,
			server: path.basename(inst.command),
			outcome: "reported",
			duration_ms: this.now() - startedAt,
			chars: text.length,
			files: groups.map((g) => g.displayPath),
			new_count: groups.reduce((n, g) => n + g.diagnostics.length, 0),
			has_error: hasError,
		});
	}

	/**
	 * The Sweep (ADR 0040): at turn end, re-check the Open documents and
	 * the Changed set. When new error-severity diagnostics appeared, the
	 * result carries one custom message that starts the agent's next turn;
	 * the turn itself never continues because of it.
	 */
	async sweep(cwd: string): Promise<{ text: string; count: number } | undefined> {
		if (this.closed) return undefined;
		const { settings } = readLspSettings(cwd, this.env);
		if (!settings.enabled) return undefined;
		if (process.env.LSP_DBG) console.error(`[sweep] start enabled=${settings.enabled} servers=${[...this.servers.keys()]}`);
		this.gitSweepsThisTurn = 0;
		const groups: DiagnosticFileGroup[] = [];
		let count = 0;
		let reportedServer = "";
		for (const inst of this.servers.values()) {
			if (inst.state !== "ready" || inst.client === null) continue;
			// The Open documents: the stat check re-syncs what moved, and a
			// re-synced document gets a fresh answer. Documents orphaned by a
			// crash restart wait for a re-open by the tools or the next edit.
			for (const doc of [...inst.docs.values()]) {
				if (doc.client !== inst.client) continue;
				const resynced = await this.resyncDoc(inst, doc).catch(() => false);
				let answered: boolean | undefined;
				if (resynced || doc.suspect) {
					if (doc.suspect && !resynced && inst.client !== null) {
						// The last answer could have been stale or missing: a
						// no-op change forces the server to recompute and
						// publish, so the sweep asks for a fresh answer.
						try {
							const text = await readFile(doc.path, "utf8");
							await inst.client.updateDocument(doc.uri, text);
							doc.published = null;
							doc.lastSyncAt = this.now();
						} catch {
							// The file went away: the answer below reports it.
						}
					}
					try {
						answered = !(await this.requestDiagnostics(inst, doc, SWEEP_DIAG_TIMEOUT_MS)).partial;
					} catch (err) {
						if (err instanceof LspServerDeadError) break;
						throw err;
					}
				}
				const docNew = this.newSinceBaseline(doc, settings.severity).filter((d) => (d.severity ?? 1) === 1);
				if (process.env.LSP_DBG) console.error(`[sweep] doc=${doc.uri} resynced=${resynced} suspect=${doc.suspect} published=${(doc.published ?? []).map((d) => d.message)} baseline=${[...doc.baseline].length} new=${docNew.length}`);
				if (docNew.length === 0) continue;
				groups.push({ displayPath: relativeDisplay(doc.path, inst.root), diagnostics: docNew, edited: false });
				count += docNew.length;
				reportedServer = inst.label;
				// The baseline moves only after the diff was taken, and only
				// when the answer was complete: partial state is re-checked.
				if (answered !== false) this.adoptAsBaseline(doc);
			}
			// The Changed set: paths the watcher saw outside the working
			// set. When the watcher degraded, the bounded git sweep stands
			// in for it. Open the files now (opening makes the server
			// analyze them), within the bound; the remainder waits.
			const watcherUsable = inst.watcherState === "active";
			let paths = [...(this.changedSets.get(inst.root) ?? [])];
			let gitSupplement = false;
			if (!watcherUsable) {
				paths = await this.fallbackChangedFiles(inst.root);
				gitSupplement = true;
			}
			const remainder: string[] = [];
			let budget = SWEEP_MAX_NEW_DOCS;
			for (const p of paths) {
				if (languageForPath(p) !== inst.lang) {
					// Another language's server owns it; leave it for that root.
					continue;
				}
				if (this.docByPath(inst, p)) continue;
				if (budget <= 0) {
					remainder.push(p);
					continue;
				}
				budget -= 1;
				const doc = await this.ensureDoc(inst, p, "post", true).catch(() => null);
				if (!doc) continue;
				let answered: boolean | undefined;
				try {
					answered = !(await this.requestDiagnostics(inst, doc, SWEEP_DIAG_TIMEOUT_MS)).partial;
				} catch (err) {
					if (err instanceof LspServerDeadError) break;
					throw err;
				}
				const docNew = this.newSinceBaseline(doc, settings.severity).filter((d) => (d.severity ?? 1) === 1);
				if (docNew.length === 0) continue;
				groups.push({ displayPath: relativeDisplay(p, inst.root), diagnostics: docNew, edited: false });
				count += docNew.length;
				reportedServer = inst.label;
				if (answered !== false) this.adoptAsBaseline(doc);
			}
			// What was not checked keeps waiting for the next sweep.
			const leftover = new Set(remainder);
			if (leftover.size > 0) this.changedSets.set(inst.root, leftover);
			else this.changedSets.delete(inst.root);
			if (gitSupplement) this.changedSets.delete(inst.root);
		}
		if (count === 0) {
			for (const key of [...this.changedSets.keys()]) this.changedSets.delete(key);
			return undefined;
		}
		const text = renderSweepMessage(count, groups, settings.severity, reportedServer || "the language servers");
		const first = this.servers.values().next().value;
		appendLspLog(first?.root ?? cwd, {
			kind: "sweep",
			server: path.basename(first?.command ?? ""),
			outcome: "reported",
			chars: text.length,
			files: groups.map((g) => g.displayPath),
			new_count: count,
			has_error: true,
		});
		return { text, count };
	}

	// -----------------------------------------------------------------
	// The tools' entry points
	// -----------------------------------------------------------------

	async runTool(
		tool: string,
		cwd: string,
		params: { file: string; line?: number; character?: number; includeDeclaration?: boolean },
		trusted: boolean,
		projectEnabled: boolean,
	): Promise<{ text: string; details: { server?: string; partial?: boolean; counts?: Record<string, number> } }> {
		const startedAt = this.now();
		const res = this.resolveForFile(cwd, params.file, trusted, projectEnabled);
		if ("refusal" in res) {
			appendLspLog(cwd, { kind: "call", tool, outcome: "refused", duration_ms: this.now() - startedAt, chars: 0 });
			return { text: `lsp: ${res.refusal}`, details: {} };
		}
		const { settings } = readLspSettings(cwd, this.env);
		const inst = await this.ensureServer(cwd, res.entry, res.root).catch(() => undefined);
		if (!inst) {
			appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: path.basename(res.entry.command), outcome: "error", duration_ms: this.now() - startedAt, chars: 0 });
			return { text: `lsp: could not start the ${res.entry.label} server for ${params.file}`, details: {} };
		}
		await waitReady(inst, ANNOTATION_READY_WAIT_MS);
		const serverName = path.basename(inst.command);
		if (inst.state !== "ready" || inst.client === null) {
			appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "dead", duration_ms: this.now() - startedAt, chars: 0 });
			return {
				text:
					inst.state === "dead"
						? `lsp: ${inst.label} is not running: ${inst.deadReason ?? "it crashed"}`
						: `lsp: ${inst.label} was not ready in time at ${res.root}`,
				details: { server: serverName },
			};
		}
		const abs = path.isAbsolute(params.file) ? params.file : path.resolve(cwd, params.file);
		const doc = await this.ensureDoc(inst, abs, "read", true);
		if (!doc) {
			appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "error", duration_ms: this.now() - startedAt, chars: 0 });
			return { text: `lsp: could not open ${params.file} in ${inst.label}`, details: { server: serverName } };
		}
		if (tool !== "lsp_diagnostics") {
			if (params.line === undefined || !Number.isInteger(params.line) || params.line < 1) {
				return { text: `lsp: line must be a positive 1-based line number`, details: { server: serverName } };
			}
		}
		const character = Math.max(0, params.character ?? 0);
		await this.resyncDoc(inst, doc).catch(() => false);
		try {
			if (tool === "lsp_diagnostics") {
				const answer = await this.requestDiagnostics(inst, doc, settings.timeoutMs);
				const filter = settings.severity;
				const shown = answer.diagnostics.filter((d) => severitiesForFilter(filter).has(d.severity ?? 1));
				const counts = { error: 0, warning: 0, info: 0, hint: 0 };
				for (const d of shown) {
					const s = d.severity ?? 1;
					if (s === 1) counts.error += 1;
					else if (s === 2) counts.warning += 1;
					else if (s === 3) counts.info += 1;
					else counts.hint += 1;
				}
				const display = relativeDisplay(abs, inst.root);
				const lines: string[] = [];
				if (answer.partial) {
					lines.push(`${display} - partial: ${inst.label} is still indexing; the answer may be incomplete`);
				} else if (shown.length === 0) {
					lines.push(`${display} - no diagnostics (${inst.label})`);
				} else {
					lines.push(`${display} - ${shown.length} diagnostic${shown.length === 1 ? "" : "s"} (${inst.label})`);
					for (const d of shown.slice(0, MAX_SHOWN_PER_FILE)) lines.push(`  ${formatLine(d)}`);
					if (shown.length > MAX_SHOWN_PER_FILE) lines.push(`  +${shown.length - MAX_SHOWN_PER_FILE} more`);
				}
				const text = lines.join("\n");
				appendLspLog(res.root, {
					kind: "call",
					tool,
					language: res.lang,
					server: serverName,
					outcome: answer.partial ? "timeout" : "ok",
					duration_ms: this.now() - startedAt,
					chars: text.length,
				});
				return { text, details: { server: serverName, partial: answer.partial || undefined, counts: shown.length > 0 ? counts : undefined } };
			}
			if (tool === "lsp_references") {
				const lspLine = (params.line ?? 1) - 1;
				const result =
					(await inst.client!.request<{ uri: string; range: { start: { line: number; character: number } } }[]>("textDocument/references", {
						textDocument: { uri: doc.uri },
						position: { line: lspLine, character },
						context: { includeDeclaration: params.includeDeclaration !== false },
					}, settings.timeoutMs)) ?? [];
				const display = result
					.map((loc) => `  ${relativeDisplay(uriToPath(loc.uri), inst.root)} L${loc.range.start.line + 1}`)
					.sort();
				const text =
					result.length === 0
						? `no references found at ${relativeDisplay(abs, inst.root)} L${lspLine + 1} (${inst.label})`
						: `${result.length} reference${result.length === 1 ? "" : "s"} at ${relativeDisplay(abs, inst.root)} L${lspLine + 1} (${inst.label}):\n${display.join("\n")}`;
				appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "ok", duration_ms: this.now() - startedAt, chars: text.length });
				return { text, details: { server: serverName } };
			}
			// lsp_hover
			const lspLine = (params.line ?? 1) - 1;
			const result =
				(await inst.client!.request<{ contents?: unknown }>("textDocument/hover", {
					textDocument: { uri: doc.uri },
					position: { line: lspLine, character },
				}, settings.timeoutMs)) ?? {};
			const value = hoverValue(result.contents);
			if (value === null) {
				const text = `no hover at ${relativeDisplay(abs, inst.root)} L${lspLine + 1}:${character + 1} (${inst.label})`;
				appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "ok", duration_ms: this.now() - startedAt, chars: text.length });
				return { text, details: { server: serverName } };
			}
			const text = `${relativeDisplay(abs, inst.root)} L${lspLine + 1}:${character + 1} - ${inst.label}\n${value}`;
			appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "ok", duration_ms: this.now() - startedAt, chars: text.length });
			return { text, details: { server: serverName } };
		} catch (err) {
			if (err instanceof LspTimeoutError) {
				appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "timeout", duration_ms: this.now() - startedAt, chars: 0 });
				return { text: `lsp: ${err.message}`, details: { server: serverName, partial: true } };
			}
			if (err instanceof LspServerDeadError) {
				appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "dead", duration_ms: this.now() - startedAt, chars: 0 });
				return { text: `lsp: ${err.message}`, details: {} };
			}
			const message = err instanceof Error ? err.message : String(err);
			appendLspLog(res.root, { kind: "call", tool, language: res.lang, server: serverName, outcome: "error", duration_ms: this.now() - startedAt, chars: 0 });
			return { text: `lsp: ${inst.label}: ${message}`, details: { server: serverName } };
		}
	}

	// -----------------------------------------------------------------
	// The /lsp status block
	// -----------------------------------------------------------------

	statusLines(cwd: string, trusted: boolean, projectEnabled: boolean): string[] {
		const { settings, errors } = readLspSettings(cwd, this.env);
		const resolved = resolveRegistry(settings, this.env);
		const lines: string[] = [`lsp: ${cwd}`];
		if (!settings.enabled) {
			lines.push("  disabled by settings: no server runs, no tools, no note, no annotation");
			return lines;
		}
		lines.push(
			trusted
				? "  project: trusted"
				: projectEnabled
					? "  project: untrusted - lsp is enabled for this project by its settings"
					: "  project: untrusted - no server starts until the project is trusted",
		);
		lines.push("  servers:");
		for (const entry of resolved) {
			const inst = this.serverForLang(entry.lang);
			if (entry.status === "disabled") {
				lines.push(`    ${entry.label}: disabled by settings`);
			} else if (entry.status === "absent") {
				lines.push(`    ${entry.label}: absent - ${entry.reason}`);
			} else if (inst && (inst.lang === entry.lang)) {
				const docs = inst.docs.size;
				if (inst.state === "dead") {
					lines.push(`    ${entry.label}: dead - ${inst.deadReason ?? "crashed"} (root ${shortRoot(inst.root, cwd)})`);
				} else if (inst.state === "starting") {
					lines.push(`    ${entry.label}: starting - ${path.basename(inst.command)} (root ${shortRoot(inst.root, cwd)})`);
				} else {
					lines.push(`    ${entry.label}: running - ${path.basename(inst.command)} - ${docs} open doc${docs === 1 ? "" : "s"} (root ${shortRoot(inst.root, cwd)})`);
				}
			} else {
				lines.push(`    ${entry.label}: not started - ${path.basename(entry.command)} found on PATH`);
			}
		}
		const watchRoots = [...new Set(this.runningServers().map((i) => i.root))];
		if (watchRoots.length === 0) {
			lines.push("  watcher: off (no running server)");
		} else {
			for (const root of watchRoots) {
				const w = this.rootWatchers.get(root);
				if (!w) lines.push(`  watcher: off for ${shortRoot(root, cwd)}`);
				else if (w.state === "active") lines.push(`  watcher: active (${shortRoot(root, cwd)})`);
				else lines.push(`  watcher: ${w.state} (${watchDisabledReason(root, this.env) ?? "degraded"}) for ${shortRoot(root, cwd)}`);
			}
		}
		const changed = [...this.changedSets.values()].reduce((n, s) => n + s.size, 0);
		if (changed > 0) lines.push(`  changed set: ${changed} path${changed === 1 ? "" : "s"} waiting for the sweep`);
		const first = this.servers.values().next().value;
		if (first) {
			lines.push(`  log: ${first.root === cwd ? "this project" : shortRoot(first.root, cwd)} - the per-call log feeds scripts/lsp-health.mjs`);
		}
		if (errors.length > 0) for (const e of errors.slice(0, 3)) lines.push(`  settings: ${e}`);
		return lines;
	}

	// -----------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------

	/** Close every server idempotently. Runs at session_shutdown. */
	async closeAll(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const w of this.rootWatchers.values()) w.stop();
		this.rootWatchers.clear();
		const instances = [...this.servers.values()];
		this.servers.clear();
		await Promise.all(
			instances.map(async (inst) => {
				const client = inst.client;
				inst.client = null;
				if (!client) return;
				for (const doc of inst.docs.values()) {
					try {
						await client.closeDocument(doc.uri);
					} catch {
						// shutting down anyway
					}
				}
				inst.docs.clear();
				try {
					await client.shutdown();
				} catch {
					client.kill();
				}
			}),
		);
		this.changedSets.clear();
		this.publishStatus();
	}
}

interface PullItem {
	range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
	severity?: number;
	code?: number | string;
	message?: string;
}

/** The one-line form of a diagnostic, for the tool results. */
function formatLine(d: LspDiagnostic): string {
	const letter = d.severity === 1 ? "E" : d.severity === 2 ? "W" : d.severity === 3 ? "I" : "H";
	const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
	let message = d.message.replace(/\s+/g, " ").trim();
	if (message.length > 200) message = message.slice(0, 197) + "...";
	const code = d.code === undefined ? "" : ` (${d.code})`;
	return `${letter} ${pos}  ${message}${code}`;
}

function diagnosticKeyOf(d: LspDiagnostic): string {
	const code = d.code === undefined ? "" : String(d.code);
	const severity = d.severity ?? 1;
	return `${severity}:${d.range.start.line}:${d.range.start.character}:${code}:${d.message}`;
}

function pathToUri(abs: string): string {
	return pathToFileURL(abs).toString();
}

function uriToPath(uri: string): string {
	try {
		return new URL(uri).pathname;
	} catch {
		return uri.startsWith("file://") ? uri.slice("file://".length) : uri;
	}
}

function crashSummary(info: LspCrashInfo): string {
	if (info.code !== null) return `exit code ${info.code}`;
	if (info.signal) return `signal ${info.signal}`;
	return "failed to start";
}

function shortRoot(root: string, cwd: string): string {
	return root === cwd ? "." : root;
}

/** Display a path relative to the root when it is inside it. */
function relativeDisplay(abs: string, root: string): string {
	if (!abs.startsWith(root + path.sep)) return abs;
	const rel = path.relative(root, abs);
	return rel.length > 0 ? rel : abs;
}

/** Wait for the server to be ready, bounded. A dead or slow server returns as-is. */
async function waitReady(inst: { state: string; client: LspClient | null }, ms: number): Promise<void> {
	if (inst.state === "ready" || inst.state === "dead") return;
	const wait = inst.client?.ready;
	if (!wait) return;
	await Promise.race([wait, delay(ms)]);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/** The hover's text, out of the shape the servers send. */
function hoverValue(contents: unknown): string | null {
	if (contents === null || contents === undefined) return null;
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
			const parts: string[] = [];
			for (const c of contents) {
				const v = hoverValue(c);
				if (v !== null) parts.push(v);
			}
			const text = parts.join("\n");
			return text.length > 0 ? text : null;
		}
	if (typeof contents === "object") {
		const v = (contents as { value?: unknown }).value;
		if (typeof v === "string") return v;
	}
	return null;
}

/** The fallback git sweep: `git status` of the root, bounded. */
function defaultGitStatus(root: string): string[] {
	try {
		const stdout = execFileSyncSafe("git", ["-C", root, "status", "--porcelain"]);
		const out: string[] = [];
		for (const line of stdout.split("\n")) {
			if (line.length < 4) continue;
			let p = line.slice(3).trim();
			if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
			const abs = path.isAbsolute(p) ? p : path.join(root, p);
			if (languageForPath(abs) === null) continue;
			out.push(abs);
			if (out.length >= GIT_SWEEP_MAX_FILES) break;
		}
		return out;
	} catch {
		// Not a git worktree (or git is missing): no fallback.
		return [];
	}
}
