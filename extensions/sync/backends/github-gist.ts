/**
 * The Gist Backend: one secret GitHub gist, one file per Snapshot item with
 * paths as-is, so the config can be read and hand-edited in the GitHub UI.
 *
 * The two tool-managed files sit at the gist root: the Sync manifest and the
 * Base state. User files keep their home-relative paths as gist file names.
 *
 * All GitHub traffic goes through the GistTransport seam: the default
 * transport is fetch; tests stub it and assert on the payloads sent and the
 * snapshot produced from a recorded response. No other module in the sync
 * extension sees the gist's shape.
 */
import { sha256Hex } from "../hash.ts";
import { canonicalManifestText } from "../manifest.ts";
import type { Backend, BackendResult, BaseState, PushResult, Snapshot, SyncFile, SyncManifest, SyncPath } from "../types.ts";

export const GIST_BACKEND_NAME = "github-gist";
export const GIST_MANIFEST_FILE = ".pi-sync-manifest.json";
export const GIST_BASE_FILE = ".pi-sync-base-state.json";
/** Gist limits: 10 MB total, 20 files, text only. */
export const GIST_MAX_BYTES = 10 * 1024 * 1024;
export const GIST_MAX_FILES = 20;
export const GIST_DESCRIPTION = "pi sync: cross-device pi config (managed by pi-sync)";

export interface GistTransport {
	request(
		method: "GET" | "POST" | "PUT",
		url: string,
		options: { headers: Record<string, string>; body?: string; signal?: AbortSignal },
	): Promise<{ status: number; text: string }>;
}

/** The default transport: Node's global fetch. */
export function createFetchTransport(): GistTransport {
	return {
		async request(method, url, options) {
			const response = await fetch(url, {
				method,
				headers: options.headers,
				body: options.body,
				signal: options.signal,
			});
			return { status: response.status, text: await response.text() };
		},
	};
}

export interface GistBackendOptions {
	/** The gist id. Absent only for a first push that creates the gist. */
	gistId?: string;
	token: string;
	/** GitHub API base. Overridable for tests and GitHub-compatible hosts. */
	baseUrl?: string;
	transport?: GistTransport;
	signal?: AbortSignal;
}

interface GistFileShape {
	filename?: string;
	content?: string | null;
	raw_url?: string;
}

interface GistShape {
	id?: string;
	updated_at?: string;
	files?: Record<string, GistFileShape>;
}

