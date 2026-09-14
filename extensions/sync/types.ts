/**
 * Sync extension: cross-device pi config sync (issue #32).
 *
 * Domain terms (see CONTEXT.md, "Sync" section):
 *
 * Sync manifest - the config that names the sync Backend and the include and
 *                 exclude patterns. Default deny; excludes win over includes.
 *                 Part of the Snapshot, so one copy serves every device.
 * Snapshot      - the full set of files one sync run moves, selected by the
 *                 Sync manifest.
 * Backend       - the pluggable storage target a Snapshot is fetched from and
 *                 pushed to. v1 is a GitHub Gist.
 * Base state    - the tool-managed record the last push writes into the
 *                 Backend, holding per-file time and content hash. It is the
 *                 "before" side of every three-way merge.
 */

/**
 * Abstract key of the tool-managed Sync manifest in the three-way merge.
 * It is not a real file path: the local copy lives in the state directory
 * and the remote copy in a tool-managed gist file. The base state stores it
 * under this same key.
 */
export const MANIFEST_KEY = "__manifest__";

/** Home-relative path with POSIX slashes, no leading "./" or "/". */
export type SyncPath = string;

export interface SyncManifest {
	/** Manifest format version. Only 1 exists. */
	v: 1;
	/** Name of the active Backend, resolved from the in-repo modules. */
	backend: string;
	/** Backend options, e.g. { gistId: "abc123" } for the Gist backend. */
	backendOptions: Record<string, string>;
	/** Home-relative glob include patterns. Default deny. */
	include: string[];
	/** Home-relative glob exclude patterns. Excludes win over includes. */
	exclude: string[];
}

/** One file in a Snapshot or in the local tree. */
export interface SyncFile {
	/** Home-relative path (MANIFEST_KEY for the tool-managed manifest). */
	path: SyncPath;
	/** Text content. Gists are text only. */
	content: string;
	/** Modification time in milliseconds since the epoch. */
	mtimeMs: number;
	/** sha256 hex of content. */
	hash: string;
}

/** One entry of the Base state. */
export interface BaseEntry {
	hash: string;
	mtimeMs: number;
	/**
	 * Set when this push removed the path. The last known hash is kept so the
	 * other devices can tell "deleted after the last common truth" from
	 * "never there" and act on the deletion instead of resurrecting the file.
	 */
	deleted?: boolean;
}

/** Per-file record of the last push, keyed by path. Includes MANIFEST_KEY. */
export type BaseState = Record<SyncPath, BaseEntry>;

/** What a successful push produced. */
export interface PushResult {
	/** The target id. */
	id: string;
	/**
	 * Files the target held that the new Snapshot does not carry and the tool
	 * never managed (for example hand-added in the GitHub UI). The backend
	 * left them in place instead of deleting them; the caller reports them.
	 */
	kept: string[];
}

/** The full Snapshot a Backend stores. */
export interface Snapshot {
	/** Tool-managed. Null only for a hand-created Backend without one. */
	manifest: SyncManifest | null;
	/** Tool-managed record of the last push. Null when never pushed. */
	base: BaseState | null;
	/** User content files. Never includes tool-managed entries. */
	files: SyncFile[];
	/** When the Backend target was last updated. Backend-specific granularity. */
	updatedAtMs?: number;
}

export type BackendResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: "not-found" | "error"; message: string };

/**
 * The single Backend seam. One interface: fetch the stored Snapshot, create
 * the target from a Snapshot, or replace the stored Snapshot. All merge and
 * command logic programs against this interface and its in-memory fake; a
 * second storage target is a new in-repo module implementing it.
 */
export interface Backend {
	/** Fetch the stored Snapshot. "not-found" when the target does not exist. */
	fetch(): Promise<BackendResult<Snapshot>>;
	/** Create the target from a Snapshot. Resolves to the target id. */
	create(snapshot: Snapshot): Promise<BackendResult<string>>;
	/**
	 * Replace the stored Snapshot. Resolves to the target id plus the files
	 * the target held that the Snapshot does not carry and that the backend
	 * kept in place instead of deleting (it never deletes files it does not
	 * manage).
	 */
	push(snapshot: Snapshot): Promise<BackendResult<PushResult>>;
}
