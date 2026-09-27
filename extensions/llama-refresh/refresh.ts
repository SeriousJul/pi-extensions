/**
 * The llama-refresh decision core (ADR 0027): heals any window drift against
 * the live catalog, not just the Fallback window.
 *
 * A session can hold a wrong context window for any reason its selection
 * saw a stale catalog: the model was asleep (the catalog gives it the
 * Fallback window), the server relaunched with a different `n_ctx` and pi's
 * cached catalog never revalidated, or a cap interaction moved the value.
 * The Fallback window is one cause of a wrong window, not a test for it, so
 * the core compares instead of matching: at each of the two fixed Heal
 * moments of a model selection - before its first request and after that
 * request settles - the core snapshots the registry's copy of the model,
 * forces one catalog refresh scoped to the llama.cpp provider, reads the
 * model back, and re-applies it when the window moved, in either direction.
 * The Live window arrives through pi's own provider, so this module derives
 * no `n_ctx` and mirrors no constant: `FALLBACK_WINDOW` is gone.
 *
 * Comparing the registry against itself stays safe beside the context-cap
 * extension: the cap skips live-catalog providers (a static capped list would
 * freeze the live window) and clamps the session's model in place at every
 * boundary the window is consumed. The moments run awaited inside their
 * boundary, so a re-apply lands where the cap's clamp of that boundary still
 * sees it: with this extension loaded before the cap, the session window
 * never exceeds the cap at a boundary. A drift that stays above the cap
 * reports a cosmetic heal line per moment that the cap undoes; a drift that
 * crosses below the cap heals for real.
 *
 * Budget: a selection gets one Attempt per Heal moment, two in total, and a
 * new selection re-arms both. A turn that ends `stopReason: "length"` with a
 * near-empty output may spend an unspent Attempt on an extra compare, and
 * can never re-arm one. A `/llama-window` command re-arms the pre-request
 * Attempt and runs one compare, because pi emits no `model_select` when the
 * same model is selected again, so a re-select cannot re-arm anything. A
 * refresh that fails or times out spends nothing, exactly as before, so the
 * second moment keeps the information the first one could not get.
 *
 * The core is engine-free: it names no pi or pi-ai runtime and every
 * observable dependency (the catalog refresh, the registry read-back, the
 * model re-application, the currency probe) is injected. The wiring module
 * binds the pi events to it. The notify lines are built here, in exactly one
 * place, so a test can assert a line verbatim.
 *
 * The core never clobbers and never errors: a model select that lands while
 * a compare is in flight moves the selection's generation, and the compare's
 * re-apply sees the move and skips, so the user's choice wins. A compare
 * that outlived its session (a replacement or reload) fails the isCurrent
 * probe and skips its re-apply, so the shared runtime that now belongs to
 * the new session is never touched by a compare of the old one. A registry
 * read-back that throws (a stale or shut-down session) degrades to the
 * model-not-listed path, so a dying session costs at most silence. Two
 * compares never run for the same selection at once: one selection has one
 * in-flight compare, and a moment that finds the selection busy skips and
 * retries at its next opportunity.
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** The provider id of pi's built-in llama.cpp provider. */
export const LLAMA_CPP_PROVIDER = "llama.cpp";

/**
 * Hard budget for a forced catalog read. The pre-request moment sits before
 * the request is built, so a slow or hung server may delay the first request
 * of a selection by at most this long. The post-request and symptom moments
 * run awaited, so the same budget bounds how long they may delay the run
 * settling. A failure degrades to silence and never spends the Attempt.
 */
export const REFRESH_TIMEOUT_MS = 5000;

/**
 * A truncated answer at or below this many output tokens counts as
 * near-empty for the symptom trigger. A `length` stop with a near-empty
 * answer is the signature of a starved output budget, the original failure
 * this module replaces: the model answered one thinking token.
 */
export const NEAR_EMPTY_OUTPUT_TOKENS = 8;

/** One model selection, keyed by provider and id. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** The decision a compare reaches. */
export type RefreshDecision =
	| /** Not eligible (not llama.cpp, Attempt spent or busy, the refresh failed, the registry lost the model, or the selection moved mid-check). */
	({ kind: "skip" })
	| /** The refresh succeeded and the window did not move; no re-apply. */
	({ kind: "unchanged"; window: number })
	| /** The refresh succeeded, the window moved, and the re-applied model. */
	({ kind: "re-apply"; from: number; to: number; model: Model<Api> });

export interface LlamaRefreshDeps {
	/**
	 * A forced, network-allowed catalog refresh scoped to the llama.cpp
	 * provider. When `opts.timeoutMs` is set the wiring enforces that hard
	 * deadline: a refresh that cannot finish in time fails. Resolves false
	 * when the refresh fails or is aborted; never rejects.
	 */
	refreshCatalog: (opts?: { timeoutMs?: number }) => Promise<boolean>;
	/** Read the model back from the registry by provider and id, or undefined when the registry does not list it. */
	resolveModel: (ref: ModelRef) => Model<Api> | undefined;
	/** Re-apply a model to the running session (set model). Resolves false when refused. */
	applyModel: (model: Model<Api>) => Promise<boolean>;
	/**
	 * Whether the session this core belongs to is still current. The wiring
	 * answers through the session context captured when the core was built:
	 * a context that outlived its session (a replacement or reload) has its
	 * getters throw. A compare that spans a replacement must not re-apply
	 * through the shared runtime, which now belongs to the new session.
	 */
	isCurrent: () => boolean;
}

