/**
 * The shared token math.
 *
 * Three extensions in this repo convert a character count into a token
 * estimate, and they all mean the same figure: pi's own chars/4 estimate
 * times the Inflation factor. Output limits bounds a tool result with it,
 * Safe branch summary budgets a summary request with it, and the
 * output-starvation guard estimates the part of a request the provider has
 * not counted with it. Each of them used to carry its own copy of the
 * formula and of the two figures inside it, which is how two extensions end
 * up disagreeing about one number. This module is the one owner, the way
 * `shared/settings.ts` is the one owner of the settings-file plumbing.
 *
 * Nothing here imports pi. The figures are pi's, pinned here and pinned
 * again against pi's own code in the tests that read them.
 */

/**
 * pi's own characters-per-token rate: `CHARS_PER_TOKEN` in pi-ai's estimator
 * (pi 0.87.1), the rate pi's output clamp and compaction threshold both
 * estimate at. It is a character count, not a byte count, but the repo names
 * the setting `bytesPerChar` the way Output limits and Safe branch summary
 * already do, and for ASCII the two are the same figure.
 */
export const PI_CHARS_PER_TOKEN = 4;

/**
 * The charge for one image block. pi counts an image as 4800 characters in
 * its own estimate (`ESTIMATED_IMAGE_CHARS` in pi-ai's estimator and
 * `core/compaction/compaction.ts`); the extensions charge the same figure in
 * bytes so they keep pi's scale and pick up the Inflation correction.
 */
export const PI_IMAGE_CHARGE_BYTES = 4800;

/** The two knobs of the character-to-token estimate. */
export interface TokenMath {
	/** The characters per token pi's own estimate assumes. */
	bytesPerChar: number;
	/** The Inflation factor on pi's chars/4 estimate. */
	inflation: number;
}

/**
 * Characters to tokens: pi's chars/4 estimate times the Inflation factor.
 * The correction catches multi-byte text, where pi's estimate runs three to
 * four times low, and code by about 18 percent (ADR 0026).
 */
export function tokensFromBytes(chars: number, math: TokenMath): number {
	if (chars <= 0) return 0;
	return Math.ceil((chars * math.inflation) / math.bytesPerChar);
}

/**
 * Tokens to characters: the inverse of `tokensFromBytes`, rounded down so an
 * estimate never says a cut fits when it does not.
 */
export function bytesFromTokens(tokens: number, math: TokenMath): number {
	if (tokens <= 0) return 0;
	return Math.floor((tokens * math.bytesPerChar) / math.inflation);
}
