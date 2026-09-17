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
// and id, and the model re-application through pi.setModel. A refresh that
// fails (server down, aborted) is absorbed here as a plain false, so a down
// server degrades to today's behavior instead of erroring every turn.

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
	// The latest event context. pi builds a fresh context object per event
	// whose fields are live getters; the dependencies always read through the
	// latest one so they never act on a previous session's runtime.
	let ctx: ExtensionContext | null = null;

	pi.on("session_start", (_event, sessionCtx) => {
		ctx = sessionCtx;
		llamaRefresh = createLlamaRefresh({
			refreshCatalog: async () => {
				const active = ctx;
				if (!active) return false;
				try {
					const result = await active.modelRegistry.refresh({
						allowNetwork: true,
						force: true,
						providers: [LLAMA_CPP_PROVIDER],
					});
					return !result.aborted && !result.errors.has(LLAMA_CPP_PROVIDER);
				} catch {
					return false;
				}
			},
			resolveModel: (ref) => {
				const active = ctx;
				return active ? active.modelRegistry.find(ref.provider, ref.id) : undefined;
			},
			applyModel: async (model) => {
				try {
					return await pi.setModel(model);
				} catch {
					return false;
				}
			},
		});
		// A new session start re-arms every selection's Attempt.
		llamaRefresh.onSessionStart();
	});

	pi.on("model_select", (event, sessionCtx) => {
		ctx = sessionCtx;
		// Every select re-arms the Attempt for its selection, including a
		// re-selection of the same model after a sleep.
		llamaRefresh?.onModelSelect({ provider: event.model.provider, id: event.model.id });
	});

	// The agent run has fully settled (no automatic retry, compaction, or
	// queued continuation runs from here). The Wake completed during the first
	// request, so this is the earliest moment the true context size is
	// observable and a re-apply cannot race in-flight work.
	pi.on("agent_settled", (_event, sessionCtx) => {
		ctx = sessionCtx;
		const model = sessionCtx.model;
		if (!llamaRefresh || !model) return;
		void llamaRefresh.onTurnEnd({
			provider: model.provider,
			id: model.id,
			contextWindow: model.contextWindow,
		});
	});

	pi.on("session_shutdown", () => {
		llamaRefresh = null;
	});
}
