// Llama refresh extension wiring.
//
// This module connects the engine-free decision module (refresh.ts) to the pi
// extension API. The factory runs once per pi process; the handlers it
// registers persist across sessions. The per-session core instance (and with
// it the Attempt state) lives in the factory closure and is rebuilt on every
// session start. This module contains no decision logic: behavior changes
// happen in the tested core module.
//
// The real dependencies the core receives: a forced, network-allowed catalog
// refresh scoped to the llama.cpp provider, a registry read-back by provider
// and id, a probe of whether the session is still current, and the model
// re-application through pi.setModel. A refresh that fails (server down,
// aborted, stale context) is absorbed here as a plain false, so a down
// server or a dead session degrades to today's behavior instead of erroring
// every turn.
//
// Every dependency reads the session context captured when the core was
// built, not a shared "latest context" variable: pi re-binds the shared
// extension runtime to the new session on a replacement (switch, resume,
// reload) and invalidates the old one. A check that spans the replacement
// then reads the invalidated context - its refresh degrades to a skip, and
// the isCurrent probe rejects its re-apply - so the new session's model is
// never touched by a check of the old session.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createLlamaRefresh,
	LLAMA_CPP_PROVIDER,
	type LlamaRefresh,
} from "./refresh.ts";

export default function (pi: ExtensionAPI): void {
	// The core for the current session. Null before the first session start
	// and after a shutdown.
	let llamaRefresh: LlamaRefresh | null = null;

	pi.on("session_start", (_event, sessionCtx: ExtensionContext) => {
		llamaRefresh = createLlamaRefresh({
			refreshCatalog: async () => {
				// A stale context's modelRegistry getter throws; the catch
				// absorbs it as a failed refresh.
				try {
					const result = await sessionCtx.modelRegistry.refresh({
						allowNetwork: true,
						force: true,
						providers: [LLAMA_CPP_PROVIDER],
					});
					return !result.aborted && !result.errors.has(LLAMA_CPP_PROVIDER);
				} catch {
					return false;
				}
			},
			resolveModel: (ref) => sessionCtx.modelRegistry.find(ref.provider, ref.id),
			applyModel: async (model) => {
				try {
					return await pi.setModel(model);
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
		});
		// A new session start re-arms every selection's Attempt.
		llamaRefresh.onSessionStart();
	});

	pi.on("model_select", (event) => {
		// Every select re-arms the Attempt for its selection, including a
		// re-selection of the same model after a sleep.
		llamaRefresh?.onModelSelect({ provider: event.model.provider, id: event.model.id });
	});

	// The agent run has fully settled (no automatic retry, compaction, or
	// queued continuation runs from here). The Wake completed during the first
	// request, so this is the earliest moment the true context size is
	// observable and a re-apply cannot race in-flight work.
	pi.on("agent_settled", (_event, sessionCtx) => {
		const model = sessionCtx.model;
		if (!llamaRefresh || !model) return;
		// The check runs unattended: a late failure must degrade to silence,
		// never to an unhandled rejection.
		void llamaRefresh
			.onTurnEnd({
				provider: model.provider,
				id: model.id,
				contextWindow: model.contextWindow,
			})
			.catch(() => undefined);
	});

	pi.on("session_shutdown", () => {
		llamaRefresh = null;
	});
}
