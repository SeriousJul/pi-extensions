/**
 * The shared record of the active Context window cap (ADR 0004, amended by
 * ADR 0027).
 *
 * Two extensions care about one cap value: context-cap enforces it by
 * clamping the session's model in place at every boundary the window is
 * consumed, and llama-refresh reads it so its compare can tell a drift the
 * cap hides (the live window stays above the cap) from a drift that moves
 * the session's clamped window. Pi loads every extension of one process
 * into one runtime, but pi has no cross-extension message channel, so the
 * value lives here: context-cap publishes the cap it resolved in
 * session_start (clearing it when no cap applies), and llama-refresh reads
 * it at each compare - always after every session_start handler of the
 * session has run. The state sits under a Symbol.for global, the same
 * pattern as the status line, so a double-loaded copy of this module (pi's
 * extension discovery can load a second copy) still sees the cap. A session
 * with no cap reads undefined, and the compare then treats every window as
 * uncapped, exactly the behavior before this record existed.
 */

type CapState = {
	/** The active cap in tokens, or undefined when no cap applies. */
	cap: number | undefined;
};

const STATE_KEY = Symbol.for("pi-extensions/context-window-cap");

function state(): CapState {
	const global = globalThis as Record<symbol, CapState | undefined>;
	if (!global[STATE_KEY]) global[STATE_KEY] = { cap: undefined };
	return global[STATE_KEY]!;
}

/** The context-cap extension: publish the active cap, or clear it (undefined). */
export function setActiveWindowCap(cap: number | undefined): void {
	state().cap = cap;
}

/** The llama-refresh core: the active cap, or undefined when no cap applies. */
export function getActiveWindowCap(): number | undefined {
	return state().cap;
}

/** Clear the published cap. For tests. */
export function resetActiveWindowCap(): void {
	state().cap = undefined;
}
