/**
 * Settings for the context-cap extension.
 *
 * The only figure it reads of pi's is `compaction.reserveTokens`, and that
 * read is the shared one in `extensions/shared/settings.ts`: project
 * `<cwd>/.pi/settings.json` over global `<agentDir>/settings.json`, over pi's
 * built-in default. This module keeps the name the extension imports and
 * re-exports the default it reports, so the precedence rule lives in one file
 * for every extension that needs it.
 */
export { DEFAULT_RESERVE_TOKENS, readReserveTokens } from "../shared/settings.ts";
