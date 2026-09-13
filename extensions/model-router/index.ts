// Model router extension wiring.
//
// This module connects the model router state machine (router.ts) to the pi
// extension API. The factory runs once per pi process; the handlers it
// registers persist across sessions. Session-scoped state (the live router
// instance and halt dedup) lives in the factory closure so each extension load
// gets its own.
//
// The router itself is engine-free and fully tested in isolation; everything
// pi-specific (model registry, session persistence, user messages, UI) is
// supplied here as dependencies.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createQuotaSource } from "../quota/source.ts";
import { isQuotaHaltError } from "./classifier.ts";
import {
	createModelRouter,
	type ModelRef,
	type ModelRouter,
	type PendingRecovery,
} from "./router.ts";
import { readModelRouterSettings } from "./settings.ts";

// Session entry customType used to persist a pending recovery across restarts.
const PENDING_ENTRY_TYPE = "model-router-pending";

// Guard against a malformed persisted entry: the router refuses to re-arm from
// data that does not shape-check, so a corrupt entry is ignored (not fatal).
function isModelRef(value: unknown): value is ModelRef {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Record<string, unknown>;
	return typeof ref.provider === "string" && typeof ref.id === "string";
}

function isPendingRecovery(value: unknown): value is PendingRecovery {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	if (data.v !== 1) return false;
	if (data.phase !== "waiting" && data.phase !== "on-fallback") return false;
	if (!isModelRef(data.original)) return false;
	if (typeof data.chainPos !== "number") return false;
	if (data.fallbackInUse !== null && !isModelRef(data.fallbackInUse)) return false;
	if (typeof data.cycles !== "number") return false;
	if (data.phase === "waiting" && typeof data.resetAtMs !== "number") return false;
	return true;
}

export default function (pi: ExtensionAPI): void {
	// Live router for the current session. Null when the extension is disabled
	// or no session has started yet.
	let router: ModelRouter | null = null;
	// id of the last assistant message already fed to onQuotaHalt, so a
	// duplicated agent_settled cannot start a second recovery for the same halt.
	let lastProcessedHaltId: string | null = null;

	function currentModelRef(ctx: ExtensionContext): ModelRef | null {
		const model = ctx.model;
		if (!model) return null;
		return { provider: model.provider, id: model.id };
	}

	// Find the most recent assistant message on the session. Its error, if any,
	// is the outcome of the just-settled run. The message is narrowed to the
	// assistant variant, which carries stopReason and errorMessage.
	function lastAssistantMessage(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				return { entryId: entry.id, message: entry.message };
			}
		}
		return null;
	}

	// Re-arm from the newest persisted pending-recovery entry, if any. Called on
	// every session start; a fresh session has no such entry and is a no-op.
	function rearmFromSession(ctx: ExtensionContext): void {
		if (!router) return;
		let latest: unknown = undefined;
		let seen = false;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === PENDING_ENTRY_TYPE) {
				seen = true;
				latest = entry.data;
			}
		}
		if (!seen || latest === undefined) return;
		if (isPendingRecovery(latest)) {
			void router.rearm(latest);
		}
	}

	pi.on("session_start", (event, ctx) => {
		// Each session starts clean; the handler set persists across sessions.
		lastProcessedHaltId = null;

		const { settings, errors } = readModelRouterSettings(ctx.cwd);
		for (const error of errors) {
			if (ctx.hasUI) ctx.ui.notify(`model-router: ${error}`, "error");
		}
		if (!settings.enabled) {
			router = null;
			return;
		}

		const source = createQuotaSource();
		router = createModelRouter({
			config: {
				precedence: settings.precedence,
				fallbacks: settings.fallbacks,
				maxWaitMinutes: settings.maxWaitMinutes,
			},
			quotaProviderId: source.providerId,
			readQuota: () => source.read(),
			findModel: (ref) => {
				const model = ctx.modelRegistry.find(ref.provider, ref.id);
				return {
					found: model !== undefined,
					hasAuth: model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model),
				};
			},
			now: () => Date.now(),
			scheduleTimer: (delayMs, onFire) => {
				const handle = setTimeout(onFire, delayMs);
				return { cancel: () => clearTimeout(handle) };
			},
			actions: {
				setModel: async (ref) => {
					const model = ctx.modelRegistry.find(ref.provider, ref.id);
					if (!model) return false;
					if (!ctx.modelRegistry.hasConfiguredAuth(model)) return false;
					try {
						return await pi.setModel(model);
					} catch {
						return false;
					}
				},
				sendUserMessage: async (text) => {
					// A halted run is idle, so this normally sends plainly. If a
					// turn is somehow in flight, queue as a follow-up instead.
					if (ctx.isIdle()) {
						await pi.sendUserMessage(text);
					} else {
						await pi.sendUserMessage(text, { deliverAs: "followUp" });
					}
				},
				notify: (message, level) => {
					if (ctx.hasUI) ctx.ui.notify(message, level);
				},
				persistPending: (data) => {
					pi.appendEntry(PENDING_ENTRY_TYPE, data ?? undefined);
				},
			},
		});

		// Re-arm from any persisted pending-recovery entry. Fresh sessions and
		// forks without the entry are no-ops; restarts/resumes/reloads that carry
		// it re-arm (user story: waiting must not depend on the terminal staying
		// open).
		rearmFromSession(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!router) return;
		const current = currentModelRef(ctx);
		if (!current) return;
		const last = lastAssistantMessage(ctx);
		if (
			last &&
			last.message.stopReason === "error" &&
			typeof last.message.errorMessage === "string" &&
			isQuotaHaltError(last.message.errorMessage)
		) {
			if (last.entryId === lastProcessedHaltId) return;
			lastProcessedHaltId = last.entryId;
			void router.onQuotaHalt(current);
		} else {
			void router.onIdle(current);
		}
	});

	pi.on("input", (event, _ctx) => {
		// Recovery messages are injected via sendUserMessage (source "extension");
		// they must not count as the user typing and cancel a wait.
		if (event.source === "extension") return;
		router?.onUserInput();
	});

	pi.on("model_select", (event, _ctx) => {
		// Every select is forwarded. The router consumes the ones it caused
		// itself (tracked by its own flag) and treats the rest as a manual model
		// change that cancels the pending recovery.
		router?.onModelSelect({ provider: event.model.provider, id: event.model.id });
	});

	pi.on("session_shutdown", (_event, _ctx) => {
		// Cancel the timer and drop in-memory state, but leave the persisted
		// entry so the recovery can re-arm on the next start.
		router?.shutdown();
		router = null;
		lastProcessedHaltId = null;
	});
}
