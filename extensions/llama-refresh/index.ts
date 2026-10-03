// Llama refresh extension wiring (ADR 0027).
//
// This module connects the engine-free decision module (refresh.ts) to the pi
// extension API. The factory runs once per pi process; the handlers it
// registers persist across sessions. The per-session core instance (and with
// it the Attempt state) lives in the factory closure and is rebuilt on every
// session start. This module contains no decision logic: behavior changes
// happen in the tested core module.
//
// The moments, and where they bind:
//
// - The pre-request Heal moment binds to turn_start. pi awaits the
//   extension's turn_start handler before it builds the request (and the
//   request reads the session model fresh), so a re-apply here heals the
//   window before the first request of the selection is built. The catalog
//   read carries a hard timeout: a slow or hung server may delay the first
//   request by at most the budget, and a failure degrades to silence.
// - The post-request Heal moment binds to agent_settled: the run has fully
//   settled (no automatic retry, compaction, or queued continuation runs
//   from here), the Wake completed during the first request, and a re-apply
//   cannot race in-flight work. The handler awaits the compare: a re-apply
//   must land inside the settled boundary so that a boundary clamp from
//   another extension (the context-cap) still sees it, and the hard budget
//   bounds the delay a slow server may add to the settle.
// - The symptom trigger binds to turn_end: a turn that ended `length` with a
//   near-empty answer may spend an unspent Attempt on an extra compare, also
//   awaited inside the turn boundary for the same reason.
// - The /llama-window command re-arms the pre-request Attempt and runs one
//   compare on demand, and reports the result.
//
// The same-model re-select. pi emits no model_select when the selected model
// equals the current one (its modelsAreEqual compares id and provider), so a
// re-select cannot re-arm anything through that event. pi does record every
// selection: setModel appends a model_change entry to the transcript even for
// an equal model. That entry is the only signal an extension can read, and the
// earliest boundary that can read it is the next turn_start. The wiring
// therefore tracks the newest model_change entry it has accounted for - a
// select pi reported, or a re-apply this extension made itself - and treats a
// newer entry as the operator's re-select: it re-arms both Attempts before the
// pre-request compare runs, so the first request after the re-select gets the
// healed window. The extension's own re-apply writes the same kind of entry,
// so the wiring accounts for it the moment it lands; a heal can never re-arm
// itself.
//
// Every applied heal reports one line, and every command run reports one
// line. The lines are built in refresh.ts, in exactly one place, so a test
// can assert a line verbatim. A moment whose compare is not an applied heal
// stays silent.
//
// The real dependencies the core receives: a forced, network-allowed catalog
// refresh scoped to the llama.cpp provider (with the hard deadline for the
// pre-request moment), a registry read-back by provider and id, a probe of
// whether the session is still current, the active context window cap the
// context-cap extension publishes, and the model re-application through
// pi.setModel. A refresh that fails (server down, aborted, timed out, stale
// context) is absorbed here as a plain false, so a down server degrades to
// today's behavior instead of erroring every turn.
//
// Every dependency reads the session context captured when the core was
// built, not a shared "latest context" variable: pi re-binds the shared
// extension runtime to the new session on a replacement (switch, resume,
// reload) and invalidates the old one. A compare that spans the replacement
// then reads the invalidated context - its refresh degrades to a skip, and
// the isCurrent probe rejects its re-apply - so the new session's model is
// never touched by a compare of the old session.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getActiveWindowCap } from "../shared/context-window-cap.ts";
import {
	createLlamaRefresh,
	LLAMA_CPP_PROVIDER,
	NO_MODEL_LINE,
	type LlamaRefresh,
	type RefreshDecision,
	windowCheckFailedLine,
	windowConfirmedLine,
	windowReappliedLine,
} from "./refresh.ts";

/** One model selection, as the core sees it. */
type Ref = { provider: string; id: string };

