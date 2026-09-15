/**
 * Sync operations: init, push, pull, status.
 *
 * Everything here programs against the Backend seam and the pure merge; the
 * only device facts are the home directory, the state directory, and the
 * backend factory the wiring supplies. Failure safety: every operation
 * finishes all network reads before the first local write, and a push
 * uploads the merged tree before it applies it locally, so a network or
 * token failure always leaves the local tree untouched.
 */
import { applyPlan, collectLocalFiles, localManifestFile, readLocalBase, readLocalManifest, writeLocalBase, writeLocalManifest, type ApplyResult } from "./localfs.ts";
import { merge, planMutatesLocal, type MergePlan, type SideMap } from "./merge.ts";
import { DEFAULT_MANIFEST, canonicalManifest, canonicalManifestText, isPathIncluded, parseManifest } from "./manifest.ts";
import { scanReferences } from "./refs.ts";
import { sha256Hex } from "./hash.ts";
import { MANIFEST_KEY, type Backend, type BaseState, type Snapshot, type SyncFile, type SyncManifest } from "./types.ts";

/** Everything one operation needs. The wiring (CLI, pi commands) builds it. */
export interface SyncRuntime {
	home: string;
	stateDir: string;
	buildBackend: (manifest: SyncManifest, extra?: { gistId?: string; signal?: AbortSignal }) => Backend;
}

export interface SyncReport {
	operation: "init" | "push" | "pull" | "status";
	gistId?: string;
	/** Files this device has that the Base state does not (user files). */
	ahead: number;
	/** Files the Backend has that the Base state does not (user files). */
	behind: number;
	/** Human-readable report, one line each. */
	lines: string[];
	warnings: string[];
}

export type SyncOutcome =
	| { ok: true; report: SyncReport; /** The preview, present when consent was given ahead of time (--yes, --force) and the caller still owes the user a look. */ preview?: string[] }
	| { ok: false; error: string; preview?: string[] };

function fail(message: string, preview?: string[]): SyncOutcome {
	return preview ? { ok: false, error: message, preview } : { ok: false, error: message };
}

/**
 * The consent options for init (issue #35). No confirmation, no write:
 * a TUI or tty shows the preview and asks; a non-tty run needs the explicit
 * yes flag. Re-init on an already-joined device confirms as well; the force
 * flag bypasses the confirm.
 */
export interface InitOptions {
	/** Explicit consent: the CLI --yes flag, or the TUI confirm button. */
	yes?: boolean;
	/** Bypass the confirm on a re-init of an already-joined device. */
	force?: boolean;
	/**
	 * Interactive consent: shows the preview and asks. Absent on non-tty
	 * runs and print/RPC pi modes; without it and without yes, nothing is
	 * written and the failure carries the preview for the report.
	 */
	ask?: (previewLines: string[]) => Promise<boolean>;
}

async function obtainConsent(preview: string[], opts: InitOptions, forceAllowed: boolean): Promise<{ ok: true; previewShown: boolean } | { ok: false; error: string }> {
	// Consent given ahead of time: the caller must still show the preview;
	// the preview is part of the consent, never skippable.
	if (opts.yes || (forceAllowed && opts.force)) return { ok: true, previewShown: false };
	if (opts.ask) {
		const yes = await opts.ask(preview);
		return yes ? { ok: true, previewShown: true } : { ok: false, error: "init declined; nothing was written" };
	}
	return { ok: false, error: "no confirmation given; nothing was written. Run in a terminal to confirm at the prompt, or pass --yes." };
}

/** The preview for the create path: what would go into the new secret gist. */
function createPreview(manifest: SyncManifest, files: SyncFile[]): string[] {
	const lines = [
		"pi sync init (new gist) - preview, nothing written yet",
		`in scope: ${manifest.include.length} include pattern(s): ${manifest.include.join(", ")}`,
		`sending: ${files.length} file(s) to the new secret gist`,
	];
	if (files.length > 0) lines.push(...files.map((f) => `  ${f.path}`));
	lines.push("no local files will be replaced or deleted");
	return lines;
}

