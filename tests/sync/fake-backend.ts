/**
 * In-memory fake Backend at the single seam. Every test of manifest
 * selection, the three-way merge, the reference scanner, and the
 * init/push/pull/status orchestration runs against this; no test touches
 * the network.
 */
import { sha256Hex } from "../../extensions/sync/hash.ts";
import type { Backend, BaseState, BackendResult, Snapshot, SyncFile, SyncManifest } from "../../extensions/sync/types.ts";

export interface FakeBackendOptions {
	/** The stored Snapshot. Null = the target does not exist. */
	stored?: Snapshot | null;
	/** The id the target gets on create. */
	id?: string;
	/** When set, every call fails with this message (network/token failure). */
	failure?: string;
	/** When set with `failure`, only the named method fails. */
	failureFor?: "fetch" | "create" | "push";
}

export class FakeBackend implements Backend {
	stored: Snapshot | null;
	id: string;
	/** Every (method, gist-id) call, in order. */
	calls: { method: "fetch" | "create" | "push"; id?: string }[] = [];

	constructor(options: FakeBackendOptions = {}) {
		this.stored = options.stored ?? null;
		this.id = options.id ?? "gist-1";
		this.failure = options.failure ?? null;
		this.failureFor = options.failureFor ?? null;
	}

	failure: string | null;
	failureFor: "fetch" | "create" | "push" | null;

	private fails(method: "fetch" | "create" | "push"): boolean {
		return this.failure !== null && (this.failureFor === null || this.failureFor === method);
	}

	fetch(): Promise<BackendResult<Snapshot>> {
		this.calls.push({ method: "fetch", id: this.id });
		if (this.fails("fetch")) return Promise.resolve({ ok: false, code: "error", message: this.failure! });
		if (!this.stored) return Promise.resolve({ ok: false, code: "not-found", message: `gist ${this.id} not found` });
		return Promise.resolve({ ok: true, value: this.stored });
	}

	create(snapshot: Snapshot): Promise<BackendResult<string>> {
		this.calls.push({ method: "create" });
		if (this.fails("create")) return Promise.resolve({ ok: false, code: "error", message: this.failure! });
		this.stored = snapshot;
		return Promise.resolve({ ok: true, value: this.id });
	}

	push(snapshot: Snapshot): Promise<BackendResult<string>> {
		this.calls.push({ method: "push", id: this.id });
		if (this.fails("push")) return Promise.resolve({ ok: false, code: "error", message: this.failure! });
		if (!this.stored) return Promise.resolve({ ok: false, code: "not-found", message: `gist ${this.id} not found` });
		this.stored = snapshot;
		return Promise.resolve({ ok: true, value: this.id });
	}
}

/** Build a file for a fake tree or snapshot. */
export function file(path: string, content: string, mtimeMs = 1_000): SyncFile {
	return { path, content, mtimeMs, hash: sha256Hex(content) };
}

/** Build a Base state from files (what a previous push would have recorded). */
export function baseOf(files: SyncFile[], manifest?: SyncManifest): BaseState {
	const base: BaseState = {};
	for (const f of files) base[f.path] = { hash: f.hash, mtimeMs: f.mtimeMs };
	if (manifest) base["__manifest__"] = { hash: "manifest-hash", mtimeMs: 0 };
	return base;
}