export interface LlamaRefresh {
	/** A new session start: no selection has spent an Attempt. */
	onSessionStart(): void;
	/** A new model selection: re-arms both Attempts for the selection and moves the selection's generation. */
	onModelSelect(ref: ModelRef): void;
	/** The pre-request Heal moment (before the request is built): compare while the pre-request Attempt is unspent. */
	onPreRequest(ref: ModelRef): Promise<RefreshDecision>;
	/** The post-request Heal moment (the run has settled): compare while the post-request Attempt is unspent. */
	onPostRequest(ref: ModelRef): Promise<RefreshDecision>;
	/** The symptom trigger: a turn ended `length` with a near-empty answer; spend an unspent Attempt on an extra compare, never re-arm. */
	onTruncatedTurn(ref: ModelRef, outputTokens: number): Promise<RefreshDecision>;
	/** The `/llama-window` command: re-arm the pre-request Attempt and run one compare. */
	onCommand(ref: ModelRef): Promise<RefreshDecision>;
}

/** The report line for an applied heal. The one place the text exists. */
export function windowReappliedLine(from: number, to: number, ref: ModelRef): string {
	return `llama window: ${from} -> ${to} (${ref.provider}/${ref.id})`;
}

/** The report line for a command compare that confirmed an unchanged window. */
export function windowConfirmedLine(window: number, ref: ModelRef): string {
	return `llama window: ${window} (${ref.provider}/${ref.id})`;
}

/** The report line for a command compare that could not finish or was not eligible. */
export function windowCheckFailedLine(ref: ModelRef): string {
	return `llama window: check failed (${ref.provider}/${ref.id})`;
}

/** The report line for a command run with no model selected. */
export const NO_MODEL_LINE = "llama window: no model selected";

type Moment = "pre" | "post";

/** The Attempt state of one selection: one Attempt per Heal moment. */
interface AttemptState {
	preSpent: boolean;
	postSpent: boolean;
}

const key = (ref: ModelRef) => `${ref.provider}/${ref.id}`;
const isLlama = (ref: ModelRef) => ref.provider === LLAMA_CPP_PROVIDER;