/** The preview for the join path: what arrives and what it does locally. */
function joinPreview(gistId: string, manifest: SyncManifest, arriving: number, replaced: string[], deleted: string[]): string[] {
	const lines = [
		`pi sync init (gist ${gistId}) - preview, nothing written yet`,
		`in scope: ${manifest.include.length} include pattern(s): ${manifest.include.join(", ")}`,
		`arriving: ${arriving} file(s) from the shared tree`,
	];
	if (replaced.length > 0) {
		lines.push("will replace local:", ...replaced.map((p) => `  ${p}`));
	} else {
		lines.push("no local files will be replaced");
	}
	if (deleted.length > 0) lines.push("will delete local:", ...deleted.map((p) => `  ${p}`));
	return lines;
}

interface LocalSide {
	manifest: SyncManifest;
	/** The local manifest copy as a merge file. Null when it does not exist yet. */
	manifestFile: SyncFile | null;
	files: SyncFile[];
	collectWarnings: string[];
	hasLocalManifest: boolean;
	/** The Base this device last synced. Null before the first successful sync. */
	base: BaseState | null;
}

async function loadLocal(rt: SyncRuntime, manifestOverride?: SyncManifest): Promise<LocalSide | { error: string }> {
	const read = await readLocalManifest(rt.stateDir);
	if (read.error) return { error: read.error };
	const baseRead = await readLocalBase(rt.stateDir);
	if (baseRead.error) return { error: baseRead.error };
	const manifest = manifestOverride ?? read.manifest ?? DEFAULT_MANIFEST;
	const collected = await collectLocalFiles(manifest, rt.home);
	const manifestFile = read.manifest ? await localManifestFile(read.manifest, rt.stateDir) : null;
	return {
		manifest,
		manifestFile,
		files: collected.files,
		collectWarnings: collected.warnings,
		hasLocalManifest: read.manifest !== undefined,
		base: baseRead.base ?? null,
	};
}

/**
 * The merge Base: the Base this device last synced. A device that has a
 * manifest but lost its Base record falls back to the newest shared Base.
 */
function mergeBase(local: LocalSide, remote: RemoteSide): BaseState | null {
	return local.base ?? remote.base;
}

function filesToSideMap(files: SyncFile[]): SideMap {
	const map: SideMap = new Map();
	for (const file of files) map.set(file.path, { hash: file.hash, mtimeMs: file.mtimeMs, content: file.content });
	return map;
}

function baseToSideMap(base: BaseState | null): SideMap {
	const map: SideMap = new Map();
	if (base) {
		for (const [path, entry] of Object.entries(base)) {
			if (entry && typeof entry.hash === "string" && typeof entry.mtimeMs === "number") {
				map.set(path, { hash: entry.hash, mtimeMs: entry.mtimeMs });
			}
		}
	}
	return map;
}

interface RemoteSide {
	manifest: SyncManifest;
	files: SyncFile[];
	base: BaseState | null;
	updatedAtMs: number;
}

async function loadRemote(backend: Backend, fallbackGistId?: string): Promise<RemoteSide | { error: string }> {
	const fetched = await backend.fetch();
	if (!fetched.ok) {
		const suffix = fetched.code === "not-found" && fallbackGistId ? ` The gist may have been deleted, or the id in the manifest is wrong.` : "";
		return { error: `${fetched.message}.${suffix}` };
	}
	const snapshot: Snapshot = fetched.value;
	if (!snapshot.manifest) {
		return { error: "the gist has no tool-managed sync manifest (.pi-sync-manifest.json); it does not look like a pi sync target" };
	}
	return {
		manifest: snapshot.manifest,
		files: snapshot.files,
		base: snapshot.base,
		updatedAtMs: snapshot.updatedAtMs ?? 0,
	};
}

