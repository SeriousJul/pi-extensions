import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export type CapParse = { ok: true; cap: number } | { ok: false; error: string };

/**
 * ProviderModelConfig plus samplingParams. The installed pi type omits the
 * field, but pi's composer spreads the whole definition object into the new
 * model, so the value survives re-registration at runtime. Without it, base
 * per-model sampling defaults would be lost on capping.
 */
export type CappedModelConfig = ProviderModelConfig & { samplingParams?: Record<string, unknown> };

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
