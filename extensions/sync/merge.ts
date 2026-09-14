/**
 * Three-way merge: local vs remote vs Base state.
 *
 * Pure function over three maps of path -> { hash, mtimeMs, content }.
 * "changed" always means "differs from the Base state". Rules (issue #32):
 *
 *  - changed only remotely, unchanged locally: take remote
 *  - changed only locally: keep local (the next push carries it)
 *  - changed on both sides: the newer modification time wins; the loser is
 *    kept as a backup file next to the path; ties keep local, so a pull
 *    never clobbers a same-second local edit
 *  - local-only files stay; remote-only files are applied
 *  - on a fresh device (first join), a remote file missing locally is
 *    adopted instead of read as a local deletion
 *  - deletion on one side, other side unchanged: the deletion applies
 *  - deletion on one side, other side modified: the modified copy becomes a
 *    backup file and the deletion applies
 *  - a Base entry marked deleted (the file was removed by the push that
 *    recorded the Base) acts like a remote deletion: unchanged local copies
 *    are deleted, modified local copies are backed up first
 *
 * The tool-managed manifest participates as the MANIFEST_KEY path like any
 * other file; the orchestrator reports its actions separately.
 */
import { MANIFEST_KEY, type SyncPath } from "./types.ts";

export interface MergeFile {
	hash: string;
	mtimeMs: number;
	/** Present on the local and remote sides. The Base side is hash+mtime only. */
	content?: string;
	/** Base side: the push that recorded the Base removed this path. */
	deleted?: boolean;
}

export type SideMap = Map<SyncPath, MergeFile>;

export type MergeAction =
	| {
			kind: "write";
			path: SyncPath;
			content: string;
			mtimeMs: number;
			reason: "remote-change" | "remote-only" | "conflict-remote-wins" | "converged";
	  }
	| { kind: "keep"; path: SyncPath; reason: "local-change" | "local-only" | "conflict-local-wins" }
	| { kind: "delete"; path: SyncPath; reason: "remote-delete" | "delete-vs-modify" }
	| { kind: "backup"; path: SyncPath; source: "local" | "remote"; content: string };

export interface MergeConflict {
	path: SyncPath;
	kind: "modified-both" | "delete-modified";
	/** Whose state survives: the local file, the remote content, or deletion. */
	winner: "local" | "remote" | "delete";
	/** True when a backup file is written for the loser. */
	backedUp: boolean;
}

export interface MergePlan {
	/** Ordered, deterministic. Apply all of it or none. */
	actions: MergeAction[];
	conflicts: MergeConflict[];
	/** User-facing drift buckets (MANIFEST_KEY excluded by the caller). */
	changedLocal: SyncPath[];
	localOnly: SyncPath[];
	localDeleted: SyncPath[];
	changedRemote: SyncPath[];
	remoteOnly: SyncPath[];
	remoteDeleted: SyncPath[];
}

function changed(side: MergeFile | undefined, base: MergeFile | undefined): boolean {
	return side !== undefined && base !== undefined && side.hash !== base.hash;
}

export interface MergeOptions {
	/**
	 * True when the local device is joining for the first time (no local
	 * manifest yet). A file that is on the remote but missing locally is then
	 * adopted (written), not read as a local deletion: an empty home is not a
	 * user who deleted everything.
	 */
	fresh?: boolean;
}