function planMerge(base: BaseState | null, local: LocalSide, remote: RemoteSide, fresh = false): MergePlan {
	const localMap = filesToSideMap(local.files);
	if (local.manifestFile) localMap.set(MANIFEST_KEY, { hash: local.manifestFile.hash, mtimeMs: local.manifestFile.mtimeMs, content: local.manifestFile.content });
	// The manifest is the single source of truth for what syncs. Files the
	// shared tree holds that neither manifest covers (for example
	// hand-added in the GitHub UI) are unmanaged: the merge ignores them,
	// no device applies them locally, and the backend keeps them in place
	// and reports them on push instead of deleting them.
	const covered = (path: string) => isPathIncluded(path, local.manifest) || isPathIncluded(path, remote.manifest);
	const remoteMap = filesToSideMap(remote.files.filter((f) => covered(f.path)));
	const manifestText = canonicalManifestText(remote.manifest);
	remoteMap.set(MANIFEST_KEY, {
		hash: sha256Hex(manifestText),
		mtimeMs: remote.base?.[MANIFEST_KEY]?.mtimeMs ?? remote.updatedAtMs,
		content: manifestText,
	});
	return merge(baseToSideMap(base), localMap, remoteMap, { fresh });
}

/** The manifest that is in force after the merge runs. */
function manifestAfterMerge(local: LocalSide, plan: MergePlan): SyncManifest {
	const action = plan.actions.find((a) => a.path === MANIFEST_KEY);
	if (action && action.kind === "write") {
		const parsed = parseManifest(action.content);
		if (parsed.ok) return parsed.manifest;
	}
	return local.manifest;
}

/** Count user-file drift, ignoring the tool-managed manifest. */
function driftCounts(plan: MergePlan): { ahead: number; behind: number } {
	const isUser = (path: string) => path !== MANIFEST_KEY;
	return {
		ahead: plan.changedLocal.filter(isUser).length + plan.localOnly.filter(isUser).length + plan.localDeleted.filter(isUser).length,
		behind: plan.changedRemote.filter(isUser).length + plan.remoteOnly.filter(isUser).length + plan.remoteDeleted.filter(isUser).length,
	};
}

/** Translate the plan's manifest action into a tool-managed report line. */
function toolManagedLine(plan: MergePlan, applied: boolean): string | null {
	const action = plan.actions.find((a) => a.path === MANIFEST_KEY);
	if (!action) return null;
	if (action.kind === "write") {
		return `sync manifest updated from remote (tool-managed${applied ? "" : "; will apply on next push or pull"})`;
	}
	if (action.kind === "keep" && action.reason === "local-change") {
		return `sync manifest changed locally (tool-managed; push to share it)`;
	}
	return null;
}

/** Human-readable lines for the user-file actions of a plan. */
function planLines(plan: MergePlan, backups: { forPath: string; backupPath: string }[], applied: boolean): string[] {
	const lines: string[] = [];
	const backupFor = (path: string): string | undefined => backups.find((b) => b.forPath === path)?.backupPath;
	for (const action of plan.actions) {
		if (action.path === MANIFEST_KEY) continue;
		const tense = applied ? "" : " (will apply on next push or pull)";
		switch (action.kind) {
			case "write":
				switch (action.reason) {
					case "remote-change":
						lines.push(`take remote ${action.path}${tense}`);
						break;
					case "remote-only":
						lines.push(`new from remote ${action.path}${tense}`);
						break;
					case "conflict-remote-wins":
						lines.push(`conflict ${action.path}: remote is newer, take remote${tense}; local copy kept at ${backupFor(action.path) ?? "a .bak file"}`);
						break;
					case "converged":
						lines.push(`both sides wrote the same content ${action.path}; mtime normalized${tense}`);
						break;
				}
				break;
			case "keep":
				switch (action.reason) {
					case "local-change":
						lines.push(`keep local ${action.path} (changed locally; push to send it)`);
						break;
					case "conflict-local-wins":
						lines.push(`conflict ${action.path}: local is newer, keep local${tense}; remote copy kept at ${backupFor(action.path) ?? "a .bak file"}`);
						break;
					case "local-only":
						lines.push(`local only ${action.path} (not on remote; push to send it)`);
						break;
				}
				break;
			case "delete":
				if (action.reason === "remote-delete") {
					lines.push(`delete ${action.path} (deleted on remote, local unchanged)${tense}`);
				} else {
					lines.push(`delete ${action.path} (deleted on one side, modified on the other); surviving copy kept at ${backupFor(action.path) ?? "a .bak file"}${tense}`);
				}
				break;
			case "backup":
				break; // covered by the conflict/delete lines
		}
	}
	for (const path of plan.localDeleted) {
		if (path !== MANIFEST_KEY && !plan.conflicts.some((c) => c.path === path)) {
			lines.push(`deleted locally ${path} (will remove from remote on next push)`);
		}
	}
	return lines;
}