const refOf = (model: Model<Api>): Ref => ({ provider: model.provider, id: model.id });

/**
 * The newest model_change entry in the transcript, or undefined when the
 * session has none. pi appends one for every setModel, including a selection
 * of the model the session already holds, so this entry is the record that a
 * selection happened.
 */
function newestModelChange(ctx: ExtensionContext): { id: string; provider: string; modelId: string } | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type === "model_change") return { id: entry.id, provider: entry.provider, modelId: entry.modelId };
	}
	return undefined;
}

export default function (pi: ExtensionAPI): void {
	// The core for the current session. Null before the first session start
	// and after a shutdown.
	let llamaRefresh: LlamaRefresh | null = null;
	// The newest model_change entry the wiring has accounted for: a select pi
	// reported through model_select, or a re-apply this extension made. A
	// newer entry at a boundary is a selection pi did not report.
	let lastSelectionEntryId: string | undefined;

	pi.on("session_start", (_event, sessionCtx: ExtensionContext) => {
		llamaRefresh = createLlamaRefresh({
			refreshCatalog: async (opts) => {
				// A stale context's modelRegistry getter throws; the catch
				// absorbs it as a failed refresh.
				try {
					const refresh = () =>
						sessionCtx.modelRegistry.refresh({
							allowNetwork: true,
							force: true,
							providers: [LLAMA_CPP_PROVIDER],
						});
					// The refresh keeps running after a timeout (a late catalog
					// is better than none) and must never reject unhandled.
					const pending = refresh();
					pending.catch(() => undefined);
					let result: Awaited<ReturnType<typeof refresh>> | undefined;
					if (opts?.timeoutMs !== undefined) {
						// Every moment in production passes a hard deadline, so a
						// refresh that cannot finish in time fails instead of
						// delaying the request or the settle by an unknown time.
						let timer: ReturnType<typeof setTimeout> | undefined;
						const timedOut = new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("catalog refresh timed out")), opts.timeoutMs);
							timer.unref?.();
						});
						try {
							result = await Promise.race([pending, timedOut]);
						} catch {
							return false;
						} finally {
							clearTimeout(timer);
						}
					} else {
						// No deadline: the caller wants the refresh to run to
						// completion. Every moment in production passes one, so
						// this branch only serves a deadline-free caller.
						result = await pending;
					}
					// A fast failure (a refused connection) resolves the refresh
					// with the error recorded per provider instead of rejecting:
					// the deadline alone does not make the read a success, or the
					// compare would run on the stale list and spend the Attempt on
					// a phantom confirm.
					return result !== undefined && !result.aborted && !result.errors.has(LLAMA_CPP_PROVIDER);
				} catch {
					return false;
				}
			},
			resolveModel: (ref) => sessionCtx.modelRegistry.find(ref.provider, ref.id),
			applyModel: async (model) => {
				try {
					const applied = await pi.setModel(model);
					// The re-apply appended its own model_change entry. Account
					// for it here so the heal never reads as the operator's
					// selection at the next boundary.
					if (applied) lastSelectionEntryId = newestModelChange(sessionCtx)?.id;
					return applied;
				} catch {
					return false;
				}
			},
			// Probes the captured context through its active getter. While the
			// session lives it answers true; after a replacement or reload the
			// getter throws, which the wiring absorbs as "not current."
			isCurrent: () => {
				try {
					void sessionCtx.modelRegistry;
					return true;
				} catch {
					return false;
				}
			},
			// The context-cap extension publishes the cap it resolved in
			// session_start; the core clamps both sides of the compare to it.
			windowCap: () => getActiveWindowCap(),
		});
		// A new session start re-arms every selection's Attempts, and the
		// transcript's existing selections are history, not a re-select.
		lastSelectionEntryId = newestModelChange(sessionCtx)?.id;
		llamaRefresh.onSessionStart();
	});

	pi.on("model_select", (event, ctx: ExtensionContext) => {
		// Every select re-arms both Attempts for its selection. pi emits
		// this event only for a different model (its modelsAreEqual compares
		// id and provider), so the wiring accounts for the entry this select
		// appended and reads a same-model re-select from the transcript.
		llamaRefresh?.onModelSelect({ provider: event.model.provider, id: event.model.id });
		lastSelectionEntryId = newestModelChange(ctx)?.id;
	});

	// The pre-request Heal moment. pi awaits this handler before it builds
	// the request, so an applied heal here moves the window the request
	// actually gets. A late failure must degrade to silence, never to an
	// error that kills the turn.
	pi.on("turn_start", async (_event, ctx: ExtensionContext) => {
		if (!llamaRefresh) return;
		const model = ctx.model;
		if (!model) return;
		const ref = refOf(model);
		// A model_change entry the wiring has not accounted for is a selection
		// pi did not report: the operator re-selected the model the session
		// already holds. Re-arm before the compare so this turn's request gets
		// the healed window.
		const selection = newestModelChange(ctx);
		if (selection && selection.id !== lastSelectionEntryId) {
			lastSelectionEntryId = selection.id;
			if (selection.provider === ref.provider && selection.modelId === ref.id) llamaRefresh.onReSelect(ref);
		}
		let decision: RefreshDecision;
		try {
			decision = await llamaRefresh.onPreRequest(ref);
		} catch {
			return;
		}
		if (decision.kind === "re-apply") ctx.ui.notify(windowReappliedLine(decision.from, decision.to, ref));
	});