export function merge(base: SideMap, local: SideMap, remote: SideMap, options: MergeOptions = {}): MergePlan {
	const plan: MergePlan = {
		actions: [],
		conflicts: [],
		changedLocal: [],
		localOnly: [],
		localDeleted: [],
		changedRemote: [],
		remoteOnly: [],
		remoteDeleted: [],
	};

	const paths = new Set<SyncPath>([...base.keys(), ...local.keys(), ...remote.keys()]);
	for (const path of [...paths].sort()) {
		const b = base.get(path);
		const l = local.get(path);
		const r = remote.get(path);
		const lChanged = changed(l, b);
		const rChanged = changed(r, b);

		if (path === MANIFEST_KEY && !l) {
			// The device has no local manifest copy yet (joining): the operation
			// adopts the manifest explicitly, so the merge does nothing here.
			continue;
		}

		if (!b) {
			// No Base entry: at least one side created the file after the last push.
			if (l && !r) {
				plan.localOnly.push(path);
				plan.actions.push({ kind: "keep", path, reason: "local-only" });
			} else if (r && !l) {
				plan.remoteOnly.push(path);
				plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "remote-only" });
			} else if (l && r) {
				// Both created it without a Base entry: resolve like a both-sides change.
				applyBothSides(plan, path, l, r);
			}
			continue;
		}

		if (b.deleted === true) {
			// The push that recorded the Base removed this path.
			if (!r) {
				if (l && l.hash !== b.hash) {
					plan.conflicts.push({ path, kind: "delete-modified", winner: "delete", backedUp: true });
					plan.actions.push({ kind: "backup", path, source: "local", content: l.content ?? "" });
					plan.actions.push({ kind: "delete", path, reason: "delete-vs-modify" });
				} else if (l) {
					plan.remoteDeleted.push(path);
					plan.actions.push({ kind: "delete", path, reason: "remote-delete" });
				}
			} else if (!l) {
				// A newer push restored it; this side never had the restored copy.
				plan.remoteOnly.push(path);
				plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "remote-only" });
			} else if (l.hash === r.hash) {
				continue; // both sides hold the restored content
			} else {
				applyBothSides(plan, path, l, r);
			}
			continue;
		}

		if (l && r) {
			if (!lChanged && !rChanged) continue;
			if (lChanged && !rChanged) {
				plan.changedLocal.push(path);
				plan.actions.push({ kind: "keep", path, reason: "local-change" });
			} else if (rChanged && !lChanged) {
				plan.changedRemote.push(path);
				plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "remote-change" });
			} else if (l.hash === r.hash) {
				// Both changed to the same content: converged. Normalize mtime, no backup.
				plan.changedRemote.push(path);
				plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "converged" });
			} else {
				applyBothSides(plan, path, l, r);
			}
		} else if (l && !r) {
			// Deletion on the remote side.
			if (lChanged) {
				plan.conflicts.push({ path, kind: "delete-modified", winner: "delete", backedUp: true });
				plan.actions.push({ kind: "backup", path, source: "local", content: l.content ?? "" });
				plan.actions.push({ kind: "delete", path, reason: "delete-vs-modify" });
			} else {
				plan.remoteDeleted.push(path);
				plan.actions.push({ kind: "delete", path, reason: "remote-delete" });
			}
		} else if (r && !l) {
			if (options.fresh) {
				// Joining device: adopt everything the shared tree has.
				plan.remoteOnly.push(path);
				plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "remote-only" });
			} else if (rChanged) {
				plan.conflicts.push({ path, kind: "delete-modified", winner: "delete", backedUp: true });
				plan.actions.push({ kind: "backup", path, source: "remote", content: r.content ?? "" });
			} else {
				plan.localDeleted.push(path);
				// The deletion already applied locally: nothing to do.
			}
		}
		// else: in the Base only - deleted on both sides. Nothing to do.
	}
	return plan;
}

function applyBothSides(plan: MergePlan, path: SyncPath, l: MergeFile, r: MergeFile): void {
	// Newer modification time wins. Ties keep local (documented choice).
	const remoteWins = r.mtimeMs > l.mtimeMs;
	if (remoteWins) {
		plan.conflicts.push({ path, kind: "modified-both", winner: "remote", backedUp: true });
		plan.actions.push({ kind: "backup", path, source: "local", content: l.content ?? "" });
		plan.actions.push({ kind: "write", path, content: r.content ?? "", mtimeMs: r.mtimeMs, reason: "conflict-remote-wins" });
		plan.changedRemote.push(path);
	} else {
		plan.conflicts.push({ path, kind: "modified-both", winner: "local", backedUp: true });
		plan.actions.push({ kind: "backup", path, source: "remote", content: r.content ?? "" });
		plan.actions.push({ kind: "keep", path, reason: "conflict-local-wins" });
		plan.changedLocal.push(path);
	}
}

/** True when the plan has at least one action that changes the local tree. */
export function planMutatesLocal(plan: MergePlan): boolean {
	return plan.actions.some((a) => a.kind !== "keep");
}

export { MANIFEST_KEY };
