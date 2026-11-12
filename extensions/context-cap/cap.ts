import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type CapParse = { ok: true; cap: number } | { ok: false; error: string };

/**
 * The chat-model member of pi's ProviderModelConfig.
 *
 * pi's public model-config union also covers image and classifier models,
 * which carry no contextWindow, reasoning, or samplingParams. A capped
 * registry model is always a chat model, so the replacement definitions are
 * narrowed to that member.
 */
export type CappedModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

/** Parse a cap value from the --context-window flag or PI_CONTEXT_WINDOW env var. */
export function parseCap(raw: string): CapParse {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
		return { ok: false, error: `"${raw}" is not a positive integer` };
	}
	return { ok: true, cap: Number(trimmed) };
}

/**
 * Group models by provider and build capped replacement model lists.
 *
 * A provider appears only when at least one of its models exceeds the cap.
 * When it appears, ALL of its models are included: pi replaces the whole
 * provider model list on re-registration, so a partial list would drop models.
 */
export function cappedModelConfigs(models: readonly Model<Api>[], cap: number): Map<string, CappedModelConfig[]> {
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider);
		if (list) {
			list.push(model);
		} else {
			byProvider.set(model.provider, [model]);
		}
	}
	const out = new Map<string, CappedModelConfig[]>();
	for (const [provider, list] of byProvider) {
		if (!list.some((model) => model.contextWindow > cap)) continue;
		out.set(provider, list.map((model) => toModelConfig(model, cap)));
	}
	return out;
}

/**
 * Copy a registry model into a re-registration definition with the capped
 * window. Every field is carried over: pi drops model-level details that a
 * replacement definition does not name, and model headers are re-attached at
 * request time only from the definition.
 */
export function toModelConfig(model: Model<Api>, cap: number): CappedModelConfig {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: Math.min(cap, model.contextWindow),
		maxTokens: model.maxTokens,
		samplingParams: model.samplingParams,
		headers: model.headers,
		compat: model.compat,
	};
}

/**
 * Clamp an already-resolved model object in place.
 *
 * The session stores the model object it resolved at construction time; no
 * supported API rewrites its window without appending a model_change entry to
 * the transcript. The object is plain data: pi reads contextWindow only for
 * compaction timing, overflow detection, and display, and the provider never
 * sends it.
 */
export function clampModelWindow(model: Model<Api> | undefined, cap: number): boolean {
	if (!model || model.contextWindow <= cap) return false;
	model.contextWindow = cap;
	return true;
}

/**
 * The session's active Context window cap (ADR 0004, amended by ADR 0027).
 * The record moved here from extensions/shared/context-window-cap.ts by
 * ADR 0048, when the llama-refresh extension that read it was dropped and
 * context-cap became its only owner.
 *
 * The state still sits under a Symbol.for global, the same pattern as the
 * status line: pi's extension discovery can load a second copy of the
 * extension, and the boundary handlers in index.ts must see the cap the
 * session_start handler resolved. A session with no cap reads undefined, and
 * no clamp applies.
 */
type CapState = {
	/** The active cap in tokens, or undefined when no cap applies. */
	cap: number | undefined;
};

const CAP_STATE_KEY = Symbol.for("pi-extensions/context-window-cap");

function capState(): CapState {
	const global = globalThis as Record<symbol, CapState | undefined>;
	if (!global[CAP_STATE_KEY]) global[CAP_STATE_KEY] = { cap: undefined };
	return global[CAP_STATE_KEY]!;
}

/** Publish the active cap, or clear it (undefined). */
export function setActiveWindowCap(cap: number | undefined): void {
	capState().cap = cap;
}

/** The active cap, or undefined when no cap applies. */
export function getActiveWindowCap(): number | undefined {
	return capState().cap;
}

/** Clear the published cap. For tests. */
export function resetActiveWindowCap(): void {
	capState().cap = undefined;
}
