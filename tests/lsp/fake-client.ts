/**
 * The scripted in-process fake for the LspClient seam (ADR 0041).
 *
 * The session tests drive the whole state machine through this: it
 * implements exactly the surface the LspSession reaches - the same surface
 * the real client implements over stdio, so a test that passes here
 * exercises the session against the seam and nothing else.
 *
 * The diagnostics engine uses the same marker convention as the
 * process-bound fake server (tests/lsp/fake-server.mjs): `ERR:`, `WARN:`,
 * and `INFO:` markers in the text yield one diagnostic each at the marker
 * position.
 */
import type {
	ClientState,
	LspClientOptions,
	LspCrashInfo,
} from "../../extensions/lsp/client.ts";
import type { LspDiagnostic } from "../../extensions/lsp/types.ts";

export function diagsFromText(text: string): LspDiagnostic[] {
	const out: LspDiagnostic[] = [];
	const lines = text.split("\n");
	for (let line = 0; line < lines.length; line += 1) {
		const lineText = lines[line];
		for (const [marker, severity] of [
			["ERR", 1],
			["WARN", 2],
			["INFO", 3],
		] as const) {
			let index = lineText.indexOf(`${marker}:`);
			while (index !== -1) {
				const message = lineText.slice(index + marker.length + 1).trim();
				out.push({
					range: {
						start: { line, character: index },
						end: { line, character: Math.min(lineText.length, index + marker.length + 2) },
					},
					severity,
					message,
				});
				index = lineText.indexOf(`${marker}:`, index + 1);
			}
		}
	}
	return out;
}

interface FakeDoc {
	text: string;
}

export interface FakeClientScript {
	/**
	 * How the server answers diagnostics: "push" publishes after open and
	 * change (default), "pull" advertises diagnosticProvider and answers
	 * textDocument/diagnostic on demand, "none" is push but never publishes
		(exercises the partial-answer paths).
	*/
	mode?: "push" | "pull" | "none";
	/** Reject or resolve the ready promise this way (default: resolve). */
	ready?: "ok" | "fail";
	/** A ready request for diagnostics hangs past the timeout. */
	hangDiagnostics?: boolean;
	/** The client crashes (onCrash) after this many published documents. 0: never. */
	crashAfterPublishes?: number;
	/** The client fails to start and exits with this code. */
	startExitCode?: number;
	/**
	 * Wait this long between a document change and its publish: a slow
	 * server that may still be analyzing the pre-change state when the
	 * next change goes out.
	 */
	publishDelayMs?: number;
}

/**
 * One scripted server instance. Tests script its behavior and drive the
 * session's hooks; they never reach past it to the session internals.
 */
export class FakeLspClient {
	readonly label: string;
	readonly root: string;
	readonly ready: Promise<void>;
	state: ClientState = "starting";
	capabilities: Record<string, unknown> = {};
	/** Every didClose the client sent, in order. */
	readonly closedUris: string[] = [];
	/** The client's view of each document's text. */
	readonly docs = new Map<string, FakeDoc>();
	/** The latest publish per uri. */
	readonly lastPublished = new Map<string, LspDiagnostic[]>();
	/** Publish count per uri, the client's fence arithmetic. */
	private readonly publishSeq = new Map<string, number>();
	/** The publishSeq at the last didOpen/didChange per uri. */
	private readonly changeFence = new Map<string, number>();
	/** Publish count, for crash-after scripts. */
	publishCount = 0;
	started = false;

	private readonly onDiagnostics: (uri: string, diags: LspDiagnostic[]) => void;
	private readonly onCrash: (info: LspCrashInfo) => void;
	private readonly mode: "push" | "pull" | "none";
	/** The command the session asked the fake to run: what the real spawn would take. */
	readonly command: string;
	readonly args: string[];
	private dead = false;
	private crashedOnce = false;

	constructor(private readonly opts: LspClientOptions, private readonly script: FakeClientScript = {}) {
		this.label = opts.label;
		this.root = opts.root;
		this.command = opts.command;
		this.args = opts.args;
		this.mode = script.mode ?? "push";
		this.onDiagnostics = opts.onDiagnostics ?? (() => undefined);
		this.onCrash = opts.onCrash ?? (() => undefined);
		this.capabilities = this.mode === "pull" ? { diagnosticProvider: { interFileDependencies: false } } : {};
		this.ready = new Promise<void>((resolve, reject) => {
			if (script.ready === "fail" || script.startExitCode !== undefined) {
				setTimeout(
					() => reject(new Error(`fake: ${script.startExitCode !== undefined ? `start exited ${script.startExitCode}` : "start failed"}`)),
					1,
				);
			} else {
				setTimeout(resolve, 1);
			}
		});
		this.ready.catch(() => undefined);
	}

	/** The test's pump: the moment the server "becomes ready". */
	async waitForReady(): Promise<void> {
		await this.ready;
		this.state = "ready";
		this.started = true;
	}

