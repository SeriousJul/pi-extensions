/**
 * Output-starvation guard wiring (ADR 0028).
 *
 * This file is thin pi wiring around the pure guard core (guard.ts). The
 * guard owns the request and nothing else: it reads the payload pi has
 * already built in the before_provider_request event and judges two states
 * of that payload's output budget against the Effective window.
 *
 * When the payload's budget is pi's saturated floor - the context is
 * estimated over-full for the window - the request is Output starved, and
 * the guard refuses it. The refusal is one report line and the run's abort,
 * because that is the loudest refusal the hook can express: pi's
 * before_provider_request handler may inspect and replace the payload, and
 * it cannot stop the request (pi's extension runner swallows a thrown
 * handler and sends the last good payload). The abort kills the request on
 * the already-aborted signal before any byte leaves the process - the
 * provider is never contacted - the turn ends as an abort instead of a
 * one-token answer, and pi never retries an abort.
 *
 * When the payload's budget is more than the room the Corrected estimate
 * leaves in the window, the request is Output overrun, and the guard fits
 * it: it returns the payload with its budget lowered to the room the
 * estimate leaves, and the request goes out and gets answered instead of
 * being rejected by the provider. A Fit never raises a budget (ADR 0028),
 * and when the room left cannot hold any real answer the guard refuses
 * instead, so the operator is never charged for a one-token non-answer.
 *
 * Budget of the guard itself (user stories 8, 9): at most one refusal per
 * turn, and at most one fit notice per turn. A Fit is not a refusal, so it
 * applies to every request in the turn - a retry must not go out with the
 * budget that just failed - while the notice stays at one line. Both flags
 * reset on every turn_start and on session_start, and nothing survives a
 * model selection. The guard reads a payload that already exists and adds
 * no per-turn network call.
 *
 * The guard never takes over window ownership from Llama refresh: it reads
 * the Effective window for its lines and changes nothing about it. It
 * registers no compaction hook, so it cannot stand in the way of the
 * compaction a fitted request lets pi's own threshold reach.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { modelKey, readReserveTokens } from "../shared/settings.ts";
import {
	decide,
	estimateProjectionTokens,
	fitLine,
	reportedContextTokens,
	reserveDisagreementLine,
	starvationLine,
	PI_OUTPUT_FLOOR,
	type GuardSettings,
} from "./guard.ts";
import { envDisabled, readOutputStarvationSettings, type OutputStarvationSettings } from "./settings.ts";

/** What the session projection says about the request about to go out: the
 * Reported context the provider counted for its last answer, and pi's own
 * estimate, which the guard degrades to when the payload carries nothing
 * it can read. A dead projection yields neither: the trigger is the
 * payload, never the estimate. */
function readProjection(ctx: ExtensionContext): { reportedContext: number | null; projectionEstimate: number } {
	try {
		// The projection is pi-agent-core's AgentMessage[]; the mirror reads
		// the same array at runtime (it is what pi's clamp reads), so one
		// type bridge stands at the package boundary.
		const messages = ctx.sessionManager.buildSessionProjection().messages as unknown as readonly Message[];
		return { reportedContext: reportedContextTokens(messages), projectionEstimate: estimateProjectionTokens(messages) };
	} catch {
		return { reportedContext: null, projectionEstimate: 0 };
	}
}

