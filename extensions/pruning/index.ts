/**
 * Pruning extension: two-level context control.
 *
 * This file is thin pi wiring around the pure prune core (`core.ts`), the
 * pure prune gate (`gate.ts`), the recall tool (`recall.ts`), and the
 * settings reader (`settings.ts`).
 *
 * First level: the `context` hook re-derives the pruned view on every
 * request while the context estimate exceeds pi's own compaction threshold
 * (window minus reserveTokens). Large tool outputs become short markers
 * carrying a recall reference; the session file keeps the full outputs and
 * is never modified (ADR 0011). Nothing is persisted: the projection is a
 * pure function of the current messages and thresholds.
 *
 * Second level: the `session_before_compact` hook. When pi is about to
 * compact on the threshold, the prune gate cancels the compaction exactly
 * when the pruned estimate reaches the window minus twice reserveTokens.
 * Manual and overflow compactions always pass, and when auto-compaction
 * is off the gate simply never fires while the context hook keeps pruning
 * on its own switch.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens, estimateTokens, sessionEntryToContextMessages, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { prune, type PruneInput, type PruneSettings } from "./core.ts";
import { nextEngagement } from "./engagement.ts";
import { pruneGate, type GateDecision } from "./gate.ts";
import { createRecallTool } from "./recall.ts";
import { readPruningSettings, readReserveTokens, writePruningSettings, type PruningSettings } from "./settings.ts";
import { modelKey as piModelKey } from "../shared/settings.ts";

interface PruneStats {
	outputs: number;
	tokensSaved: number;
}

interface GateLog {
	decision: GateDecision;
	reason: string;
	tokensBefore: number;
}

interface PruningState {
	settings: PruningSettings;
	reserveTokens: number;
	/** True once the first-activation notification went out. */
	firstActivationNotified: boolean;
	/** The sticky engaged state (ADR 0018): true once the estimate has crossed
	 * the threshold, held until a reset event, so the prefix keeps one shape. */
	engaged: boolean;
	/** True after a compaction ran, until the next request consumes it: a reset
	 * event that clears the sticky engagement. */
	resetPending: boolean;
	/** The last prune pass that replaced outputs, for the state line. */
	lastPrune: PruneStats | null;
	/** The last gate decision, for the state line. */
	lastGate: GateLog | null;
}

let state: PruningState | null = null;
let activeCtx: ExtensionContext | null = null;

/** The usage-backed context estimate, mirroring pi's own helper: the last
 * valid assistant usage plus the character estimate of the messages after
 * it, or the full character estimate when no usage exists. Sizes agree
 * with pi's compaction and footer accounting (user story 13). */
function estimateContextTokens(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role !== "assistant" || !("usage" in message)) continue;
		const assistant = message;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		if (!assistant.usage || calculateContextTokens(assistant.usage) === 0) continue;
		let trailing = 0;
		for (let j = i + 1; j < messages.length; j += 1) trailing += estimateTokens(messages[j]);
		return calculateContextTokens(assistant.usage) + trailing;
	}
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/** The current message list pi's own context builder projects from the
 * branch entries (compaction-aware). */
function currentMessages(sm: ExtensionContext["sessionManager"]): AgentMessage[] {
	return sm.buildContextEntries().flatMap((entry) => sessionEntryToContextMessages(entry));
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(Math.round(tokens));
}

/** The recall reference for one entry: the physical line of the session
 * file, or the entry id when the session is ephemeral. */
function makeReferenceFor(sm: ExtensionContext["sessionManager"]): (entry: SessionEntry) => string {
	if (sm.getSessionFile() === undefined) return (entry) => entry.id;
	// Line 1 is the session header; getEntries() is the file order.
	const lineById = new Map<string, number>();
	for (const [i, entry] of sm.getEntries().entries()) lineById.set(entry.id, i + 2);
	return (entry) => {
		const line = lineById.get(entry.id);
		return line !== undefined ? `#${line}` : entry.id;
	};
}

function pruneInput(ctx: ExtensionContext, messages: AgentMessage[], entries: SessionEntry[], contextWindow: number, reserveTokens: number, settings: PruneSettings): PruneInput {
	return {
		messages,
		entries,
		contextWindow,
		reserveTokens,
		settings,
		referenceFor: makeReferenceFor(ctx.sessionManager),
		estimateList: estimateContextTokens,
	};
}