export function createGistBackend(options: GistBackendOptions): Backend {
	const baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
	const transport = options.transport ?? createFetchTransport();

	async function github<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
		const response = await transport.request(method, `${baseUrl}${path}`, {
			headers: {
				Authorization: `Bearer ${options.token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "pi-sync",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: options.signal,
		});
		let json: unknown = null;
		try {
			json = JSON.parse(response.text);
		} catch {
			// Non-JSON body: the raw text goes into the error below.
		}
		if (response.status === 404) {
			throw new GistError("not-found", `HTTP 404`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new GistError("error", `GitHub rejected the token (HTTP ${response.status}). Check that it is valid and has gist scope.`);
		}
		if (response.status < 200 || response.status >= 300) {
			const detail =
				typeof json === "object" && json !== null && "message" in json
					? String((json as { message: unknown }).message)
					: response.text.slice(0, 200);
			throw new GistError("error", `GitHub API error (HTTP ${response.status}): ${detail}`);
		}
		return json as T;
	}

	/** Gist file content, falling back to the raw URL for files the API omits. */
	async function fileContent(file: GistFileShape): Promise<string> {
		if (file.content !== undefined && file.content !== null) return file.content;
		if (!file.raw_url) return "";
		const response = await transport.request("GET", file.raw_url, {
			headers: { Authorization: `Bearer ${options.token}`, "User-Agent": "pi-sync" },
			signal: options.signal,
		});
		if (response.status < 200 || response.status >= 300) {
			throw new GistError("error", `could not read gist file content (HTTP ${response.status})`);
		}
		return response.text;
	}

	async function fetch(): Promise<BackendResult<Snapshot>> {
		if (!options.gistId) return { ok: false, code: "not-found", message: "no gist id configured" };
		try {
			const gist = await github<GistShape>("GET", `/gists/${options.gistId}`);
			return { ok: true, value: await snapshotFromGist(gist, fileContent) };
		} catch (err) {
			return mapError(err, options.gistId);
		}
	}

	async function create(snapshot: Snapshot): Promise<BackendResult<string>> {
		try {
			const limitError = gistLimitError(snapshot);
			if (limitError) throw new GistError("error", limitError);
			const created = await github<GistShape>("POST", "/gists", {
				description: GIST_DESCRIPTION,
				public: false,
				files: toGistPayload(snapshot).files,
			});
			if (typeof created.id !== "string") throw new GistError("error", "GitHub created a gist but returned no id");
			return { ok: true, value: created.id };
		} catch (err) {
			return mapError(err, options.gistId ?? "<new>");
		}
	}

	async function push(snapshot: Snapshot): Promise<BackendResult<PushResult>> {
		if (!options.gistId) {
			return { ok: false, code: "error", message: "no gist id configured; run the first push to create the gist" };
		}
		try {
			const limitError = gistLimitError(snapshot);
			if (limitError) throw new GistError("error", limitError);
			// Gist updates replace the named files. Files the gist still has
			// that the Snapshot drops are handled by name:
			//  - the Base state marks them deleted (a tool-managed deletion):
			//    name them null so the deletion propagates
			//  - otherwise they are unmanaged (hand-added in the GitHub UI):
			//    leave them in place and report them; never delete user data
			const current = await github<GistShape>("GET", `/gists/${options.gistId}`);
			const payload = toGistPayload(snapshot);
			const kept: string[] = [];
			for (const name of Object.keys(current.files ?? {}).sort()) {
				if (name in payload.files) continue;
				if (snapshot.base?.[name]?.deleted === true) {
					payload.files[name] = null;
				} else {
					kept.push(name);
				}
			}
			const updated = await github<GistShape>("PUT", `/gists/${options.gistId}`, { files: payload.files });
			if (typeof updated.id !== "string") throw new GistError("error", "GitHub updated a gist but returned no id");
			return { ok: true, value: { id: updated.id, kept } };
		} catch (err) {
			return mapError(err, options.gistId);
		}
	}

	return { fetch, create, push };
}

class GistError extends Error {
	readonly code: "not-found" | "error";
	constructor(code: "not-found" | "error", message: string) {
		super(message);
		this.code = code;
	}
}

function mapError(err: unknown, gistId: string): BackendResult<never> {
	if (err instanceof GistError) {
		return {
			ok: false,
			code: err.code,
			message: err.code === "not-found" ? `gist ${gistId} not found: ${err.message}` : err.message,
		};
	}
	if (err instanceof Error && err.name === "AbortError") {
		return { ok: false, code: "error", message: "timed out waiting for GitHub" };
	}
	return { ok: false, code: "error", message: `GitHub request failed: ${err instanceof Error ? err.message : String(err)}` };
}

/** Build the gist file map for a Snapshot: paths as-is, tool-managed at the root. */
export function toGistPayload(snapshot: Snapshot): { files: Record<string, { content: string } | null>; totalBytes: number } {
	const files: Record<string, { content: string } | null> = {};
	let totalBytes = 0;
	for (const file of snapshot.files) {
		files[file.path] = { content: file.content };
		totalBytes += Buffer.byteLength(file.content, "utf8");
	}
	// The shared gist manifest is the canonical form: no device-local gist id.
	const manifestText = snapshot.manifest ? canonicalManifestText(snapshot.manifest) : "";
	const baseText = snapshot.base ? `${JSON.stringify(snapshot.base, null, 2)}\n` : "";
	files[GIST_MANIFEST_FILE] = { content: manifestText };
	files[GIST_BASE_FILE] = { content: baseText };
	totalBytes += Buffer.byteLength(manifestText, "utf8") + Buffer.byteLength(baseText, "utf8");
	return { files, totalBytes };
}

/** Check the gist limits before spending an API call. */
export function gistLimitError(snapshot: Snapshot): string | null {
	const fileCount = snapshot.files.length + 2;
	if (fileCount > GIST_MAX_FILES) {
		return `gist holds at most ${GIST_MAX_FILES} files; the snapshot has ${snapshot.files.length} user files plus 2 tool-managed. Narrow the include patterns or move a directory out of the Snapshot.`;
	}
	if (toGistPayload(snapshot).totalBytes > GIST_MAX_BYTES) {
		return `gist content is at most ${GIST_MAX_BYTES} bytes total; the snapshot is larger. Move large files out of the Snapshot.`;
	}
	return null;
}

/** Map a recorded gist response to a Snapshot. */
export async function snapshotFromGist(
	gist: GistShape,
	readContent: (file: GistFileShape) => Promise<string>,
): Promise<Snapshot> {
	const files = gist.files ?? {};
	const manifestFile: GistFileShape | undefined = files[GIST_MANIFEST_FILE];
	const baseFile: GistFileShape | undefined = files[GIST_BASE_FILE];

	let manifest: SyncManifest | null = null;
	if (manifestFile) {
		const text = await readContent(manifestFile);
		try {
			manifest = JSON.parse(text) as SyncManifest;
		} catch {
			manifest = null;
		}
	}
	let base: BaseState | null = null;
	if (baseFile) {
		const text = await readContent(baseFile);
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null) base = parsed as BaseState;
		} catch {
			base = null;
		}
	}

	// Gist files carry no per-file mtime. The Base state records the
	// modification time the pushing device saw, so the remote side of a
	// conflict compares against the pusher's clock. Files added by hand fall
	// back to the gist's last update time.
	const fallbackMtime = Date.parse(gist.updated_at ?? "") || 0;
	const syncFiles: SyncFile[] = [];
	for (const [name, file] of Object.entries(files)) {
		if (name === GIST_MANIFEST_FILE || name === GIST_BASE_FILE) continue;
		const content = await readContent(file);
		const entry = base?.[name];
		syncFiles.push({ path: name as SyncPath, content, mtimeMs: entry?.mtimeMs ?? fallbackMtime, hash: sha256Hex(content) });
	}
	syncFiles.sort((a, b) => a.path.localeCompare(b.path));
	return { manifest, base, files: syncFiles, updatedAtMs: Date.parse(gist.updated_at ?? "") || undefined };
}