export default function (pi: ExtensionAPI): void {
	// The per-turn budget: at most one refusal per turn, and at most one fit
	// notice per turn. Reset on every turn start, and on a session start so
	// a replacement session never inherits them.
	let refusedThisTurn = false;
	let notifiedThisTurn = false;
	/** The reserve disagreement is named once per session. */
	let reserveNoticed = false;
	/** The settings section, read once per session and re-read on reload. */
	let settings: OutputStarvationSettings | undefined;

	function loadSettings(ctx: ExtensionContext): OutputStarvationSettings {
		const { settings: read, errors } = readOutputStarvationSettings(ctx.cwd || process.cwd());
		settings = read;
		for (const error of errors) {
			try {
				ctx.ui.notify(`output starvation: ${error}`, "error");
			} catch {
				// A dead UI must not stop the guard from working.
			}
		}
		return read;
	}

	function settingsOf(ctx: ExtensionContext): OutputStarvationSettings {
		return settings ?? loadSettings(ctx);
	}

	/** Name the settings disagreement that lets pi's own threshold permit a
	 * prompt the provider must reject: a compaction reserve below the
	 * model's output ceiling. It changes nothing (out of scope). */
	function noticeReserveDisagreement(ctx: ExtensionContext): void {
		if (reserveNoticed) return;
		const model = ctx.model;
		const ceiling = model?.maxTokens;
		if (!model?.id || !model.provider || typeof ceiling !== "number" || !(ceiling > 0)) return;
		const reserve = readReserveTokens(ctx.cwd || process.cwd(), process.env, modelKey(model));
		if (reserve >= ceiling) return;
		reserveNoticed = true;
		try {
			ctx.ui.notify(reserveDisagreementLine({ provider: model.provider, modelId: model.id, reserve, ceiling }), "warning");
		} catch {
			// A dead UI loses the notice; the guard still judges requests.
		}
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		refusedThisTurn = false;
		notifiedThisTurn = false;
		reserveNoticed = false;
		settings = undefined;
		settingsOf(ctx);
		noticeReserveDisagreement(ctx);
	});
	pi.on("turn_start", () => {
		refusedThisTurn = false;
		notifiedThisTurn = false;
	});
	// A model selection changes the window, the output ceiling, and the
	// reserve that applies, so nothing from the old model survives it.
	pi.on("model_select", (_event, ctx: ExtensionContext) => {
		refusedThisTurn = false;
		notifiedThisTurn = false;
		settings = undefined;
		noticeReserveDisagreement(ctx);
	});

	pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
		const current = settingsOf(ctx);
		if (!current.enabled || envDisabled()) return;
		const guardSettings: GuardSettings = {
			inflation: current.inflation,
			bytesPerChar: current.bytesPerChar,
			safetyMargin: current.safetyMargin,
			minAnswerTokens: current.minAnswerTokens,
		};
		const projection = readProjection(ctx);
		const decision = decide({
			payload: event.payload,
			window: ctx.model?.contextWindow ?? 0,
			reportedContext: projection.reportedContext,
			projectionEstimate: projection.projectionEstimate,
			settings: guardSettings,
		});
		const facts = {
			provider: ctx.model?.provider ?? "unknown",
			modelId: ctx.model?.id ?? "unknown",
			window: ctx.model?.contextWindow ?? 0,
			estimate: decision.estimate,
			budget: decision.budget ?? PI_OUTPUT_FLOOR,
		};

		if (decision.outcome === "fit") {
			// The Fit applies to every request in the turn; the notice does
			// not, so a tight session does not fill the transcript.
			if (!notifiedThisTurn) {
				notifiedThisTurn = true;
				try {
					ctx.ui.notify(fitLine({ ...facts, fitted: decision.fitted ?? decision.budget ?? PI_OUTPUT_FLOOR }), "info");
				} catch {
					// A dead UI loses the line; the Fit still goes out.
				}
			}
			return decision.payload;
		}

		if (decision.outcome === "starved" || decision.outcome === "overrun") {
			if (refusedThisTurn) return;
			refusedThisTurn = true;
			// Both refusals read the same line: the collapsed budget and the
			// overrun whose room cannot hold an answer are refused the same way,
			// and the figures they name tell them apart.
			try {
				ctx.ui.notify(starvationLine(facts), "error");
			} catch {
				// A dead UI must not swallow the refusal: the abort below is
				// what makes the turn end as a failure.
			}
			// The hook cannot stop the request; the abort is the refusal.
			try {
				ctx.abort();
			} catch {
				// No run in flight: nothing to refuse, nothing to do.
			}
			return;
		}
	});
}
