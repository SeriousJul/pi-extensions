/**
 * Output-starvation guard wiring (ADR 0028).
 *
 * This file is thin pi wiring around the pure guard core (guard.ts). The
 * guard owns the request and nothing else: it reads the payload pi has
 * already built in the before_provider_request event, and when the
 * payload's output budget is pi's saturated floor - the context is
 * estimated over-full for the Effective window - it refuses the request
 * instead of letting it out.
 *
 * The refusal is one report line and the run's own abort, because that is
 * the loudest refusal the hook can express: pi's before_provider_request
 * handler may inspect and replace the payload, and it cannot stop the
 * request (pi's extension runner swallows a thrown handler and sends the
 * last good payload). The abort kills the request on the already-aborted
 * signal before any byte leaves the process - the provider is never
 * contacted - the turn ends as an abort instead of a one-token answer, and
 * pi never retries an abort. Raising the budget upward is refused by
 * design: it would trade the garbage turn for a provider error the user
 * cannot read (ADR 0028).
 *
 * Budget of the guard itself (user story 5): at most one refusal per turn.
 * The flag resets on every turn_start, so a refusal can never become a
 * retry storm, and nothing survives a model selection. The guard reads a
 * payload that already exists and adds no per-turn network call.
 *
 * The guard never takes over window ownership from Llama refresh: it reads
 * the Effective window for the report line and changes nothing about it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { budgetOf, estimateProjectionTokens, isStarved, PI_OUTPUT_FLOOR, starvationLine } from "./guard.ts";

/** pi's own estimate of the context this request would carry: the mirror
 * of pi-ai's estimator over the same projected messages pi's clamp reads,
 * so the line names the figure that collapsed the budget. A failure
 * degrades to 0: the trigger is the payload, never the estimate. */
function contextEstimate(ctx: ExtensionContext): number {
	try {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		// The projection is pi-agent-core's AgentMessage[]; the mirror reads
		// the same array at runtime (it is what pi's clamp reads), so one
		// type bridge stands at the package boundary.
		return estimateProjectionTokens(messages as unknown as readonly Message[]);
	} catch {
		return 0;
	}
}

export default function (pi: ExtensionAPI): void {
	// The per-turn refusal budget: at most one refusal per turn. Reset on
	// every turn start, and on a session start so a replacement session
	// never inherits the flag.
	let refusedThisTurn = false;
	pi.on("session_start", () => {
		refusedThisTurn = false;
	});
	pi.on("turn_start", () => {
		refusedThisTurn = false;
	});

	pi.on("before_provider_request", (event, ctx: ExtensionContext) => {
		if (refusedThisTurn) return;
		if (!isStarved(event.payload)) return;
		refusedThisTurn = true;
		const facts = {
			provider: ctx.model?.provider ?? "unknown",
			modelId: ctx.model?.id ?? "unknown",
			window: ctx.model?.contextWindow ?? 0,
			estimate: contextEstimate(ctx),
			budget: budgetOf(event.payload) ?? PI_OUTPUT_FLOOR,
		};
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
	});
}