function reportFor(operation: SyncReport["operation"], gistId: string | undefined, plan: MergePlan, lines: string[], warnings: string[]): SyncReport {
	const { ahead, behind } = driftCounts(plan);
	return { operation, gistId, ahead, behind, lines, warnings };
}

/**
 * The init step of the Sync wizard (issues #35, #37, #39).
 *
 * With a gist id it pairs: fetch the shared tree, preview what arrives,
 * confirm, then adopt. Without an id it creates: use the local manifest when
 * one exists in the state dir, else the default, preview what would be sent,
 * confirm, then create the secret gist. There is exactly one create path, and
 * it always goes through the preview-and-confirm step; no confirmation, no
 * write. Re-init on an already-joined device confirms as well.
 */
export async function runInit(rt: SyncRuntime, gistId: string | undefined, opts: InitOptions = {}): Promise<SyncOutcome> {
	const existing = await readLocalManifest(rt.stateDir);
	if (existing.error) return fail(existing.error);

	// ---- The create path: no gist id given. ----
	if (!gistId) {
		const localGistId = existing.manifest?.backendOptions.gistId;
		if (existing.manifest && localGistId) {
			return fail(`this device already joined gist ${localGistId}. Use pi-sync init <gist-id> to re-join, or pi-sync push to sync.`);
		}
		// The local manifest wins when present (for example a hand-tuned
		// include list), else the default (issue #39).
		const manifest = existing.manifest ?? DEFAULT_MANIFEST;
		const collected = await collectLocalFiles(manifest, rt.home);
		const preview = createPreview(manifest, collected.files);
		const consent = await obtainConsent(preview, opts, false);
		if (!consent.ok) return fail(consent.error, preview);

		const backend = rt.buildBackend(manifest);
		const base = baseStateOf(collected.files, manifest, null, 0);
		const created = await backend.create({ manifest: canonicalManifest(manifest), base, files: collected.files, updatedAtMs: undefined });
		if (!created.ok) return fail(`init failed while creating the gist: ${created.message}`);
		await writeLocalManifest(rt.stateDir, {
			...manifest,
			backendOptions: { ...manifest.backendOptions, gistId: created.value },
		});
		await writeLocalBase(rt.stateDir, base);
		const lines = [
			"pi sync init (new gist)",
			`created secret gist ${created.value}`,
			`pushed ${collected.files.length} file(s)`,
			`on each other device, join with: pi-sync init ${created.value}`,
		];
		return { ok: true, report: reportFor("init", created.value, emptyPlan(), lines, [...collected.warnings, ...refWarningLines(collected.files)]), preview: consent.previewShown ? undefined : preview };
	}

	// ---- The join (pairing) path: fetch, preview, confirm, adopt. ----
	const backend = rt.buildBackend(DEFAULT_MANIFEST, { gistId });
	const remote = await loadRemote(backend, gistId);
	if ("error" in remote) return fail(remote.error);

	// Capture freshness before the adopted manifest makes this device look joined.
	const fresh = existing.manifest === undefined;
	const local = await loadLocal(rt, remote.manifest);
	if ("error" in local) return fail(local.error);
	// The manifest was just adopted from the remote: it is not a local change.
	local.manifestFile = null;

	const plan = planMerge(remote.base, local, remote, fresh);
	const localPaths = new Set(local.files.map((f) => f.path));
	const replaced: string[] = [];
	const deleted: string[] = [];
	for (const action of plan.actions) {
		if (action.path === MANIFEST_KEY) continue;
		if (action.kind === "write" && localPaths.has(action.path)) replaced.push(action.path);
		if (action.kind === "delete") deleted.push(action.path);
	}
	const preview = joinPreview(gistId, remote.manifest, remote.files.length, replaced, deleted);
	const consent = await obtainConsent(preview, opts, true);
	if (!consent.ok) return fail(consent.error, preview);

	// The shared manifest carries no device-local gist id; record this device's.
	await writeLocalManifest(rt.stateDir, {
		...remote.manifest,
		backendOptions: { ...remote.manifest.backendOptions, gistId },
	});
	let apply: ApplyResult = { backups: [] };
	if (planMutatesLocal(plan)) {
		try {
			apply = await applyPlan(plan, rt.home, rt.stateDir);
		} catch (err) {
			return fail(`init failed while writing local files: ${String(err)}`);
		}
	}
	// From now on this device has a last-synced Base of its own.
	await writeLocalBase(rt.stateDir, remote.base ?? {});
	const lines: string[] = [`pi sync init (gist ${gistId})`];
	const planReport = planLines(plan, apply.backups, true);
	lines.push(...(planReport.length > 0 ? planReport : ["no local changes needed"]));
	lines.push(`${remote.files.length} files in the snapshot; manifest adopted`);
	const warnings = [...local.collectWarnings, ...refWarningLines(local.files)];
	return { ok: true, report: reportFor("init", gistId, plan, lines, warnings), preview: consent.previewShown ? undefined : preview };
}