function stateLine(): string {
	const s = state;
	const pruned = s?.lastPrune
		? `${s.lastPrune.outputs} output${s.lastPrune.outputs === 1 ? "" : "s"} pruned, ~${formatTokens(s.lastPrune.tokensSaved)} tokens saved per request`
		: "no outputs pruned yet";
	const gate = s?.lastGate
		? `last gate: ${s.lastGate.decision.cancel ? "cancel (pruning won)" : "pass (compaction ran)"}, ${formatTokens(s.lastGate.tokensBefore)} tokens before (threshold ${formatTokens(s.lastGate.decision.threshold)})`
		: "last gate: none";
	return `state: ${pruned}; ${gate}`;
}

function showSettings(ctx: ExtensionContext): void {
	const settings = state?.settings ?? readPruningSettings(ctx.cwd).settings;
	ctx.ui.notify(
		`pruning: enabled=${settings.enabled}, minResultTokens=${settings.minResultTokens}, protectCurrentTurn=${settings.protectCurrentTurn}\n${stateLine()}`,
		"info",
	);
}

/** Apply one key=value pair to the settings. Returns an error string, or
 * undefined when the pair parsed and was applied. */
function parseSettingPair(kv: string, patch: Partial<PruningSettings>): string | undefined {
	const eq = kv.indexOf("=");
	if (eq <= 0) return `invalid setting: ${kv} (expected key=value)`;
	const key = kv.slice(0, eq);
	const value = kv.slice(eq + 1);
	switch (key) {
		case "enabled":
			if (value === "true") patch.enabled = true;
			else if (value === "false") patch.enabled = false;
			else return `pruning.enabled must be true or false, got: ${value}`;
			return;
		case "protectCurrentTurn":
			if (value === "true") patch.protectCurrentTurn = true;
			else if (value === "false") patch.protectCurrentTurn = false;
			else return `pruning.protectCurrentTurn must be true or false, got: ${value}`;
			return;
		case "minResultTokens": {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) return `pruning.minResultTokens must be a positive integer, got: ${value}`;
			patch.minResultTokens = n;
			return;
		}
		default:
			return `unknown pruning setting: ${key} (expected enabled, minResultTokens, or protectCurrentTurn)`;
	}
}

/** Persist one settings change and refresh the session state. */
function applySettings(ctx: ExtensionContext, patch: Partial<PruningSettings>): void {
	const result = writePruningSettings(ctx.cwd, patch);
	if (!result.ok) {
		ctx.ui.notify(`pruning: ${result.error}`, "error");
		return;
	}
	if (state) state.settings = result.settings;
	ctx.ui.notify(
		`pruning: enabled=${result.settings.enabled}, minResultTokens=${result.settings.minResultTokens}, protectCurrentTurn=${result.settings.protectCurrentTurn} (saved to ${result.path})`,
		"info",
	);
}

