/**
 * Vitest setup file: pins the capture environment before any test file
 * loads a pi module.
 *
 * This suite runs with isolate: false in one fork, so module state is
 * shared across test files. pi's Theme.bold renders through chalk, and
 * chalk fixes its color level at first load; if another test file loads
 * pi-coding-agent before the golden test's look.mjs pins run, bold text
 * renders at the ambient level (none on CI) and the tools and resources
 * re-renders drift from the committed goldens. Importing look.mjs here
 * applies the same pins the capture pipeline uses (TZ, FORCE_COLOR,
 * COLORTERM) before the first test file evaluates.
 */
import "../../scripts/screenshots/look.mjs";
