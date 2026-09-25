/**
 * context-cap extension entrypoint.
 *
 * Caps the session's effective context window so auto-compaction fires early.
 * pi has no cap concept: the window is whatever the active model reports. The
 * cap is therefore applied where models are resolved (ADR 0004): on session
 * start, every provider with a model above the cap is re-registered through
 * pi.registerProvider with capped copies of its full model list, and the
 * already-resolved model objects (the active model, models cycled to later)
 * are clamped in place.
 *
 * The cap value comes from --context-window or PI_CONTEXT_WINDOW (flag wins).
 * It is read in session_start, not at load time: pi fills extension flag
 * values after extensions load, so a top-level read would only see defaults.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cappedModelConfigs, clampModelWindow, parseCap } from "./cap";
import { readReserveTokens } from "./settings";
import { modelKey as piModelKey } from "../shared/settings.ts";

const FLAG_NAME = "context-window";
const ENV_VAR = "PI_CONTEXT_WINDOW";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		type: "string",
		description: "Cap the context window in tokens for this session",
	});

	let activeCap: number | undefined;

	pi.on("session_start", (event, ctx) => {
		const flagValue = pi.getFlag(FLAG_NAME);
		const raw = typeof flagValue === "string" && flagValue.length > 0 ? flagValue : process.env[ENV_VAR];
		if (raw === undefined) {
			activeCap = undefined;
			return;
		}
		const parsed = parseCap(raw);
		if (!parsed.ok) {
			ctx.ui.notify(`context-cap: ${parsed.error}; cap not applied`, "error");
			return;
		}
		// The reserve is resolved for the model this session is on, because that
		// is how pi resolves it, and this figure is the floor the cap must clear.
		const reserveTokens = readReserveTokens(ctx.cwd, process.env, piModelKey(ctx.model));
		if (parsed.cap <= reserveTokens) {
			ctx.ui.notify(
				`context-cap: cap ${parsed.cap} must be greater than compaction.reserveTokens (${reserveTokens}); cap not applied`,
				"error",
			);
			return;
		}
		activeCap = parsed.cap;
		const allModels = ctx.modelRegistry.getAll();
		for (const [provider, models] of cappedModelConfigs(allModels, activeCap)) {
			const originals = allModels.filter((model) => model.provider === provider);
			if (!originals.some((model) => ctx.modelRegistry.hasConfiguredAuth(model))) continue;
			pi.registerProvider(provider, { models });
		}
		clampModelWindow(ctx.model, activeCap);
		if (event.reason === "startup") {
			ctx.ui.notify(`Context window capped at ${activeCap} tokens`, "info");
		}
	});

	pi.on("model_select", (event) => {
		if (activeCap !== undefined) clampModelWindow(event.model, activeCap);
	});
}