export default function pruningExtension(pi: ExtensionAPI): void {
	pi.registerTool(createRecallTool());

	pi.on("session_start", (_event, ctx) => {
		const { settings, errors } = readPruningSettings(ctx.cwd);
		for (const error of errors) ctx.ui.notify(`pruning: ${error}`, "error");
		state = {
			settings,
			// pi resolves its reserve per model, and Pruning's threshold is that
			// reserve: reading it for the live model is what keeps the gate on the
			// same edge pi compacts at.
			reserveTokens: readReserveTokens(ctx.cwd, process.env, piModelKey(ctx.model)),
			firstActivationNotified: false,
			engaged: false,
			resetPending: false,
			lastPrune: null,
			lastGate: null,
		};
		activeCtx = ctx;
	});

	pi.on("session_shutdown", () => {
		state = null;
		activeCtx = null;
	});

	// First level: re-derive the pruned view on every request. Engagement is
	// sticky for the session (ADR 0018): once the estimate has crossed the
	// threshold, keep pruning until a reset, so the outgoing prefix holds one
	// shape and the provider's prompt cache stays hot. A request that does not
	// engage goes out unchanged.
	pi.on("context", (event) => {
		const s = state;
		const ctx = activeCtx;
		if (!s || !ctx || !s.settings.enabled || !ctx.model) return;
		const engaged = nextEngagement({
			engaged: s.engaged,
			estimate: estimateContextTokens(event.messages),
			threshold: ctx.model.contextWindow - s.reserveTokens,
			reset: s.resetPending,
		});
		s.engaged = engaged;
		s.resetPending = false;
		if (!engaged) return;
		const result = prune({
			...pruneInput(ctx, event.messages, ctx.sessionManager.buildContextEntries(), ctx.model.contextWindow, s.reserveTokens, s.settings),
			engage: true,
		});
		if (result.prunedCount === 0) return;
		s.lastPrune = { outputs: result.prunedCount, tokensSaved: result.savingsTokens };
		if (!s.firstActivationNotified) {
			s.firstActivationNotified = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`pruning: first level active - ${result.prunedCount} tool output${result.prunedCount === 1 ? "" : "s"} replaced with references, ~${formatTokens(result.savingsTokens)} tokens saved per request`,
					"info",
				);
			}
		}
		return { messages: result.messages };
	});

	// Second level's gate: cancel a threshold compaction exactly when
	// pruning alone reaches the window minus twice reserveTokens. When a
	// compaction actually runs (the gate passes, or pruning is off so the gate
	// never fires), the raw size drops, so reset the sticky engagement and let
	// the session run raw again until it re-crosses the threshold.
	pi.on("session_before_compact", (event) => {
		const s = state;
		const ctx = activeCtx;
		if (!s || !ctx) return;
		if (s.settings.enabled && ctx.model) {
			const messages = currentMessages(ctx.sessionManager);
			const result = prune(
				pruneInput(ctx, messages, ctx.sessionManager.buildContextEntries(), ctx.model.contextWindow, s.reserveTokens, s.settings),
			);
			const decision = pruneGate({
				tokensBefore: event.preparation.tokensBefore,
				prunedSavings: result.savingsTokens,
				contextWindow: ctx.model.contextWindow,
				reserveTokens: s.reserveTokens,
				reason: event.reason,
			});
			s.lastGate = { decision, reason: event.reason, tokensBefore: event.preparation.tokensBefore };
			if (decision.cancel) return { cancel: true };
		}
		// A compaction runs: clear the sticky engagement on the next request.
		s.resetPending = true;
		return;
	});

	pi.registerCommand("pruning", {
		description:
			"Show or edit the pruning settings: /pruning settings [enabled=true|false minResultTokens=N protectCurrentTurn=true|false]",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "settings", label: "settings", description: "Show and edit the pruning keys" },
				{ value: "settings enabled=", label: "settings enabled=", description: "true|false" },
				{ value: "settings minResultTokens=", label: "settings minResultTokens=", description: "positive integer" },
				{ value: "settings protectCurrentTurn=", label: "settings protectCurrentTurn=", description: "true|false" },
			];
			const p = prefix.trim().toLowerCase();
			return p === "" ? items : items.filter((item) => item.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0 || parts[0] !== "settings") {
				ctx.ui.notify("pruning: usage: /pruning settings [key=value ...]", "error");
				return;
			}
			const pairs = parts.slice(1);
			if (pairs.length > 0) {
				const patch: Partial<PruningSettings> = {};
				for (const pair of pairs) {
					const error = parseSettingPair(pair, patch);
					if (error) {
						ctx.ui.notify(`pruning: ${error}`, "error");
						return;
					}
				}
				applySettings(ctx, patch);
				return;
			}
			showSettings(ctx);
			if (!ctx.hasUI) return;
			const key = await ctx.ui.select("Pruning setting to edit", ["enabled", "minResultTokens", "protectCurrentTurn"]);
			if (key === undefined) return;
			const settings = state?.settings ?? readPruningSettings(ctx.cwd).settings;
			const value = await ctx.ui.input(`pruning.${key} (current: ${String(settings[key as keyof PruningSettings])})`, String(settings[key as keyof PruningSettings]));
			if (value === undefined) return;
			const patch: Partial<PruningSettings> = {};
			const error = parseSettingPair(`${key}=${value.trim()}`, patch);
			if (error) {
				ctx.ui.notify(`pruning: ${error}`, "error");
				return;
			}
			applySettings(ctx, patch);
		},
	});
}
