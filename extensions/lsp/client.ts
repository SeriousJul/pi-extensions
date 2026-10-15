/**
 * The LSP client (ADR 0041).
 *
 * One LspClient owns one language server process and the JSON-RPC
 * conversation on its stdio, carried by the official protocol packages
 * (vscode-jsonrpc framing and message types,
 * vscode-languageserver-protocol kinds): an LSP spec bump is a dependency
 * bump, not a re-implementation.
 *
 * The client is the seam every test drives: a scripted fake server
 * (tests/lsp/fake-server.mjs) is a plain stdio JSON-RPC process, so crash,
 * timeout, still-indexing, and eviction are tested without a real toolchain.
 * Nothing in the extension reaches the protocol past this module.
 *
 * The client speaks the minimum the extension needs: the initialize
 * handshake, full-document sync (didOpen/didChange/didClose),
 * textDocument/publishDiagnostics collection, and one generic
 * `request()` with a per-request timeout. It answers the two client-side
 * requests some servers send (workspace/configuration, capability
 * registration) with empty results, and swallows window messages into the
 * onLog hook.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import type { LspDiagnostic } from "./types.ts";

export interface LspClientOptions {
	/** The binary to spawn. */
	command: string;
	/** Its arguments. */
	args: string[];
	/** The project root: the child's cwd and the initialize rootUri. */
	root: string;
	/** The label errors and status show for this server. */
	label: string;
	/** The per-request timeout. */
	timeoutMs: number;
	/** The child's environment. */
	env?: NodeJS.ProcessEnv;
	/** The latest publishDiagnostics for a uri arrived. */
	onDiagnostics?: (uri: string, diagnostics: LspDiagnostic[]) => void;
	/** The server process died on its own (crash, not a shutdown). */
	onCrash?: (info: LspCrashInfo) => void;
	/** The server wrote to stderr. The session routes it to the project log. */
	onStderr?: (chunk: string) => void;
	/** A window/logMessage or window/showMessage from the server. */
	onLog?: (message: string) => void;
}

export interface LspCrashInfo {
	code: number | null;
	signal: string | null;
	/** The tail of the server's stderr, for the error text. */
	stderrTail: string;
}

export type ClientState = "starting" | "ready" | "dead" | "closed";

/** A request that outlived its timeout. The message names the server. */
export class LspTimeoutError extends Error {
	constructor(
		readonly method: string,
		readonly serverLabel: string,
		readonly timeoutMs: number,
	) {
		super(`${serverLabel} timed out after ${Math.round(timeoutMs / 1000)}s answering ${method}`);
		this.name = "LspTimeoutError";
	}
}

/** The server process is gone: crashed, or shut down under the call. */
export class LspServerDeadError extends Error {
	constructor(
		readonly serverLabel: string,
		reason: string,
	) {
		super(`${serverLabel} is not running: ${reason}`);
		this.name = "LspServerDeadError";
	}
}

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".mts": "typescript",
	".cts": "typescript",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".inl": "cpp",
	".rs": "rust",
	".py": "python",
	".pyi": "python",
	".go": "go",
};

/** The LSP languageId of a file uri, by its extension. */
export function languageIdForUri(uri: string): string {
	const pathPart = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
	const dot = pathPart.lastIndexOf(".");
	if (dot >= 0) {
		const id = LANGUAGE_IDS[pathPart.slice(dot).toLowerCase()];
		if (id) return id;
	}
	return "plaintext";
}

export class LspClient {
	readonly label: string;
	readonly root: string;
	state: ClientState = "starting";
	/** Settles when the initialize handshake completes or fails. */
	readonly ready: Promise<void>;
	/** The server's capabilities from the initialize answer. */
	capabilities: { diagnosticProvider?: { interFile?: boolean }; textDocumentSync?: unknown } | undefined;

	private child: ChildProcess;
	private conn: MessageConnection;
	private readonly timeoutMs: number;
	private readonly published = new Map<string, LspDiagnostic[]>();
	private readonly publishWaiters = new Map<string, Set<() => void>>();
	/** Monotonic count of publishes seen per uri. */
	private readonly publishSeq = new Map<string, number>();
	/** The publishSeq at the last didOpen/didChange: publishes at or below it predate the current content. */
	private readonly changeFence = new Map<string, number>();
	private readonly versions = new Map<string, number>();
	private readonly openUris = new Set<string>();
	private stderrTail = "";
	private closed = false;
	private closing: Promise<void> | null = null;
	private exitResolve: (() => void) | null = null;
	private readonly exitPromise: Promise<void>;
	private readyReject: ((err: Error) => void) | null = null;