// The symptom trigger: a turn that ended in truncation with a near-empty
// answer may spend an unspent Attempt on an extra compare. It runs only on
// those turns; a late failure degrades to silence.
pi.on("turn_end", async (event, ctx: ExtensionContext) => {
	if (!llamaRefresh) return;
	const model = ctx.model;
	if (!model) return;
	const message = event.message;
	if (message.role !== "assistant" || message.stopReason !== "length") return;
	if (message.usage?.output === undefined) return;
	const ref = refOf(model);
	let decision: RefreshDecision;
	try {
		decision = await llamaRefresh.onTruncatedTurn(ref, message.usage.output);
	} catch {
		return;
	}
	if (decision.kind === "re-apply") ctx.ui.notify(windowReappliedLine(decision.from, decision.to, ref));
});

// The post-request Heal moment: the run has fully settled, the Wake
// completed during the first request, and a re-apply cannot race
// in-flight work. A late failure degrades to silence.
pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
	if (!llamaRefresh) return;
	const model = ctx.model;
	if (!model) return;
	const ref = refOf(model);
	let decision: RefreshDecision;
	try {
		decision = await llamaRefresh.onPostRequest(ref);
	} catch {
		return;
	}
	if (decision.kind === "re-apply") ctx.ui.notify(windowReappliedLine(decision.from, decision.to, ref));
});

	pi.on("session_shutdown", () => {
		llamaRefresh = null;
	});

	// The human re-run. pi executes an extension command immediately, even
	// during streaming, so the compare takes the hard pre-request budget and
	// reports its result either way.
	pi.registerCommand("llama-window", {
		description: "Compare the llama.cpp model's context window against the live catalog and re-apply it if it moved",
		async handler(_args, ctx: ExtensionContext) {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify(NO_MODEL_LINE);
				return;
			}
			const ref = refOf(model);
			if (!llamaRefresh) {
				ctx.ui.notify(windowCheckFailedLine(ref));
				return;
			}
			const decision = await llamaRefresh.onCommand(ref);
			if (decision.kind === "re-apply") ctx.ui.notify(windowReappliedLine(decision.from, decision.to, ref));
			else if (decision.kind === "unchanged") ctx.ui.notify(windowConfirmedLine(decision.window, ref));
			else ctx.ui.notify(windowCheckFailedLine(ref));
		},
	});
}
