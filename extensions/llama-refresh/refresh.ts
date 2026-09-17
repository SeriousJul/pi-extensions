/**
 * The Llama refresh module: owns the self-heal decision for the Fallback
 * window (ADR 0019).
 *
 * A llama.cpp model that is asleep when a session resolves it exposes no
 * `n_ctx`, so the provider gives it the Fallback window (a fixed 128000).
 * The first request wakes the model, but nothing re-resolves it, so the
 * session keeps the Fallback window for its whole life. This module repairs
 * that per model selection: after each agent turn, if the active model is a
 * llama.cpp model carrying the Fallback window and the selection has not
 * spent its Attempt, the module forces a catalog refresh (which re-lists the
 * server and re-derives the window from the now-exposed `n_ctx`), reads the
 * model back from the registry, and re-applies it only when the window
 * changed. The re-apply is the only path that changes a running session's
 * window; it appends one model change entry to the transcript, the cost
 * ADR 0019 accepts at most once per selection.
 *
 * This module is engine-free: it names no pi or pi-ai runtime, it receives
 * the current model's facts, and every observable dependency (the catalog
 * refresh, the registry read-back, the model re-application) is injected.
 * The wiring module binds the pi events to it.
 *
 * Bound: a selection spends its Attempt the moment a refresh succeeds,
 * whether or not the window changed. A refresh that fails (server down,
 * aborted) does not spend it, so the selection retries on the next turn end
 * - bounded by the selection's lifetime. A model genuinely loaded with a
 * 128000 context is indistinguishable from the Fallback window at check
 * time; its Attempt refresh confirms the same value and the module stays
 * silent, so the sentinel costs nothing in that case.
 *
 * The module never clobbers and never errors: a model select that lands
 * while a check is in flight moves the selection's generation, and the
 * check's re-apply sees the move and skips, so the user's choice wins. A
 * registry read-back that throws (a stale or shut-down session) degrades
 * to the model-not-listed path, so a dying session costs at most silence.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** The provider id of pi's built-in llama.cpp provider. */
export const LLAMA_CPP_PROVIDER = "llama.cpp";

/**
 * The Fallback window the llama.cpp provider reports for a model whose
 * `n_ctx` is not exposed because the model is asleep. Named here instead of
 * compared by magic number so a future provider change is visible at this
 * one spot; it must mirror the provider's constant.
 */
export const FALLBACK_WINDOW = 128000;

/** One model selection, keyed by provider and id. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** The facts of the active model the check needs. */
export interface CurrentModel {
	provider: string;
	id: string;
	contextWindow: number;
}

/** The decision a turn end reaches. */
export type RefreshDecision =
	| /** Not eligible (not llama.cpp, not the Fallback window, Attempt spent, the refresh failed, or the selection moved mid-check). */
	({ kind: "skip" })
	| /** The refresh succeeded and the window did not change; no re-apply. */
	({ kind: "re-resolve" })
	| /** The refresh succeeded, the window changed, and the re-applied model. */
	({ kind: "re-apply"; model: Model<Api> });

export interface LlamaRefreshDeps {
	/**
	 * A forced, network-allowed catalog refresh scoped to the llama.cpp
	 * provider. Resolves false when the refresh fails or is aborted; never
	 * rejects.
	 */
	refreshCatalog: () => Promise<boolean>;
	/** Read the model back from the registry by provider and id. */
	resolveModel: (model: ModelRef) => Model<Api> | undefined;
	/** Re-apply a model to the running session (set model). Resolves false when refused. */
	applyModel: (model: Model<Api>) => Promise<boolean>;
}

export interface LlamaRefresh {
	/** A new session start: no selection has spent its Attempt. */
	onSessionStart(): void;
	/** A new model selection: re-arms the selection's Attempt and moves the selection's generation. */
	onModelSelect(model: ModelRef): void;
	/** The agent turn ended: check the active model and, if eligible, heal it. */
	onTurnEnd(current: CurrentModel): Promise<RefreshDecision>;
}

export function createLlamaRefresh(deps: LlamaRefreshDeps): LlamaRefresh {
	// The Attempt state: the selections (provider/id) that already spent
	// their Attempt this session. It is not persisted; after a restart the
	// selection re-evaluates from scratch, which is correct because the
	// persisted catalog and the session model both re-resolve.
	const spent = new Set<string>();
	const key = (model: ModelRef) => `${model.provider}/${model.id}`;
	// The selection's generation: bumped on every model select. A check
	// captures the generation when it starts and skips its re-apply if the
	// generation moved while the check was in flight, so a manual model
	// select made during the network refresh is never clobbered (the same
	// guard the model router applies to its own continuation).
	let generation = 0;

	return {
		onSessionStart() {
			spent.clear();
		},
		onModelSelect(model) {
			generation += 1;
			spent.delete(key(model));
		},
		async onTurnEnd(current) {
			if (current.provider !== LLAMA_CPP_PROVIDER) return { kind: "skip" };
			if (current.contextWindow !== FALLBACK_WINDOW) return { kind: "skip" };
			const selection = key(current);
			if (spent.has(selection)) return { kind: "skip" };
			const gen = generation;
			// The Wake completes during the first request, so a refresh now sees
			// the server's true `n_ctx`.
			const refreshed = await deps.refreshCatalog();
			if (!refreshed) {
				// A failed refresh does not spend the Attempt: the selection
				// retries on the next turn end.
				return { kind: "skip" };
			}
			spent.add(selection);
			let resolved: Model<Api> | undefined;
			try {
				resolved = deps.resolveModel(current);
			} catch {
				// The registry read threw (a stale or shut-down session). The
				// Attempt is spent; the check degrades to silence.
				resolved = undefined;
			}
			if (resolved === undefined || resolved.contextWindow === FALLBACK_WINDOW) {
				// The server confirmed the Fallback window (a model genuinely
				// loaded at 128000, or a model the refresh no longer lists):
				// stay silent. The Attempt is spent either way.
				return { kind: "re-resolve" };
			}
			// A manual model select landed during the in-flight check: the
			// user's choice wins, and the re-apply would clobber it.
			if (gen !== generation) return { kind: "skip" };
			// The window changed: re-apply the model exactly as the registry
			// resolved it - the only path that changes a running session's
			// window (ADR 0019).
			await deps.applyModel(resolved);
			return { kind: "re-apply", model: resolved };
		},
	};
}