	constructor(private readonly opts: LspClientOptions) {
		this.label = opts.label;
		this.root = opts.root;
		this.timeoutMs = opts.timeoutMs;
		this.exitPromise = new Promise((resolve) => {
			this.exitResolve = resolve;
		});
		let resolveReady: () => void = () => undefined;
		this.ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			this.readyReject = reject;
		});

		this.child = spawn(opts.command, opts.args, {
			cwd: opts.root,
			stdio: ["pipe", "pipe", "pipe"],
			env: opts.env ?? process.env,
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			this.stderrTail = (this.stderrTail + text).slice(-4000);
			this.opts.onStderr?.(text);
		});
		this.child.on("error", (err) => {
			// Spawn failure (ENOENT and kin): the process never ran.
			this.markDead({ code: null, signal: null, stderrTail: `${opts.command}: ${err.message}` });
		});
		this.child.on("exit", (code, signal) => {
			this.exitResolve?.();
			if (this.closed) return;
			this.markDead({ code, signal, stderrTail: this.stderrTail });
		});

		const reader = new StreamMessageReader(this.child.stdout!);
		const writer = new StreamMessageWriter(this.child.stdin!);
		this.conn = createMessageConnection(reader, writer);
		this.conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
			if (this.closed) return;
			const diags: LspDiagnostic[] = (params.diagnostics ?? []).map((d) => ({
				range: { start: d.range?.start ?? { line: 0, character: 0 }, end: d.range?.end ?? { line: 0, character: 0 } },
				severity: d.severity ?? DiagnosticSeverity.Error,
				code: typeof d.code === "number" || typeof d.code === "string" ? d.code : undefined,
				message: typeof d.message === "string" ? d.message : d.message.value,
			}));
			if (process.env.LSP_DBG) console.error(`[client ${this.label}] publish ${params.uri.split("/").pop()} ${diags.length}`);
			this.published.set(params.uri, diags);
			this.publishSeq.set(params.uri, (this.publishSeq.get(params.uri) ?? 0) + 1);
			this.wakePublishWaiters(params.uri);
			opts.onDiagnostics?.(params.uri, diags);
		});
		this.conn.onNotification("window/logMessage", (params: { message: string }) => opts.onLog?.(params.message));
		this.conn.onNotification("window/showMessage", (params: { message: string }) => opts.onLog?.(params.message));
		this.conn.onRequest("workspace/configuration", (params: unknown) => {
			const items = Array.isArray(params) ? params : [params];
			return items.map(() => null);
		});
		this.conn.onRequest("client/registerCapability", () => null);
		this.conn.onRequest("client/unregisterCapability", () => null);
		this.conn.onRequest("workspace/workspaceFolders", () => [
			{ uri: pathToFileURL(this.root).toString(), name: this.root.split("/").pop() ?? this.root },
		]);
		this.conn.listen();

		// The handshake runs against the raw connection: the state is still
		// "starting" when it sends initialize.
		this.handshake()
			.then(() => resolveReady())
			.catch((err: Error) => {
				this.readyReject?.(err);
				this.readyReject = null;
			});
		// A caller that never awaits `ready` must not make a failed
		// handshake an unhandled rejection on the shared promise.
		this.ready.catch(() => undefined);
	}

	/** The initialize handshake. Resolves once the server is usable. */
	private async handshake(): Promise<void> {
		const rootUri = pathToFileURL(this.root).toString();
		const initTimeout = Math.max(this.timeoutMs, 30_000);
		const result = (await this.requestRaw<unknown>(
			"initialize",
			{
				processId: process.pid,
				rootUri,
				capabilities: {
					workspace: { workspaceFolders: true },
					// Advertise both diagnostic channels: servers like
					// typescript-language-server only publish when the client
					// says it receives push, and pull-capable servers (clangd,
					// the native TypeScript server) are asked on demand.
					textDocument: {
						publishDiagnostics: { value: true },
						diagnostic: { interFileDependencies: false, workspaceDiagnostics: false },
					},
				},
				workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() ?? this.root }],
				initializationOptions: {},
			},
			initTimeout,
		)) as { capabilities?: LspClient["capabilities"] } | null;
		this.capabilities = result?.capabilities;
		this.sendNotification("initialized", {});
		if (this.state === "dead" || this.state === "closed") {
			throw new LspServerDeadError(this.label, this.deadReason());
		}
		this.state = "ready";
	}

	/** The raw send-request with a timeout; the public API wraps it. */
	private async requestRaw<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		const attempt = this.conn.sendRequest(method, params) as Promise<T>;
		attempt.catch(() => undefined); // a late answer after a timeout is not an error
		return await Promise.race([
			attempt,
			new Promise<never>((_, reject) => {
				const timer = setTimeout(() => reject(new LspTimeoutError(method, this.label, timeoutMs)), timeoutMs);
				timer.unref?.();
			}),
		]);
	}

	/**
	 * One request, bounded by the per-request timeout (ADR 0043). When the
	 * server dies under the call, the failure comes back as an
	 * LspServerDeadError that names the server, whatever the transport said.
	 */
	async request<T>(method: string, params: unknown, timeoutMs: number = this.timeoutMs): Promise<T> {
		if (this.state !== "ready") {
			throw new LspServerDeadError(this.label, this.state === "closed" ? "shut down" : this.deadReason());
		}
		try {
			const result = await this.requestRaw<T>(method, params, timeoutMs);
			// Read through a string-typed local: `this.state` is narrowed to
			// "ready" by the guard above, but the request may have died the
			// server, and the check must see the real value.
			const state: string = this.state;
			if (state === "dead" || state === "closed") {
				throw new LspServerDeadError(this.label, this.deadReason());
			}
			return result;
		} catch (err) {
			if (err instanceof LspTimeoutError) throw err;
			const state: string = this.state;
			if (state === "dead" || state === "closed") {
				throw new LspServerDeadError(this.label, this.deadReason());
			}
			throw err;
		}
	}

	private deadReason(): string {
		if (this.state === "closed") return "shut down";
		const code = this.child.exitCode;
		const signal = this.child.signalCode;
		if (code !== null) return `exited with code ${code}`;
		if (signal) return `killed by ${signal}`;
		return "failed to start";
	}

	private sendNotification(method: string, params: unknown): void {
		try {
			this.conn.sendNotification(method, params);
		} catch {
			// The pipe is gone: the exit handler reports it.
		}
	}

	/** didOpen with the full text, version 1. */
	async openDocument(uri: string, text: string): Promise<void> {
		this.versions.set(uri, 1);
		this.openUris.add(uri);
		this.fence(uri);
		if (process.env.LSP_DBG) console.error(`[client ${this.label}] didOpen ${uri.split("/").pop()} state=${this.state}`);
		this.sendNotification("textDocument/didOpen", {
			textDocument: { uri, languageId: languageIdForUri(uri), version: 1, text },
		});
	}

	/** didChange, full sync: the server's copy is replaced by the disk truth. */
	async updateDocument(uri: string, text: string): Promise<void> {
		const version = (this.versions.get(uri) ?? 1) + 1;
		this.versions.set(uri, version);
		this.openUris.add(uri);
		this.fence(uri);
		if (process.env.LSP_DBG) console.error(`[client ${this.label}] didChange ${uri.split("/").pop()} v${version}`);
		this.sendNotification("textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text }],
		});
	}

	/**
	 * Mark everything the server has published so far as predating the new
	 * content, before the change is sent. A slow server may still emit a
	 * publish for the old content after the change goes out; the fence keeps
	 * such a publish from being read as the answer for the new content.
	 */
	private fence(uri: string): void {
		this.changeFence.set(uri, this.publishSeq.get(uri) ?? 0);
	}

	/** True when the latest publish for the uri postdates its last change. */
	isFreshPublish(uri: string): boolean {
		return (this.publishSeq.get(uri) ?? 0) > (this.changeFence.get(uri) ?? 0);
	}

	/** didClose. The server drops its state for the uri. */
	async closeDocument(uri: string): Promise<void> {
		this.versions.delete(uri);
		this.openUris.delete(uri);
		this.published.delete(uri);
		this.publishSeq.delete(uri);
		this.changeFence.delete(uri);
		this.sendNotification("textDocument/didClose", { textDocument: { uri } });
	}

	/** True when the document is open in this server. */
	isOpen(uri: string): boolean {
		return this.openUris.has(uri);
	}

	/** The server's latest publish for the uri, if it has published. */
	publishedDiagnostics(uri: string): LspDiagnostic[] | undefined {
		return this.published.get(uri);
	}

	/**
	 * Wait for the server to publish diagnostics for the uri that postdate
	 * its last didOpen/didChange (the fence), until they arrive or the
	 * timeout runs out. Returns the fresh publish, or null when the server
	 * had not answered the current content by the deadline. This is the
	 * answer path for servers without the pull capability. A publish for
	 * stale content is never mistaken for the answer.
	 */
	async awaitPublished(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.isFreshPublish(uri)) return this.published.get(uri) ?? null;
			const remaining = deadline - Date.now();
			if (remaining <= 0) return null;
			const value = await new Promise<LspDiagnostic[] | null>((resolve) => {
				let settled = false;
				const settle = (v: LspDiagnostic[] | null): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(v);
				};
				const timer = setTimeout(() => settle(null), remaining);
				timer.unref?.();
				const waiters = this.publishWaiters.get(uri) ?? new Set<() => void>();
				this.publishWaiters.set(uri, waiters);
				waiters.add(() => {
					// Only a publish that postdates the last change is an answer.
					settle(this.isFreshPublish(uri) ? (this.published.get(uri) ?? null) : null);
					});
				// A publish that landed between the read above and the wait
				// registration still counts.
				if (this.isFreshPublish(uri)) settle(this.published.get(uri) ?? null);
			});
			if (value !== null) return value;
		}
	}

	private wakePublishWaiters(uri: string): void {
		const waiters = this.publishWaiters.get(uri);
		if (!waiters) return;
		this.publishWaiters.delete(uri);
		for (const wake of waiters) wake();
	}

	/**
	 * Idempotent shutdown: the LSP shutdown request, the exit notification,
	 * then a kill for a server that ignores both. Safe to call from several
	 * places at once; it resolves once.
	 */
	shutdown(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = this.doShutdown();
		return this.closing;
	}

	private async doShutdown(): Promise<void> {
		this.closed = true;
		if (this.state === "closed" || this.state === "dead") {
			this.killIfAlive();
			this.state = "closed";
			return;
		}
		this.state = "closed";
		try {
			await this.requestRaw("shutdown", null, 3000);
		} catch {
			// A dead or slow server skips the graceful step.
		}
		this.sendNotification("exit", undefined);
		await Promise.race([this.exitPromise, delay(2000)]);
		this.killIfAlive();
	}

	private killIfAlive(): void {
		if (this.child.exitCode === null && this.child.signalCode === null) {
			try {
				this.child.kill();
			} catch {
				// already gone
			}
		}
	}

	/** Stop the process now, without the graceful dance. */
	kill(): void {
		this.closed = true;
		// A kill while still starting must settle `ready`, or callers that
		// wait on it hang for the full timeout.
		if (this.state === "starting" && this.readyReject) {
			const reject = this.readyReject;
			this.readyReject = null;
			reject(new LspServerDeadError(this.label, "killed before it became ready"));
		}
		if (this.state !== "closed") this.state = "dead";
		try {
			this.child.kill();
		} catch {
			// already gone
		}
	}

	private markDead(info: { code: number | null; signal: string | null; stderrTail: string }): void {
		if (this.closed) return;
		this.state = "dead";
		if (this.readyReject) {
			const reject = this.readyReject;
			this.readyReject = null;
			reject(new LspServerDeadError(this.label, this.deadReason()));
		}
		const tail = info.stderrTail.trim();
		this.opts.onCrash?.({ code: info.code, signal: info.signal, stderrTail: tail });
	}

	/** The tail of the server's stderr, for status and error text. */
	getStderrTail(): string {
		return this.stderrTail.trim();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