export function createLlamaRefresh(deps: LlamaRefreshDeps): LlamaRefresh {
	// The Attempt state per selection (provider/id). It is not persisted;
	// after a restart the selection re-evaluates from scratch, which is
	// correct because the persisted catalog and the session model both
	// re-resolve.
	const spent = new Map<string, AttemptState>();
	// The selection's generation: bumped on every model select and every
	// session start. A compare captures the generation when it starts and
	// skips its re-apply if the generation moved while the compare was in
	// flight, so a manual model select made during the network refresh is
	// never clobbered (the same guard the model router applies to its own
	// continuation).
	let generation = 0;
	// One selection has at most one in-flight compare. A moment that finds
	// its selection busy skips and retries at its next opportunity, so a
	// hung refresh of one selection can never queue the pre-request moment
	// of another.
	const busy = new Set<string>();

	// A selection with no recorded state - a restored session's model, which
	// pi resolves without emitting a model_select - reads as both Attempts
	// unspent, the same way a fresh selection does.
	const stateFor = (ref: ModelRef): AttemptState => {
		const selection = key(ref);
		const state = spent.get(selection) ?? { preSpent: false, postSpent: false };
		spent.set(selection, state);
		return state;
	};

	const compare = async (ref: ModelRef, moment: Moment, opts?: { timeoutMs?: number }): Promise<RefreshDecision> => {
		const selection = key(ref);
		// Re-checked here, at task start, as well as at the entry point: the
		// command re-arms in place and a compare must not run on a spent
		// Attempt regardless of how it was enqueued.
		const state = stateFor(ref);
		if (moment === "pre" ? state.preSpent : state.postSpent) return { kind: "skip" };
		const gen = generation;
		let before: Model<Api> | undefined;
		try {
			before = deps.resolveModel(ref);
		} catch {
			// The registry read threw (a stale or shut-down session).
			before = undefined;
		}
		const refreshed = await deps.refreshCatalog(opts);
		if (!refreshed) {
			// A failed refresh does not spend the Attempt: the selection
			// retries at its next moment.
			return { kind: "skip" };
		}
		// The refresh succeeded: spend the Attempt now, so no later moment of
		// this selection can spend it twice.
		if (moment === "pre") state.preSpent = true;
		else state.postSpent = true;
		let after: Model<Api> | undefined;
		try {
			after = deps.resolveModel(ref);
		} catch {
			// The registry read threw (a stale or shut-down session). The
			// Attempt is spent; the compare degrades to silence.
			after = undefined;
		}
		if (!before || !after) {
			// The registry does not list the model (it was lost by the
			// refresh, or never listed): nothing to compare, nothing to
			// apply. The Attempt is spent either way.
			return { kind: "skip" };
		}
		if (before.contextWindow === after.contextWindow) {
			// The live catalog confirmed the value the registry already
			// held: no re-apply, no transcript entry, no report line. A
			// cap that clamps both sides to the same value lands here.
			return { kind: "unchanged", window: before.contextWindow };
		}
		// A manual model select landed during the in-flight compare: the
		// user's choice wins, and the re-apply would clobber it.
		if (gen !== generation) return { kind: "skip" };
		// The compare outlived its session: a replacement or reload
		// invalidated the context the compare was built with, and the
		// shared set-model now belongs to the new session. The re-apply
		// would clobber that session's model, so the compare degrades to
		// silence (the Attempt is spent; the new session re-evaluates with
		// its own core).
		if (!deps.isCurrent()) return { kind: "skip" };
		// The window moved: re-apply the model exactly as the registry
		// resolved it - the only path that changes a running session's
		// window (ADR 0027). In either direction: a server that comes back
		// smaller shrinks the session.
		let applied = false;
		try {
			applied = await deps.applyModel(after);
		} catch {
			applied = false;
		}
		if (!applied) {
			// pi refused the re-apply: nothing changed in the session, so
			// the compare reports nothing (the Attempt is spent).
			return { kind: "skip" };
		}
		return { kind: "re-apply", from: before.contextWindow, to: after.contextWindow, model: after };
	};

	const compareExclusive = (ref: ModelRef, moment: Moment, opts?: { timeoutMs?: number }): Promise<RefreshDecision> | undefined => {
		const selection = key(ref);
		if (busy.has(selection)) return undefined;
		busy.add(selection);
		const run = (async () => {
			try {
				return await compare(ref, moment, opts);
			} finally {
				busy.delete(selection);
			}
		})();
		return run;
	};

	return {
		onSessionStart() {
			// A compare of the old session that is still in flight can no
			// longer re-apply: the generation moved and the isCurrent probe
			// will reject it. Let the new session's compares run anyway.
			generation += 1;
			spent.clear();
			busy.clear();
		},
		onModelSelect(ref) {
			// A new selection re-arms both Attempts. pi emits this event
			// only for a different model (its modelsAreEqual compares id
			// and provider), so a re-select of the same model re-arms
			// nothing: that is why the command exists.
			generation += 1;
			spent.set(key(ref), { preSpent: false, postSpent: false });
		},
		async onPreRequest(ref) {
			if (!isLlama(ref)) return { kind: "skip" };
			// The pre-request moment retries on every turn start until its
			// Attempt is spent or the selection moves, because a failed
			// refresh spends nothing: a later request of the same selection
			// still gets the heal it missed.
			const run = compareExclusive(ref, "pre", { timeoutMs: REFRESH_TIMEOUT_MS });
			return (await run) ?? { kind: "skip" };
		},
		async onPostRequest(ref) {
			if (!isLlama(ref)) return { kind: "skip" };
			// The wiring awaits this moment at the settle, so its re-apply
			// lands inside the settled boundary (a cap clamp that runs after
			// this handler still sees it) and the hard budget bounds the
			// settle delay.
			const run = compareExclusive(ref, "post", { timeoutMs: REFRESH_TIMEOUT_MS });
			return (await run) ?? { kind: "skip" };
		},
		async onTruncatedTurn(ref, outputTokens) {
			if (!isLlama(ref)) return { kind: "skip" };
			if (outputTokens > NEAR_EMPTY_OUTPUT_TOKENS) return { kind: "skip" };
			const state = stateFor(ref);
			// Spend an unspent Attempt, never re-arm one. The post-request
			// Attempt goes first: at a turn end it is the Attempt the
			// settled moment would spend next, so the symptom compare
			// stands in for it and the settled moment then skips. When the
			// post Attempt is already spent, an unspent pre Attempt (its
			// refresh failed earlier) takes the compare.
			const moment: Moment | undefined = state.postSpent ? (state.preSpent ? undefined : "pre") : "post";
			if (!moment) return { kind: "skip" };
			// The wiring awaits this moment at the turn end, so its re-apply
			// lands inside the turn boundary and the hard budget bounds the
			// turn delay.
			const run = compareExclusive(ref, moment, { timeoutMs: REFRESH_TIMEOUT_MS });
			return (await run) ?? { kind: "skip" };
		},
		async onCommand(ref) {
			if (!isLlama(ref)) return { kind: "skip" };
			// The command re-arms exactly one Attempt - the pre-request
			// one - in place, keeping the post Attempt's state. pi emits no
			// model_select for a same-model re-select, so this is the only
			// way a human re-runs the heal by hand.
			const state = stateFor(ref);
			state.preSpent = false;
			const run = compareExclusive(ref, "pre", { timeoutMs: REFRESH_TIMEOUT_MS });
			return (await run) ?? { kind: "skip" };
		},
	};
}