/** Pull: fetch, three-way merge against the Base state, apply to the local tree. */
export async function runPull(rt: SyncRuntime): Promise<SyncOutcome> {
	const local = await loadLocal(rt);
	if ("error" in local) return fail(local.error);
	if (!local.hasLocalManifest) {
		return fail(`no local sync manifest in ${rt.stateDir}. This device has not joined yet: run pi sync init <gist-id>`);
	}
	const backend = rt.buildBackend(local.manifest);
	const remote = await loadRemote(backend, local.manifest.backendOptions.gistId);
	if ("error" in remote) return fail(remote.error);

	const plan = planMerge(mergeBase(local, remote), local, remote);
	const applied = planMutatesLocal(plan);
	let apply: ApplyResult = { backups: [] };
	if (applied) {
		try {
			apply = await applyPlan(plan, rt.home, rt.stateDir);
			await ensureLocalGistId(rt, local.manifest.backendOptions.gistId);
		} catch (err) {
			return fail(`pull failed while writing local files: ${String(err)}`);
		}
	}
	// This device has now seen the shared tree: its last-synced Base is the
	// newest shared Base, whatever the plan did to the local tree.
	await writeLocalBase(rt.stateDir, remote.base ?? {});
	const gistId = local.manifest.backendOptions.gistId;
	const lines: string[] = [`pi sync pull (gist ${gistId})`];
	const planReport = planLines(plan, apply.backups, true);
	lines.push(...(planReport.length > 0 ? planReport : ["up to date"]));
	const toolManaged = toolManagedLine(plan, true);
	if (toolManaged) lines.push(toolManaged);
	const warnings = [...local.collectWarnings, ...refWarningLines(local.files)];
	return { ok: true, report: reportFor("pull", gistId, plan, lines, warnings) };
}