	/** Crash this client (a second crash stays dead: the session restarts at most once). */
	crash(info: Partial<LspCrashInfo> = {}): void {
		if (this.dead) return;
		this.dead = true;
		this.state = "dead";
		this.onCrash({ code: info.code ?? 137, signal: info.signal ?? null, stderrTail: info.stderrTail ?? "fake crash" });
	}

	private requireReady(): void {
		if (this.state !== "ready") throw new Error(`fake: ${this.label} is not ready`);
	}

	async openDocument(uri: string, text: string): Promise<void> {
		this.requireReady();
		this.docs.set(uri, { text });
		this.fence(uri);
		this.afterDocChange(uri);
	}

	async updateDocument(uri: string, text: string): Promise<void> {
		this.requireReady();
		this.docs.set(uri, { text });
		this.fence(uri);
		this.afterDocChange(uri);
	}

	async closeDocument(uri: string): Promise<void> {
		this.requireReady();
		this.docs.delete(uri);
		this.closedUris.push(uri);
		this.lastPublished.delete(uri);
		this.publishSeq.delete(uri);
		this.changeFence.delete(uri);
		if (this.mode === "push") this.publishFor(uri, []);
	}

	/** Everything published so far predates the new content (the client's fence). */
	private fence(uri: string): void {
		this.changeFence.set(uri, this.publishSeq.get(uri) ?? 0);
	}

	/** True when the latest publish for the uri postdates its last change. */
	isFreshPublish(uri: string): boolean {
		return (this.publishSeq.get(uri) ?? 0) > (this.changeFence.get(uri) ?? 0);
	}

	async request<T>(method: string, _params: unknown, timeoutMs: number): Promise<T> {
		this.requireReady();
		if (this.dead) throw new Error(`fake: ${this.label} died`);
		if (method === "textDocument/diagnostic" && this.mode === "pull") {
			if (this.script.hangDiagnostics) {
				await new Promise((resolve) => setTimeout(resolve, timeoutMs + 500));
				throw new Error("fake: timeout");
			}
			const uri = String((_params as { textDocument: { uri: string } }).textDocument.uri);
			return { kind: "full", items: diagsFromText(this.docs.get(uri)?.text ?? "") } as T;
		}
		if (method === "textDocument/references") {
			return [] as T;
		}
		if (method === "textDocument/hover") {
			return { contents: { kind: "markdown", value: "fake hover" } } as T;
		}
		throw new Error(`fake: unknown method ${method}`);
	}

	/** Push-mode publish, the moment the fake server "finishes analyzing". */
	private afterDocChange(uri: string): void {
		if (this.mode !== "push") return;
		const text = this.docs.get(uri)?.text ?? "";
		const delay = this.script.publishDelayMs ?? 0;
		if (delay > 0) {
			setTimeout(() => this.publishFor(uri, diagsFromText(text)), delay);
			return;
		}
		this.publishFor(uri, diagsFromText(text));
	}

	private publishFor(uri: string, diagnostics: LspDiagnostic[]): void {
		if (this.mode === "none") return;
		this.publishCount += 1;
		this.publishSeq.set(uri, (this.publishSeq.get(uri) ?? 0) + 1);
		this.lastPublished.set(uri, diagnostics);
		this.onDiagnostics(uri, diagnostics);
		if (this.script.crashAfterPublishes !== undefined && this.publishCount >= this.script.crashAfterPublishes) {
			this.crash();
		}
	}

	async awaitPublished(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
		this.requireReady();
		// Only a publish that postdates the last change is an answer; a stale
		// publish for the previous content is skipped, like in the real client.
		if (this.isFreshPublish(uri)) return this.lastPublished.get(uri) ?? null;
		// Nothing fresh published yet: wait out the timeout and report the
		// nothing. A script that delays its publishes gets a cap that lets
		// them through, like a slow real server inside the request timeout.
		const cap = 200 + (this.script.publishDelayMs ?? 0);
		await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, cap)));
		return this.isFreshPublish(uri) ? (this.lastPublished.get(uri) ?? null) : null;
	}

	publishedDiagnostics(uri: string): LspDiagnostic[] | undefined {
		return this.lastPublished.get(uri);
	}

	/**
	 * Test helper: make the server "publish" an arbitrary state for a
	 * document, standing in for the moment a real server finishes a new
	 * analysis (for instance of a file the session does not sync).
	 */
	publishForTest(uri: string, diagnostics: LspDiagnostic[]): void {
		this.publishSeq.set(uri, (this.publishSeq.get(uri) ?? 0) + 1);
		this.lastPublished.set(uri, diagnostics);
		this.onDiagnostics(uri, diagnostics);
	}

	getStderrTail(): string {
		return this.script.startExitCode !== undefined ? `fake: start exited ${this.script.startExitCode}` : "";
	}

	async shutdown(): Promise<void> {
		if (this.dead) return;
		this.dead = true;
		this.state = "closed";
	}

	kill(): void {
		if (this.dead) return;
		this.dead = true;
		this.state = "closed";
	}
}
