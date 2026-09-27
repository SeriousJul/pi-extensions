/**
 * context-cap extension entrypoint.
 *
 * Caps the session's effective context window so auto-compaction fires early.
 * pi has no cap concept: the window is whatever the active model reports. The
 * cap is therefore applied where models are resolved (ADR 0004, amended by
 * ADR 0027):
 *
 * - Static providers (pi never re-fetches their model list): on session start,
 *   every provider with a model above the cap is re-registered through
 *   pi.registerProvider with capped copies of its full model list, so the cap
 *   is the value pi resolves everywhere.
 * - Dynamic providers (llama.cpp: pi re-fetches the model list from the
 *   server during the session): re-registration is skipped, because pi's
 *   composer replaces the live list with the static one and the window would
 *   stop moving in either direction - and a live window that shrinks below
 *   the cap would leave the session believing in more context than the
 *   server has. The cap is enforced on the session's model alone: the model
 *   object is clamped in place at every boundary the window is consumed.
 *
 * The cap value comes from --context-window or PI_CONTEXT_WINDOW (flag wins).
 * It is read in session_start, not at load time: pi fills extension flag
 * values after extensions load, so a top-level read would only see defaults.
 * The resolved value is published to the shared record in
 * extensions/shared/context-window-cap.ts: the llama refresh compare clamps
 * both sides of its registry-to-registry compare to that value, so a cap
 * that hides a drift (the live window stays above the cap) moves nothing
 * and says nothing instead of re-applying a window the cap clamps back.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cappedModelConfigs, clampModelWindow, parseCap } from "./cap";
import { readReserveTokens } from "./settings";
import { modelKey as piModelKey } from "../shared/settings.ts";
import { getActiveWindowCap, setActiveWindowCap } from "../shared/context-window-cap.ts";

const FLAG_NAME = "context-window";
const ENV_VAR = "PI_CONTEXT_WINDOW";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		type: "string",
		description: "Cap the context window in tokens for this session",
	});

	const clampActive = (ctx: ExtensionContext): void => {
		// The clamp is in place, not a replacement, because pi resolves the
		// session's model to the same object the registry returns (the model
		// runtime hands out its provider list's own model objects to both):
		// clamping ctx.model clamps the value every reader of the registry -
		// including the llama refresh compare - sees.
		const cap = getActiveWindowCap();
		if (cap !== undefined) clampModelWindow(ctx.model, cap);
	};

	pi.on("session_start", (event, ctx) => {
		const flagValue = pi.getFlag(FLAG_NAME);
		const raw = typeof flagValue === "string" && flagValue.length > 0 ? flagValue : process.env[ENV_VAR];
		if (raw === undefined) {
			setActiveWindowCap(undefined);
			return;
		}
		const parsed = parseCap(raw);
		if (!parsed.ok) {
			setActiveWindowCap(undefined);
			ctx.ui.notify(`context-cap: ${parsed.error}; cap not applied`, "error");
			return;
		}
		// The reserve is resolved for the model this session is on, because that
		// is how pi resolves it, and this figure is the floor the cap must clear.
		const reserveTokens = readReserveTokens(ctx.cwd, process.env, piModelKey(ctx.model));
		if (parsed.cap <= reserveTokens) {
			setActiveWindowCap(undefined);
			ctx.ui.notify(
				`context-cap: cap ${parsed.cap} must be greater than compaction.reserveTokens (${reserveTokens}); cap not applied`,
				"error",
			);
			return;
		}
		// Publish the active cap: the llama refresh compare clamps both sides
		// of its compare to it, so a cap that hides a drift moves nothing and
		// says nothing. Cleared on every path where no cap applies, above.
		setActiveWindowCap(parsed.cap);
		const allModels = ctx.modelRegistry.getAll();
		for (const [provider, models] of cappedModelConfigs(allModels, parsed.cap)) {
			const originals = allModels.filter((model) => model.provider === provider);
			if (!originals.some((model) => ctx.modelRegistry.hasConfiguredAuth(model))) continue;
			// A dynamic provider re-fetches its model list from the server
			// during the session, and pi's composer replaces the live list
			// with a static re-registration. Freezing that list stops the
			// window moving in either direction, and leaves the session
			// believing in more context than the server has whenever the live
			// window shrinks below the cap. For dynamic providers the
			// boundary clamps below are the whole enforcement.
			if (typeof ctx.modelRegistry.getProvider(provider)?.refreshModels === "function") continue;
			pi.registerProvider(provider, { models });
		}
		clampModelWindow(ctx.model, parsed.cap);
		if (event.reason === "startup") {
			ctx.ui.notify(`Context window capped at ${parsed.cap} tokens`, "info");
		}
	});

	pi.on("model_select", (event) => {
		const cap = getActiveWindowCap();
		if (cap !== undefined) clampModelWindow(event.model, cap);
	});

	// The session's model is clamped at every boundary the window is
	// consumed - before a run starts, before each request is built, at each
	// turn end, and when the run settles - so an extension that re-applies a
	// model mid-session (the llama refresh heal) cannot widen it past the
	// cap. When llama refresh loads before this extension, the turn_start
	// clamp lands after its pre-request re-apply, so the request is built
	// capped; with the reverse order one request per heal may see the
	// uncapped window before the next clamp.
	pi.on("before_agent_start", (_event, ctx) => clampActive(ctx));
	pi.on("turn_start", (_event, ctx) => clampActive(ctx));
	pi.on("turn_end", (_event, ctx) => clampActive(ctx));
	pi.on("agent_settled", (_event, ctx) => clampActive(ctx));
}