/**
 * Push: merge first (so un-pulled remote work is resolved, never silently
 * overwritten), upload the merged tree plus the new Base state, then apply
 * the merge locally. An upload failure leaves the local tree untouched.
 */
export async function runPush(rt: SyncRuntime): Promise<SyncOutcome> {
	const local = await loadLocal(rt);
	if ("error" in local) return fail(local.error);
	const backend = rt.buildBackend(local.manifest);
	const fetched = await backend.fetch();

	if (!fetched.ok) {
		if (fetched.code === "not-found" && !local.hasLocalManifest) {
			// A bare push never creates the gist (issue #39): the create path
			// is init, which always walks the token and the preview steps.
			return fail(`this device has not joined a gist yet. Create the shared gist with: pi-sync init`);
		}
		// A 404 stays a plain error: no re-authentication loop (issue #38).
		const suffix = fetched.code === "not-found" ? ` The gist may have been deleted, or the id in the manifest is wrong. Check the id and the account.` : "";
		return fail(`${fetched.message}.${suffix}`);
	}

	const remote: RemoteSide = {
		manifest: fetched.value.manifest ?? local.manifest,
		files: fetched.value.files,
		base: fetched.value.base,
		updatedAtMs: fetched.value.updatedAtMs ?? 0,
	};
	const plan = planMerge(mergeBase(local, remote), local, remote);
	const manifestAfter = manifestAfterMerge(local, plan);

	// The tree to upload: the merged local view, re-collected under the
	// manifest in force after the merge (an include list that just widened
	// picks up its new files here).
	const reCollected = await collectLocalFiles(manifestAfter, rt.home);
	const merged = mergedTree(reCollected.files, plan);
	const base = baseStateOf(merged, manifestAfter, remote.base, manifestMtimeMs(plan, local));

	// Upload the shared (canonical) manifest: the gist id stays device-local.
	const pushed = await backend.push({ manifest: canonicalManifest(manifestAfter), base, files: merged, updatedAtMs: undefined });
	if (!pushed.ok) {
		return fail(`push failed; local files were not modified: ${pushed.message}`);
	}

	// The upload succeeded: apply the merge locally. The base is recorded
	// only after the apply succeeds, so a failed apply can never leave a
	// half-merged tree labeled in sync.
	let apply: ApplyResult = { backups: [] };
	if (planMutatesLocal(plan)) {
		try {
			apply = await applyPlan(plan, rt.home, rt.stateDir);
			await ensureLocalGistId(rt, local.manifest.backendOptions.gistId);
		} catch (err) {
			return fail(`push uploaded, but applying the merge locally failed: ${String(err)}`);
		}
	}
	await writeLocalBase(rt.stateDir, base);
	const gistId = local.manifest.backendOptions.gistId;
	const lines: string[] = [`pi sync push (gist ${pushed.value.id})`];
	const planReport = planLines(plan, apply.backups, true);
	if (planReport.length > 0) {
		lines.push("resolved before pushing:");
		lines.push(...planReport.map((line) => `  ${line}`));
	}
	lines.push(`pushed ${merged.length} files; base state updated`);
	const toolManaged = toolManagedLine(plan, true);
	if (toolManaged) lines.push(toolManaged);
	const kept = pushed.value.kept.map((name) => `warning: the gist keeps ${name}, which is not part of the synced tree; delete it in the GitHub UI if it is not wanted`);
	const warnings = [...local.collectWarnings, ...refWarningLines(local.files), ...kept];
	return { ok: true, report: reportFor("push", gistId, plan, lines, warnings) };
}

/**
 * The shared gist manifest carries no device-local gist id. When a merge
 * rewrites the local manifest copy, re-inject this device's id so the next
 * operation can find the gist.
 */
async function ensureLocalGistId(rt: SyncRuntime, id: string | undefined): Promise<void> {
	if (!id) return;
	const current = await readLocalManifest(rt.stateDir);
	if (current.error || !current.manifest) return;
	if (current.manifest.backendOptions?.gistId !== id) {
		await writeLocalManifest(rt.stateDir, {
			...current.manifest,
			backendOptions: { ...current.manifest.backendOptions, gistId: id },
		});
	}
}

/** The merged local tree: local files with the plan's writes and deletes applied. */
function mergedTree(files: SyncFile[], plan: MergePlan): SyncFile[] {
	const byPath = new Map(files.map((f) => [f.path, f] as const));
	for (const action of plan.actions) {
		if (action.path === MANIFEST_KEY) continue;
		if (action.kind === "write") {
			byPath.set(action.path, { path: action.path, content: action.content, mtimeMs: action.mtimeMs, hash: sha256Hex(action.content) });
		} else if (action.kind === "delete") {
			byPath.delete(action.path);
		}
	}
	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The logical mtime of the manifest in force after the merge. */
function manifestMtimeMs(plan: MergePlan, local: LocalSide): number {
	const action = plan.actions.find((a) => a.path === MANIFEST_KEY);
	if (action && action.kind === "write") return action.mtimeMs;
	return local.manifestFile?.mtimeMs ?? 0;
}

/**
 * The new Base state: what this push just made the remote truth. Paths the
 * push removed are kept with `deleted: true` so the other devices can apply
 * the deletion; paths it never knew about are not mentioned.
 */
function baseStateOf(files: SyncFile[], manifest: SyncManifest, prevBase: BaseState | null, manifestMtimeMs: number): BaseState {
	const base: BaseState = {};
	if (prevBase) {
		for (const [path, entry] of Object.entries(prevBase)) {
			if (path === MANIFEST_KEY) continue;
			if (!files.some((f) => f.path === path)) {
				base[path] = { hash: entry.hash, mtimeMs: entry.mtimeMs, deleted: true };
			}
		}
	}
	for (const file of files) base[file.path] = { hash: file.hash, mtimeMs: file.mtimeMs };
	const manifestText = canonicalManifestText(manifest);
	base[MANIFEST_KEY] = { hash: sha256Hex(manifestText), mtimeMs: manifestMtimeMs };
	return base;
}

function emptyPlan(): MergePlan {
	return {
		actions: [],
		conflicts: [],
		changedLocal: [],
		localOnly: [],
		localDeleted: [],
		changedRemote: [],
		remoteOnly: [],
		remoteDeleted: [],
	};
}

function refWarningLines(files: SyncFile[]): string[] {
	return scanReferences(files).map(
		(w) => `warning: ${w.file} references ${w.target}, which resolves to ${w.resolved} outside the snapshot; the manifest stays as you wrote it`,
	);
}

/** Status: compare without moving anything. Read-only; works with a read-only token. */
export async function runStatus(rt: SyncRuntime): Promise<SyncOutcome> {
	const local = await loadLocal(rt);
	if ("error" in local) return fail(local.error);
	if (!local.hasLocalManifest) {
		return fail(`no local sync manifest in ${rt.stateDir}. This device has not joined yet: run pi sync init <gist-id>`);
	}
	const backend = rt.buildBackend(local.manifest);
	const remote = await loadRemote(backend, local.manifest.backendOptions.gistId);
	if ("error" in remote) return fail(remote.error);

	const plan = planMerge(mergeBase(local, remote), local, remote);
	const gistId = local.manifest.backendOptions.gistId;
	const { ahead, behind } = driftCounts(plan);
	const lines: string[] = [`pi sync status (gist ${gistId})`, `ahead ${ahead}, behind ${behind}`];
	if (ahead === 0 && behind === 0 && plan.conflicts.length === 0) {
		lines.push("in sync");
	}
	lines.push(...planLines(plan, [], false));
	const toolManaged = toolManagedLine(plan, false);
	if (toolManaged) lines.push(toolManaged);
	const warnings = [...local.collectWarnings, ...refWarningLines(local.files)];
	return { ok: true, report: reportFor("status", gistId, plan, lines, warnings) };
}
